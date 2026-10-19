import assert from 'node:assert/strict';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import tls from 'node:tls';
import { ConfigError, loadCaFiles, loadConfig, validateConfig } from '../src/config.js';
import { main } from '../src/cli.js';
import { createProxy } from '../src/proxy.js';
import { SecretValue, basicAuthHeaderBytes } from '../src/secret.js';
import { request, tempDir } from './helpers.js';

// Öffentliche Demo-Zertifikate (test/fixtures/tls/generate.sh), gültig 2000–9999.
const FIXTURES = new URL('./fixtures/tls/', import.meta.url).pathname;
const fixture = (name) => path.join(FIXTURES, name);
const pem = async (name) => readFile(fixture(name), 'utf8');
const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`, 'utf8').toString('base64')}`;
const ROUTE = (env, svc) => ({ 'X-Proxy-Environment': env, 'X-Proxy-Service': svc });

const TLS_DEFAULT = { rejectUnauthorized: true, caFile: null, ca: null };
const svcOf = (c, name = 's') => c.environments[0].services.find((s) => s.name === name);
const one = (svc) => ({ environments: { dev: { s: svc } } });

test('tls: Standard ist strikte Prüfung, http:// hat kein TLS', () => {
  const c = validateConfig({ environments: { dev: { a: 'https://h', b: { url: 'https://h', tls: {} }, c: 'http://h', d: { url: 'http://h', tls: {} }, e: { url: 'https://h', tls: null } } } });
  assert.deepEqual(svcOf(c, 'a').tls, TLS_DEFAULT);
  assert.deepEqual(svcOf(c, 'b').tls, TLS_DEFAULT);
  assert.equal(svcOf(c, 'c').tls, null);
  assert.equal(svcOf(c, 'd').tls, null);
  assert.deepEqual(svcOf(c, 'e').tls, TLS_DEFAULT);
  assert.deepEqual(svcOf(validateConfig(one({ url: 'https://h', tls: { rejectUnauthorized: true } }))).tls, TLS_DEFAULT);
  assert.deepEqual(svcOf(validateConfig(one({ url: 'https://h', tls: { rejectUnauthorized: false } }))).tls, { rejectUnauthorized: false, caFile: null, ca: null });
  // caFile relativ zur Konfigurationsdatei, wird erst von loadConfig/loadCaFiles gelesen
  assert.deepEqual(svcOf(validateConfig(one({ url: 'https://h', tls: { caFile: 'certs/ca.pem' } }), '/etc/proxy')).tls, { rejectUnauthorized: true, caFile: path.resolve('/etc/proxy/certs/ca.pem'), ca: null });
});

test('tls: unbekannte Schlüssel, falsche Typen, http:// und Widerspruch werden gesammelt gemeldet', () => {
  let err;
  try {
    validateConfig({
      environments: {
        dev: {
          typo: { url: 'https://h', tls: { rejectUnauthorised: false } },
          str: { url: 'https://h', tls: { rejectUnauthorized: 'false' } },
          num: { url: 'https://h', tls: { caFile: 1 } },
          empty: { url: 'https://h', tls: { caFile: ' ' } },
          arr: { url: 'https://h', tls: [] },
          plain: { url: 'http://h', tls: { rejectUnauthorized: false } },
          plainCa: { url: 'http://h', tls: { caFile: 'ca.pem' } },
          both: { url: 'https://h', tls: { caFile: 'ca.pem', rejectUnauthorized: false } },
        },
      },
    });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof ConfigError);
  for (const re of [
    /dev\.typo\.tls: unbekannter Schlüssel „rejectUnauthorised“ \(erlaubt: rejectUnauthorized, caFile\)/,
    /dev\.str\.tls\.rejectUnauthorized: muss true oder false sein/,
    /dev\.num\.tls\.caFile: muss ein Pfad/,
    /dev\.empty\.tls\.caFile: muss ein Pfad/,
    /dev\.arr\.tls: muss ein Objekt/,
    /dev\.plain\.tls: gilt nur für https:\/\//,
    /dev\.plainCa\.tls: gilt nur für https:\/\//,
    /dev\.both\.tls: „caFile“ und „rejectUnauthorized: false“ widersprechen sich/,
  ]) {
    assert.match(err.message, re);
  }
});

test('tls.caFile: loadConfig lädt relativ zur Konfigurationsdatei und ergänzt die Node-Root-CAs', async (t) => {
  const dir = await tempDir(t);
  await copyFile(fixture('ca.pem'), path.join(dir, 'firmen-ca.pem'));
  const f = path.join(dir, 'connection.json');
  await writeFile(f, JSON.stringify({ environments: { dev: { a: { url: 'https://h', tls: { caFile: './firmen-ca.pem' } }, b: { url: 'https://i', tls: { caFile: 'firmen-ca.pem' } }, c: 'https://j' } } }));
  const c = await loadConfig(f);
  const a = svcOf(c, 'a');
  assert.equal(a.tls.caFile, path.join(dir, 'firmen-ca.pem'));
  assert.equal(a.tls.ca.length, tls.rootCertificates.length + 1, 'additiv: eingebaute Roots + private CA');
  assert.deepEqual(a.tls.ca.slice(0, -1), tls.rootCertificates);
  assert.equal(a.tls.ca.at(-1).trim(), (await pem('ca.pem')).trim());
  assert.equal(svcOf(c, 'b').tls.ca, a.tls.ca, 'gleiche Datei wird einmal gelesen');
  assert.deepEqual(svcOf(c, 'c').tls, TLS_DEFAULT);
  assert.ok(Object.isFrozen(c) && Object.isFrozen(a) && Object.isFrozen(a.tls));
});

test('tls.caFile: fehlende, leere, ungültige Datei oder privater Schlüssel → klarer Fehler', async (t) => {
  const dir = await tempDir(t);
  const caText = await pem('ca.pem');
  const files = {
    'leer.pem': '',
    'text.pem': 'kein Zertifikat\n',
    'kaputt.pem': caText.replace(/(BEGIN CERTIFICATE-----\n)..../, '$1!!!!'),
    'mit-key.pem': caText + (await pem('server.key')),
  };
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(dir, name), content);
  const cases = [
    ['fehlt.pem', /dev\.s\.tls\.caFile: .*fehlt\.pem kann nicht gelesen werden: ENOENT/],
    ['leer.pem', /leer\.pem enthält kein PEM-Zertifikat/],
    ['text.pem', /text\.pem enthält kein PEM-Zertifikat/],
    ['kaputt.pem', /kaputt\.pem enthält ein ungültiges Zertifikat/],
    ['mit-key.pem', /mit-key\.pem enthält einen privaten Schlüssel/],
    ['.', /kann nicht gelesen werden: EISDIR/],
  ];
  const f = path.join(dir, 'connection.json');
  for (const [caFile, re] of cases) {
    await writeFile(f, JSON.stringify(one({ url: 'https://h', tls: { caFile } })));
    await assert.rejects(loadConfig(f), (err) => err instanceof ConfigError && re.test(err.message), caFile);
  }
});

test('createProxy(validateConfig()) ignoriert tls.caFile nicht stillschweigend', async () => {
  const config = validateConfig(one({ url: 'https://127.0.0.1:1', tls: { caFile: fixture('ca.pem') } }));
  assert.throws(() => createProxy({ config }), /dev\/s ist tls\.caFile .*ca\.pem nicht geladen/);
  const proxy = createProxy({ config: await loadCaFiles(config) });
  await proxy.close();
});

/** HTTPS-Upstream mit Fixture-Zertifikat; zählt TLS-Verbindungen und Requests. */
async function tlsUpstream(t, cert) {
  const seen = [];
  const server = https.createServer({ cert: await pem(`${cert}.pem`), key: await pem(`${cert}.key`) }, (req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization ?? null, host: req.headers.host });
    res.end('ok');
  });
  let connections = 0;
  server.on('secureConnection', () => connections++);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((r) => server.close(() => r()));
  });
  return { seen, connections: () => connections, url: `https://127.0.0.1:${server.address().port}` };
}

async function tlsProxy(t, services, credentialsFor = []) {
  const config = await loadCaFiles(validateConfig({ keepass: { database: 'egal.kdbx' }, listen: { port: 0, mcpPort: 0 }, environments: { dev: services } }));
  const credentials = new Map(credentialsFor.map((name) => [`dev/${name}`, new SecretValue(basicAuthHeaderBytes(Buffer.from('svc'), Buffer.from('Gehe1m!')))]));
  const logs = [];
  const proxy = createProxy({ config, credentials, log: (l) => logs.push(l) });
  await proxy.listen();
  t.after(() => proxy.close());
  const port = proxy.server.address().port;
  const call = (svc, extra = {}) => request(port, { path: '/x?y=1', headers: { Host: `127.0.0.1:${port}`, ...ROUTE('dev', svc), ...extra } });
  return { call, logs };
}

test('TLS Ende-zu-Ende: privates Zertifikat ohne caFile → 502, Zugangsdaten verlassen den Proxy nicht', async (t) => {
  const up = await tlsUpstream(t, 'server');
  const { call, logs } = await tlsProxy(t, { def: { url: up.url, auth: { entry: { title: 'x' } } }, explicit: { url: up.url, tls: { rejectUnauthorized: true } } }, ['def']);
  for (const svc of ['def', 'explicit']) {
    const r = await call(svc);
    assert.equal(r.status, 502, svc);
    assert.equal(r.headers['x-proxy-error'], '1');
    assert.match(r.body.toString(), /UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY/);
    assert.match(r.body.toString(), /tls\.caFile/);
  }
  assert.equal(up.seen.length, 0, 'kein Request (und kein Authorization-Header) beim ungeprüften Server');
  assert.ok(logs.every((l) => !l.includes('Gehe1m')));
});

test('TLS Ende-zu-Ende: passende caFile → 200 inkl. Basic Auth; fremde CA → 502', async (t) => {
  const up = await tlsUpstream(t, 'server');
  const { call } = await tlsProxy(
    t,
    {
      ca: { url: `${up.url}/base`, tls: { caFile: fixture('ca.pem') }, auth: { username: 'svc', entry: { title: 'x' } } },
      other: { url: up.url, tls: { caFile: fixture('other-ca.pem') } },
    },
    ['ca'],
  );
  const ok = await call('ca', { Authorization: 'Bearer vom-client' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.toString(), 'ok');
  assert.deepEqual(up.seen, [{ url: '/base/x?y=1', auth: basic('svc', 'Gehe1m!'), host: up.url.slice('https://'.length) }]);
  const bad = await call('other');
  assert.equal(bad.status, 502);
  assert.equal(up.seen.length, 1);
});

test('TLS Ende-zu-Ende: Hostname wird trotz vertrauter CA geprüft', async (t) => {
  // Zertifikat von der Test-CA, aber nur für wrong.example ausgestellt.
  const up = await tlsUpstream(t, 'wronghost');
  const { call } = await tlsProxy(t, { ca: { url: up.url, tls: { caFile: fixture('ca.pem') } } });
  const r = await call('ca');
  assert.equal(r.status, 502);
  assert.match(r.body.toString(), /ERR_TLS_CERT_ALTNAME_INVALID.*Hostnamen/);
  assert.equal(up.seen.length, 0);
});

test('TLS Ende-zu-Ende: rejectUnauthorized: false nur für diesen Service, nie global', async (t) => {
  const up = await tlsUpstream(t, 'wronghost');
  const { call } = await tlsProxy(t, { insecure: { url: up.url, tls: { rejectUnauthorized: false } } });
  const r = await call('insecure');
  assert.equal(r.status, 200);
  assert.equal(r.body.toString(), 'ok');
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  assert.equal(https.globalAgent.options.rejectUnauthorized, undefined);
  // Ein unabhängiger HTTPS-Client im selben Prozess prüft weiterhin.
  await assert.rejects(
    new Promise((resolve, reject) => https.get(up.url, { agent: false }, resolve).on('error', reject)),
    (err) => /SELF_SIGNED|UNABLE_TO|ALTNAME/.test(err.code),
  );
});

test('TLS Ende-zu-Ende: geprüfter Service nutzt nie den Socket eines ungeprüften (gleicher Endpunkt)', async (t) => {
  const up = await tlsUpstream(t, 'server');
  const wrong = await tlsUpstream(t, 'wronghost');
  const { call } = await tlsProxy(t, {
    insecure: { url: up.url, tls: { rejectUnauthorized: false } },
    secure: up.url,
    insecureWrong: { url: wrong.url, tls: { rejectUnauthorized: false } },
    caWrong: { url: wrong.url, tls: { caFile: fixture('ca.pem') } },
  });
  assert.equal((await call('insecure')).status, 200);
  assert.equal((await call('insecure')).status, 200);
  assert.equal(up.connections(), 1, 'Keep-Alive aktiv: der ungeprüfte Socket liegt im Pool');
  assert.equal((await call('secure')).status, 502);
  assert.equal((await call('secure')).status, 502);
  assert.equal(up.seen.length, 2, 'nur die beiden ungeprüften Requests kamen an');
  assert.equal((await call('insecure')).status, 200);

  // Auch die Hostname-Prüfung lässt sich nicht über einen gepoolten Socket umgehen.
  assert.equal((await call('insecureWrong')).status, 200);
  assert.equal((await call('caWrong')).status, 502);
  assert.equal(wrong.seen.length, 1);
});

function sink() {
  const s = new PassThrough();
  let text = '';
  s.on('data', (c) => (text += c));
  return { stream: s, text: () => text };
}

test('CLI: CA-Datei wird vor der Passwortabfrage geprüft', async (t) => {
  const dir = await tempDir(t);
  await writeFile(path.join(dir, 'kaputt.pem'), 'kein PEM');
  const f = path.join(dir, 'connection.json');
  const prompt = async () => assert.fail('Passwort darf nicht abgefragt werden');
  for (const [caFile, re] of [['./certs/fehlt.pem', /environments\.dev\.kunden\.tls\.caFile: .*certs\/fehlt\.pem kann nicht gelesen werden: ENOENT/], ['kaputt.pem', /kaputt\.pem enthält kein PEM-Zertifikat/]]) {
    await writeFile(f, JSON.stringify({ keepass: { database: './zugang.kdbx' }, environments: { dev: { kunden: { url: 'https://h', tls: { caFile }, auth: { entry: { title: 'k' } } } } } }));
    const out = sink();
    const err = sink();
    const r = await main(['--config', f], { stdout: out.stream, stderr: err.stream, prompt });
    assert.equal(r.exitCode, 1);
    assert.match(err.text(), re);
  }
});

test('CLI: ungeprüfter Service erzeugt eine Warnung, CA-Services sind markiert', async (t) => {
  const dir = await tempDir(t);
  await copyFile(fixture('ca.pem'), path.join(dir, 'ca.pem'));
  const f = path.join(dir, 'connection.json');
  await writeFile(f, JSON.stringify({ listen: { port: 0, mcpPort: 0 }, environments: { dev: { a: { url: 'https://a.example', tls: { rejectUnauthorized: false } }, b: { url: 'https://b.example', tls: { caFile: './ca.pem' } }, c: 'https://c.example' } } }));
  const out = sink();
  const err = sink();
  const r = await main(['--config', f], { stdout: out.stream, stderr: err.stream });
  t.after(() => r.proxy?.close());
  assert.equal(r.exitCode, 0);
  assert.match(err.text(), /WARNUNG: dev\/a: TLS-Zertifikatsprüfung ist ausgeschaltet/);
  assert.doesNotMatch(err.text(), /dev\/[bc]/);
  assert.match(out.text(), /dev \/ a .*\[TLS OHNE Prüfung\]/);
  assert.match(out.text(), new RegExp(`dev / b .*\\[TLS-CA: ${path.join(dir, 'ca.pem').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`));
  assert.doesNotMatch(out.text(), /dev \/ c .*\[TLS/);
});
