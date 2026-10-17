import { randomBytes } from 'node:crypto';

/**
 * Hält ein Geheimnis ausschließlich im Arbeitsspeicher, XOR-maskiert mit einem
 * zufälligen Schlüssel. Das verhindert nicht jeden Zugriff (der Schlüssel liegt
 * im selben Prozess), sorgt aber dafür, dass das Geheimnis nicht im Klartext in
 * einem Heap-Dump oder Swap auftaucht, solange es nicht benutzt wird.
 *
 * Grenzen: Für jeden Request muss der Wert als JavaScript-String an Node's
 * HTTP-Client übergeben werden. Strings sind unveränderlich und können nicht
 * überschrieben werden; sie verschwinden erst, wenn der Garbage Collector den
 * Speicher wiederverwendet. Siehe README, Abschnitt „Grenzen“.
 */
export class SecretValue {
  #mask;
  #masked;

  /**
   * @param {Uint8Array} plain Klartext-Bytes. Werden NICHT verändert; der Aufrufer
   *   ist für das Nullen seiner eigenen Kopie verantwortlich.
   */
  constructor(plain) {
    this.#mask = randomBytes(plain.length);
    this.#masked = Buffer.alloc(plain.length);
    for (let i = 0; i < plain.length; i++) this.#masked[i] = plain[i] ^ this.#mask[i];
  }

  get length() {
    return this.#masked ? this.#masked.length : 0;
  }

  get disposed() {
    return this.#masked === null;
  }

  /** Gibt den Wert als (latin1-)String zurück. Der String ist nicht löschbar. */
  reveal() {
    if (this.#masked === null) throw new Error('Geheimnis wurde bereits verworfen');
    const tmp = Buffer.alloc(this.#masked.length);
    try {
      for (let i = 0; i < tmp.length; i++) tmp[i] = this.#masked[i] ^ this.#mask[i];
      return tmp.toString('latin1');
    } finally {
      tmp.fill(0);
    }
  }

  /** Überschreibt die internen Puffer mit Nullen. */
  dispose() {
    if (this.#masked === null) return;
    this.#masked.fill(0);
    this.#mask.fill(0);
    this.#masked = null;
    this.#mask = null;
  }

  // Verhindert versehentliches Loggen/Serialisieren.
  toString() {
    return '[SecretValue]';
  }

  toJSON() {
    return '[SecretValue]';
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return '[SecretValue]';
  }
}

/**
 * Baut den Wert eines Basic-Auth-Headers („Basic base64(user:pass)“) als Bytes,
 * ohne Benutzername oder Passwort als String zu materialisieren.
 * @param {Uint8Array} username UTF-8
 * @param {Uint8Array} password UTF-8
 * @returns {Buffer} Klartext-Headerwert; Aufrufer muss ihn nach Gebrauch nullen.
 */
export function basicAuthHeaderBytes(username, password) {
  const raw = Buffer.alloc(username.length + 1 + password.length);
  try {
    raw.set(username, 0);
    raw[username.length] = 0x3a; // ':'
    raw.set(password, username.length + 1);
    return base64WithPrefix('Basic ', raw);
  } finally {
    raw.fill(0);
  }
}

const B64 = Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/');

// Eigene Base64-Kodierung direkt in einen Buffer, damit kein Zwischen-String entsteht.
function base64WithPrefix(prefix, data) {
  const p = Buffer.from(prefix, 'latin1');
  const outLen = p.length + Math.ceil(data.length / 3) * 4;
  const out = Buffer.alloc(outLen);
  p.copy(out, 0);
  let o = p.length;
  let i = 0;
  for (; i + 2 < data.length; i += 3) {
    const n = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    out[o++] = B64[(n >> 18) & 63];
    out[o++] = B64[(n >> 12) & 63];
    out[o++] = B64[(n >> 6) & 63];
    out[o++] = B64[n & 63];
  }
  const rest = data.length - i;
  if (rest === 1) {
    const n = data[i] << 16;
    out[o++] = B64[(n >> 18) & 63];
    out[o++] = B64[(n >> 12) & 63];
    out[o++] = 0x3d;
    out[o++] = 0x3d;
  } else if (rest === 2) {
    const n = (data[i] << 16) | (data[i + 1] << 8);
    out[o++] = B64[(n >> 18) & 63];
    out[o++] = B64[(n >> 12) & 63];
    out[o++] = B64[(n >> 6) & 63];
    out[o++] = 0x3d;
  }
  return out;
}
