import assert from 'node:assert/strict';
import * as nodeCrypto from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { validateConfig } from '../src/config.js';
import { argon2Impl, KeePassError, openDatabase, resolveCredentials, kdbxweb } from '../src/keepass.js';
import { createKdbx, tempDir, uuidHex } from './helpers.js';

const cryptoArgon2 = nodeCrypto.argon2;
const PASSWORD = 'Märchen-Passwort 🔐 123';
const pw = () => Buffer.from(PASSWORD, 'utf8');
const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`, 'utf8').toString('base64')}`;

const ab = (s) => new Uint8Array(Buffer.from(s)).buffer;

// Testvektoren der Argon2-Referenzimplementierung (phc-winner-argon2, Version 0x13),
// zusätzlich gegen OpenSSL (crypto.argon2 in Node >= 24.7) gegengeprüft.
const VECTORS = [
  { type: 0, name: 'argon2d', pw: 'password', salt: 'somesalt', m: 65536, t: 2, p: 1, hex: '955e5d5b163a1b60bba35fc36d0496474fba4f6b59ad53628666f07fb2f93eaf' },
  { type: 2, name: 'argon2id', pw: 'password', salt: 'somesalt', m: 65536, t: 2, p: 1, hex: '09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7' },
  { type: 0, name: 'argon2d', pw: 'password', salt: 'somesaltsomesaltsomesaltsomesalt', m: 1024, t: 3, p: 2, hex: 'd211dde92d3387888751b04ce1e2030f13b0165df990f8cb2b2de39ea217051a' },
  { type: 2, name: 'argon2id', pw: 'password', salt: 'somesaltsomesaltsomesaltsomesalt', m: 1024, t: 3, p: 2, hex: 'a81c7b80805beb6d004bd7e2e7cb96a21570c2fdfe7e5411d786b595862bf061' },
];

test('argon2Impl (Argon2d/Argon2id) liefert die Referenz-Testvektoren', async () => {
  for (const v of VECTORS) {
    const out = await argon2Impl(ab(v.pw), ab(v.salt), v.m, v.t, 32, v.p, v.type, 0x13);
    assert.ok(out instanceof ArrayBuffer);
    assert.equal(Buffer.from(out).toString('hex'), v.hex, `${v.name} m=${v.m} t=${v.t} p=${v.p}`);
  }
});

test('argon2Impl lehnt Argon2i und Version 0x10 ab', async () => {
  await assert.rejects(argon2Impl(ab('a'), ab('somesalt'), 64, 1, 32, 1, 1, 0x13), /nur Argon2d und Argon2id/);
  await assert.rejects(argon2Impl(ab('a'), ab('somesalt'), 64, 1, 32, 1, 0, 0x10), /Version 0x10/);
});

test('Gegenprobe mit OpenSSL-Argon2, falls die Node-Version es anbietet', { skip: typeof cryptoArgon2 !== 'function' && 'crypto.argon2 nicht verfügbar (Node < 24.7)' }, async () => {
  for (const v of VECTORS) {
    const expected = await new Promise((res, rej) =>
      cryptoArgon2(v.name, { message: Buffer.from(v.pw), nonce: Buffer.from(v.salt), memory: v.m, passes: v.t, parallelism: v.p, tagLength: 32 }, (e, k) => (e ? rej(e) : res(k.toString('hex')))),
    );
    assert.equal(expected, v.hex);
  }
});

for (const kdf of ['argon2id', 'argon2d']) {
  test(`öffnet echte KDBX4-Datei mit ${kdf} und löst Zugangsdaten auf`, async (t) => {
    const dir = await tempDir(t);
    const file = path.join(dir, 'db.kdbx');
    let byUuid;
    await createKdbx(file, {
      password: PASSWORD,
      kdf,
      build: (db, root, h) => {
        const dev = h.group(root, 'Dev');
        const svcs = h.group(dev, 'Services');
        h.entry(svcs, { Title: 'kunden', UserName: 'kp-user', Password: 'geheim:mit:doppelpunkt' });
        byUuid = h.entry(root, { Title: 'irgendwas', UserName: 'uuid-user', Password: 'pässwört' });
      },
    });

    // Dateiformat wirklich KDBX4 + Argon2?
    const raw = await readFile(file);
    assert.equal(raw.readUInt32LE(0), 0x9aa2d903);
    assert.equal(raw.readUInt16LE(10), 4, 'Major-Version 4');

    const db = await openDatabase({ database: file, password: pw() });
    assert.equal(db.header.versionMajor, 4);
    const kdfUuid = db.header.kdfParameters.get('$UUID');
    const expectedKdf = kdf === 'argon2d' ? kdbxweb.Consts.KdfId.Argon2d : kdbxweb.Consts.KdfId.Argon2id;
    assert.equal(Buffer.from(kdfUuid).toString('base64'), expectedKdf);

    const config = validateConfig({
      keepass: { database: file },
      environments: {
        dev: {
          a: { url: 'http://x', auth: { entry: { group: 'Dev/Services', title: 'kunden' } } },
          b: { url: 'http://x', auth: { username: 'override', entry: { group: ['Dev', 'Services'], title: 'kunden' } } },
          c: { url: 'http://x', auth: { entry: { uuid: uuidHex(byUuid) } } },
          d: { url: 'http://x', auth: { entry: { uuid: byUuid.uuid.id } } },
          e: { url: 'http://x', auth: { entry: { title: 'kunden' } } },
          f: 'http://x',
        },
      },
    });
    const creds = resolveCredentials(db, config);
    assert.equal(creds.get('dev/a').reveal(), basic('kp-user', 'geheim:mit:doppelpunkt'));
    assert.equal(creds.get('dev/b').reveal(), basic('override', 'geheim:mit:doppelpunkt'));
    assert.equal(creds.get('dev/c').reveal(), basic('uuid-user', 'pässwört'));
    assert.equal(creds.get('dev/d').reveal(), basic('uuid-user', 'pässwört'));
    assert.equal(creds.get('dev/e').reveal(), basic('kp-user', 'geheim:mit:doppelpunkt'));
    assert.equal(creds.has('dev/f'), false);
    // Geheimnisse werden beim Loggen nicht preisgegeben.
    assert.equal(String(creds.get('dev/a')), '[SecretValue]');
    assert.equal(JSON.stringify({ x: creds.get('dev/a') }), '{"x":"[SecretValue]"}');
  });
}

test('falsches Master-Passwort wird als InvalidKey gemeldet', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'db.kdbx');
  await createKdbx(file, { password: PASSWORD, build: () => {} });
  await assert.rejects(openDatabase({ database: file, password: Buffer.from('falsch') }), (err) => err instanceof KeePassError && err.code === 'InvalidKey');
});

test('Datenbank mit Schlüsseldatei', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'db.kdbx');
  const keyFile = path.join(dir, 'db.key');
  const key = Buffer.alloc(32, 0xab);
  await (await import('node:fs/promises')).writeFile(keyFile, key);
  await createKdbx(file, { password: PASSWORD, keyFile: key, build: (db, root, h) => h.entry(root, { Title: 't', UserName: 'u', Password: 'p' }) });
  await assert.rejects(openDatabase({ database: file, password: pw() }), (err) => err.code === 'InvalidKey');
  const db = await openDatabase({ database: file, keyFile, password: pw() });
  const creds = resolveCredentials(db, validateConfig({ keepass: { database: file }, environments: { e: { s: { url: 'http://x', auth: { entry: { title: 't' } } } } } }));
  assert.equal(creds.get('e/s').reveal(), basic('u', 'p'));
});

test('fehlende, mehrdeutige und unvollständige Einträge führen zu klaren Fehlern', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'db.kdbx');
  await createKdbx(file, {
    password: PASSWORD,
    build: (db, root, h) => {
      const a = h.group(root, 'A');
      const b = h.group(root, 'B');
      h.entry(a, { Title: 'doppelt', UserName: 'u1', Password: 'p1' });
      h.entry(b, { Title: 'doppelt', UserName: 'u2', Password: 'p2' });
      h.entry(a, { Title: 'zweimal', UserName: 'u', Password: 'p' });
      h.entry(a, { Title: 'zweimal', UserName: 'u', Password: 'p' });
      h.entry(root, { Title: 'ohne-user', Password: 'p' });
      h.entry(root, { Title: 'ohne-pw', UserName: 'u' });
      h.entry(root, { Title: 'user-mit-doppelpunkt', UserName: 'a:b', Password: 'p' });
      h.group(root, 'G');
      h.group(root, 'G');
      db.createRecycleBin();
      const trash = db.getGroup(db.meta.recycleBinUuid);
      h.entry(trash, { Title: 'geloescht', UserName: 'u', Password: 'p' });
      h.entry(trash, { Title: 'doppelt', UserName: 'u3', Password: 'p3' });
    },
  });
  const db = await openDatabase({ database: file, password: pw() });
  const trashed = db.getGroup(db.meta.recycleBinUuid).entries[0];

  const svc = (auth) => ({ url: 'http://x', auth });
  const config = validateConfig({
    keepass: { database: file },
    environments: {
      e: {
        mehrdeutig: svc({ entry: { title: 'doppelt' } }),
        eindeutigMitGruppe: svc({ entry: { group: 'A', title: 'doppelt' } }),
        zweimal: svc({ entry: { group: 'A', title: 'zweimal' } }),
        fehlt: svc({ entry: { title: 'gibtsnicht' } }),
        gruppeFehlt: svc({ entry: { group: 'X/Y', title: 'doppelt' } }),
        gruppeDoppelt: svc({ entry: { group: 'G', title: 'x' } }),
        ohneUser: svc({ entry: { title: 'ohne-user' } }),
        ohneUserAberConfig: svc({ username: 'cfg', entry: { title: 'ohne-user' } }),
        ohnePw: svc({ username: 'cfg', entry: { title: 'ohne-pw' } }),
        doppelpunkt: svc({ entry: { title: 'user-mit-doppelpunkt' } }),
        papierkorb: svc({ entry: { title: 'geloescht' } }),
        papierkorbUuid: svc({ entry: { uuid: uuidHex(trashed) } }),
        uuidFehlt: svc({ entry: { uuid: '00000000000000000000000000000001' } }),
      },
    },
  });

  let error;
  try {
    resolveCredentials(db, config);
  } catch (err) {
    error = err;
  }
  assert.ok(error instanceof KeePassError);
  const msg = error.message;
  assert.match(msg, /e\/mehrdeutig: Titel „doppelt“ ist mehrdeutig \(„A\/doppelt“, „B\/doppelt“\)/);
  assert.doesNotMatch(msg, /eindeutigMitGruppe/);
  assert.match(msg, /e\/zweimal: .*mehrdeutig \(2 Treffer\)/);
  assert.match(msg, /e\/fehlt: Kein Eintrag mit Titel „gibtsnicht“/);
  assert.match(msg, /e\/gruppeFehlt: Gruppe „X“ nicht gefunden/);
  assert.match(msg, /e\/gruppeDoppelt: Gruppe „G“ ist mehrdeutig/);
  assert.match(msg, /e\/ohneUser: Kein Benutzername/);
  assert.doesNotMatch(msg, /ohneUserAberConfig/);
  assert.match(msg, /e\/ohnePw: .*hat kein Passwort/);
  assert.match(msg, /e\/doppelpunkt: .*Doppelpunkt/);
  assert.match(msg, /e\/papierkorb: Kein Eintrag/);
  assert.match(msg, /e\/papierkorbUuid: .*Papierkorb/);
  assert.match(msg, /e\/uuidFehlt: Kein Eintrag mit UUID/);
  // Fehlermeldungen enthalten keine Passwörter.
  for (const secret of ['p1', 'p2', 'p3']) assert.doesNotMatch(msg, new RegExp(`\\b${secret}\\b`));
});
