/**
 * Fragt ein Passwort verdeckt (ohne Echo) im Terminal ab.
 *
 * Die Eingabe wird byteweise im Raw-Modus gelesen und landet ausschließlich in
 * einem Buffer – nie in einem JavaScript-String –, damit der Aufrufer sie nach
 * Gebrauch mit Nullen überschreiben kann.
 *
 * @param {string} question
 * @param {object} [io]
 * @param {import('node:tty').ReadStream} [io.input]
 * @param {NodeJS.WritableStream} [io.output]
 * @param {NodeJS.EventEmitter} [io.signals] Quelle für SIGINT/SIGTERM/SIGHUP (Standard: process)
 * @returns {Promise<Buffer>} UTF-8-Bytes; der Aufrufer muss sie mit `.fill(0)` nullen.
 */
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

export function promptHidden(question, { input = process.stdin, output = process.stderr, signals = process } = {}) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(
      Object.assign(new Error('Für die Eingabe des Master-Passworts wird ein interaktives Terminal benötigt'), { code: 'ENOTTY' }),
    );
  }

  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(64);
    let len = 0;
    let escState = 0; // 0 = normal, 1 = nach ESC, 2 = in CSI-Sequenz
    const wasRaw = input.isRaw === true;

    const grow = () => {
      const next = Buffer.alloc(buf.length * 2);
      buf.copy(next, 0, 0, len);
      buf.fill(0);
      buf = next;
    };

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      for (const sig of SIGNALS) signals.removeListener(sig, onSignal);
      signals.removeListener('exit', restoreTerminal);
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);
      restoreTerminal();
      input.pause();
    };

    function restoreTerminal() {
      try {
        input.setRawMode(wasRaw);
      } catch {
        // Terminal ist evtl. schon weg
      }
    }

    const finish = () => {
      if (cleaned) return;
      cleanup();
      output.write('\n');
      const result = Buffer.from(buf.subarray(0, len));
      buf.fill(0);
      resolve(result);
    };

    const abort = (message, code) => {
      if (cleaned) return;
      cleanup();
      output.write('\n');
      buf.fill(0);
      reject(Object.assign(new Error(message), { code }));
    };

    const onData = (chunk) => {
      if (typeof chunk === 'string') chunk = Buffer.from(chunk, 'utf8'); // falls jemand setEncoding() aufgerufen hat
      try {
        for (let i = 0; i < chunk.length; i++) {
          const b = chunk[i];
          // Escape-Sequenzen (Pfeiltasten, Bracketed Paste …) überspringen.
          if (escState === 1) {
            escState = b === 0x5b /* [ */ || b === 0x4f /* O */ ? 2 : 0;
            continue;
          }
          if (escState === 2) {
            if (b >= 0x40 && b <= 0x7e) escState = 0;
            continue;
          }
          switch (b) {
            case 0x0d: // Enter
            case 0x0a:
              return finish();
            case 0x03: // Ctrl-C
              return abort('Eingabe abgebrochen', 'ABORTED');
            case 0x04: // Ctrl-D
              if (len === 0) return abort('Eingabe abgebrochen', 'ABORTED');
              continue;
            case 0x7f: // Backspace
            case 0x08:
              // Letztes UTF-8-Zeichen (inkl. Folgebytes 10xxxxxx) entfernen.
              while (len > 0 && (buf[len - 1] & 0xc0) === 0x80) buf[--len] = 0;
              if (len > 0) buf[--len] = 0;
              continue;
            case 0x15: // Ctrl-U: Zeile löschen
              buf.fill(0, 0, len);
              len = 0;
              continue;
            case 0x1b:
              escState = 1;
              continue;
            default:
              if (b < 0x20) continue; // übrige Steuerzeichen ignorieren
              if (len === buf.length) grow();
              buf[len++] = b;
          }
        }
      } finally {
        chunk.fill(0);
      }
    };
    const onEnd = () => abort('Eingabe beendet, bevor ein Passwort eingegeben wurde', 'ABORTED');
    const onError = (err) => abort(`Fehler beim Lesen vom Terminal: ${err.message}`, 'EIO');
    // Signale von außen (kill, Terminal geschlossen) treffen den Prozess im Raw-Modus
    // trotzdem: Terminal wiederherstellen und sauber abbrechen.
    const onSignal = (sig) => abort(`Eingabe abgebrochen (${sig})`, 'ABORTED');
    for (const sig of SIGNALS) signals.on(sig, onSignal);
    // Letzte Absicherung bei unerwartetem Prozessende.
    signals.on('exit', restoreTerminal);

    output.write(question);
    input.setRawMode(true);
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
    input.resume();
  });
}
