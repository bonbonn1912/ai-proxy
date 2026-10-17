import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { installArgon2, kdbxweb } from '../src/keepass.js';

export async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-proxy-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Erzeugt eine echte KDBX4-Datei (Argon2) mit kdbxweb.
 * @param {string} file
 * @param {object} opts
 * @param {string} opts.password
 * @param {'argon2id'|'argon2d'} [opts.kdf]
 * @param {Uint8Array} [opts.keyFile]
 * @param {(db: any, root: any, h: {group: Function, entry: Function}) => void} opts.build
 */
export async function createKdbx(file, { password, kdf = 'argon2id', keyFile, build }) {
  installArgon2();
  const creds = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password), keyFile ? copyAb(keyFile) : null);
  const db = kdbxweb.Kdbx.create(creds, 'Testdatenbank');
  db.setVersion(4);
  db.setKdf(kdf === 'argon2d' ? kdbxweb.Consts.KdfId.Argon2d : kdbxweb.Consts.KdfId.Argon2id);
  const root = db.getDefaultGroup();
  const h = {
    group: (parent, name) => db.createGroup(parent, name),
    entry: (parent, fields) => {
      const e = db.createEntry(parent);
      for (const [k, v] of Object.entries(fields)) {
        e.fields.set(k, k === 'Password' ? kdbxweb.ProtectedValue.fromString(v) : v);
      }
      return e;
    },
  };
  build(db, root, h);
  const data = await db.save();
  await writeFile(file, Buffer.from(data));
  return db;
}

function copyAb(u8) {
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}

export function uuidHex(entry) {
  return Buffer.from(entry.uuid.bytes).toString('hex').toUpperCase();
}

/** Startet einen HTTP-Server auf einem freien Port. */
export async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((r) => server.close(() => r()));
  });
  return { server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` };
}

/** Einfacher HTTP-Client, der die Antwort roh zurückgibt. */
export function request(port, { method = 'GET', path = '/', headers = {}, body, agent = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, statusMessage: res.statusMessage, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}
