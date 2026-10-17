import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { promptHidden } from '../src/prompt.js';

function fakeTty() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.rawCalls = [];
  input.setRawMode = (v) => {
    input.rawCalls.push(v);
    input.isRaw = v;
    return input;
  };
  const output = new PassThrough();
  let written = '';
  output.on('data', (c) => (written += c));
  return { input, output, written: () => written };
}

test('liest Passwort verdeckt als Buffer, ohne Echo', async () => {
  const io = fakeTty();
  const p = promptHidden('Passwort: ', io);
  io.input.write('gehe');
  io.input.write(Buffer.from('im ✓\r'));
  const buf = await p;
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.toString('utf8'), 'geheim ✓');
  await new Promise((r) => setImmediate(r));
  assert.equal(io.written(), 'Passwort: \n', 'Eingabe wird nicht ausgegeben');
  assert.deepEqual(io.input.rawCalls, [true, false], 'Raw-Modus wird wiederhergestellt');
});

test('Backspace entfernt ganze UTF-8-Zeichen, Ctrl-U löscht, Escape-Sequenzen werden ignoriert', async () => {
  const io = fakeTty();
  const p = promptHidden('> ', io);
  io.input.write(Buffer.from('xyz\x15abä\x7f\x7fc\x1b[Dd\x1b[200~ef\x1b[201~\n'));
  assert.equal((await p).toString('utf8'), 'acdef');
});

test('Ctrl-C bricht ab', async () => {
  const io = fakeTty();
  const p = promptHidden('> ', io);
  io.input.write('abc\x03');
  await assert.rejects(p, (e) => e.code === 'ABORTED');
  assert.deepEqual(io.input.rawCalls, [true, false]);
});

test('ohne TTY wird verweigert (kein Passwort über Pipe)', async () => {
  const input = new PassThrough();
  await assert.rejects(promptHidden('> ', { input, output: new PassThrough() }), (e) => e.code === 'ENOTTY');
});

test('Ende des Eingabestroms bricht ab und stellt das Terminal wieder her', async () => {
  const io = fakeTty();
  const p = promptHidden('> ', io);
  io.input.write('abc');
  io.input.end();
  await assert.rejects(p, (e) => e.code === 'ABORTED');
  assert.deepEqual(io.input.rawCalls, [true, false]);
  assert.equal(io.input.listenerCount('data'), 0);
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  test(`externes ${sig} stellt das Terminal wieder her und bricht ab`, async () => {
    const io = fakeTty();
    const { EventEmitter } = await import('node:events');
    const signals = new EventEmitter();
    const p = promptHidden('> ', { ...io, signals });
    io.input.write('teil');
    await new Promise((r) => setImmediate(r));
    assert.equal(signals.listenerCount(sig), 1);
    signals.emit(sig, sig);
    await assert.rejects(p, (e) => e.code === 'ABORTED' && e.message.includes(sig));
    assert.deepEqual(io.input.rawCalls, [true, false]);
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit']) assert.equal(signals.listenerCount(s), 0, s);
    // Weitere Ereignisse nach dem Aufräumen sind harmlos.
    io.input.write('\r');
    assert.deepEqual(io.input.rawCalls, [true, false]);
  });
}

test('nach erfolgreicher Eingabe sind keine Signal-Handler mehr registriert', async () => {
  const io = fakeTty();
  const { EventEmitter } = await import('node:events');
  const signals = new EventEmitter();
  const p = promptHidden('> ', { ...io, signals });
  io.input.write('x\r');
  await p;
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit']) assert.equal(signals.listenerCount(s), 0, s);
});
