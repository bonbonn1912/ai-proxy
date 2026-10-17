import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ConfigError, FORBIDDEN_DEFAULT_HEADERS, loadConfig, loadHeadersFile, parseUuid, validateConfig, validateDefaultHeaders } from '../src/config.js';
import { tempDir } from './helpers.js';

const minimal = (extra = {}) => ({ environments: { dev: { svc: 'http://localhost:9000/base/' } }, ...extra });

test('Defaults: localhost, Proxy-Port 8075, MCP-Port 8076, Timeout 30 s, Basis-Pfad ohne Slash', () => {
  const c = validateConfig(minimal());
  assert.deepEqual(c.listen, { host: '127.0.0.1', port: 8075, mcpPort: 8076, allowedHosts: [], allowedOrigins: [] });
  assert.equal(c.mcp, true);
  assert.equal(c.needsKeepass, false);
  assert.equal(c.headersFile, null);
  assert.deepEqual(c.defaultHeaders, []);
  const svc = c.environments[0].services[0];
  assert.equal(svc.basePath, '/base');
  assert.equal(svc.hostHeader, 'localhost:9000');
  assert.equal(svc.port, 9000);
  assert.equal(svc.timeoutMs, 30000);
});

test('Standard-Ports, IPv6 und relative KeePass-Pfade', () => {
  const c = validateConfig(
    {
      keepass: { database: 'db.kdbx', keyFile: 'sub/key.keyx' },
      upstream: { timeoutMs: 5000 },
      environments: {
        e: {
          a: { url: 'https://example.com', timeoutMs: 100 },
          b: 'http://[::1]:81/x',
        },
      },
    },
    '/etc/proxy',
  );
  assert.equal(c.keepass.database, path.resolve('/etc/proxy/db.kdbx'));
  assert.equal(c.keepass.keyFile, path.resolve('/etc/proxy/sub/key.keyx'));
  const [a, b] = c.environments[0].services;
  assert.equal(a.port, 443);
  assert.equal(a.basePath, '');
  assert.equal(a.timeoutMs, 100);
  assert.equal(b.hostname, '::1');
  assert.equal(b.hostHeader, '[::1]:81');
  assert.equal(b.timeoutMs, 5000);
});

test('alle Fehler werden gesammelt gemeldet', () => {
  const bad = {
    listen: { port: 70000, mcpPort: -1, bogus: 1 },
    environments: {
      'bad name': { s: 'http://x' },
      ok: {
        noUrl: {},
        ftp: 'ftp://x',
        creds: 'http://u:p@x',
        query: 'http://x/?a=1',
        frag: 'http://x/#a',
        authNoEntry: { url: 'http://x', auth: {} },
        authBoth: { url: 'http://x', auth: { entry: { uuid: '00000000000000000000000000000001', title: 't' } } },
        authBadUuid: { url: 'http://x', auth: { entry: { uuid: 'xyz' } } },
        authColon: { url: 'http://x', auth: { username: 'a:b', entry: { title: 't' } } },
        authCtl: { url: 'http://x', auth: { username: 'a\nb', entry: { title: 't' } } },
        authGroup: { url: 'http://x', auth: { entry: { group: 'a//b', title: 't' } } },
        typo: { url: 'http://x', autth: {} },
      },
      leer: {},
    },
  };
  let err;
  try {
    validateConfig(bad);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof ConfigError);
  const m = err.message;
  for (const re of [
    /listen: unbekannter Schlüssel „bogus“/,
    /listen.port/,
    /listen.mcpPort: muss eine ganze Zahl/,
    /environments.bad name: ungültiger Name/,
    /ok.noUrl.url: fehlt/,
    /ok.ftp.url: nur http/,
    /ok.creds.url: darf keine Zugangsdaten/,
    /ok.query.url: darf keinen Query/,
    /ok.frag.url: darf kein Fragment/,
    /ok.authNoEntry.auth.entry: fehlt/,
    /ok.authBoth.auth.entry: mehrdeutig/,
    /ok.authBadUuid.auth.entry.uuid/,
    /ok.authColon.auth.username: .*Doppelpunkt/,
    /ok.authCtl.auth.username: .*Steuerzeichen/,
    /ok.authGroup.auth.entry.group/,
    /ok.typo: unbekannter Schlüssel „autth“/,
    /environments.leer: muss ein Objekt mit mindestens einem Service/,
    /keepass: mindestens ein Service nutzt Basic Auth/,
  ]) {
    assert.match(m, re);
  }
});

test('leere oder fehlende environments', () => {
  assert.throws(() => validateConfig({}), /environments/);
  assert.throws(() => validateConfig({ environments: {} }), /environments/);
  assert.throws(() => validateConfig([]), ConfigError);
});

test('parseUuid akzeptiert Hex (mit/ohne Bindestriche) und Base64', () => {
  const hex = '3F2504E04F8911D39A0C0305E82C3301';
  assert.equal(parseUuid(hex).toString('hex').toUpperCase(), hex);
  assert.equal(parseUuid('3f2504e0-4f89-11d3-9a0c-0305e82c3301').toString('hex').toUpperCase(), hex);
  assert.equal(parseUuid(Buffer.from(hex, 'hex').toString('base64')).toString('hex').toUpperCase(), hex);
  assert.equal(parseUuid('nope'), null);
  assert.equal(parseUuid(42), null);
});

test('loadConfig meldet unlesbare Datei und kaputtes JSON', async (t) => {
  const dir = await tempDir(t);
  await assert.rejects(loadConfig(path.join(dir, 'fehlt.json')), /kann nicht gelesen werden/);
  const f = path.join(dir, 'c.json');
  await writeFile(f, '{ kaputt');
  await assert.rejects(loadConfig(f), /kein gültiges JSON/);
});

test('listen.mcpPort: eigener Port, darf nicht mit listen.port kollidieren (außer 0 oder mcp: false)', () => {
  assert.equal(validateConfig(minimal({ listen: { port: 9001, mcpPort: 9002 } })).listen.mcpPort, 9002);
  assert.throws(() => validateConfig(minimal({ listen: { port: 9001, mcpPort: 9001 } })), /listen.mcpPort: muss sich von listen.port \(9001\) unterscheiden/);
  assert.throws(() => validateConfig(minimal({ listen: { port: 8076 } })), /listen.mcpPort/);
  assert.deepEqual(validateConfig(minimal({ listen: { port: 0, mcpPort: 0 } })).listen.port, 0);
  assert.equal(validateConfig(minimal({ mcp: false, listen: { port: 9001, mcpPort: 9001 } })).mcp, false);
  for (const bad of ['8076', 1.5, 65536, null]) assert.throws(() => validateConfig(minimal({ listen: { mcpPort: bad } })), /listen.mcpPort/, String(bad));
});

test('connection.example.json und headers.example.json sind gültig', async () => {
  const example = new URL('../connection.example.json', import.meta.url).pathname;
  const c = validateConfig(JSON.parse(await readFile(example, 'utf8')), path.dirname(example));
  assert.equal(c.needsKeepass, true);
  assert.deepEqual(c.environments.map((e) => e.name), ['dev', 'test']);
  assert.deepEqual([c.listen.port, c.listen.mcpPort], [8075, 8076]);
  assert.equal(c.headersFile, path.join(path.dirname(example), 'headers.json'));
  const headers = await loadHeadersFile(new URL('../headers.example.json', import.meta.url).pathname);
  assert.deepEqual(headers, [['X-Client-Name', 'ai-proxy']]);
});

test('headersFile: relativ zur Konfigurationsdatei, wird von loadConfig gelesen', async (t) => {
  const dir = await tempDir(t);
  await writeFile(path.join(dir, 'h.json'), '{"X-Client-Name":"ai-proxy","Accept":"application/json"}');
  const f = path.join(dir, 'c.json');
  await writeFile(f, JSON.stringify(minimal({ headersFile: './h.json' })));
  const c = await loadConfig(f);
  assert.equal(c.headersFile, path.join(dir, 'h.json'));
  assert.deepEqual(c.defaultHeaders, [['X-Client-Name', 'ai-proxy'], ['Accept', 'application/json']]);
  assert.ok(Object.isFrozen(c));
  // null = keine Header-Datei
  assert.equal(validateConfig(minimal({ headersFile: null })).headersFile, null);
  assert.throws(() => validateConfig(minimal({ headersFile: 42 })), /headersFile: muss ein Pfad/);
  assert.throws(() => validateConfig(minimal({ headersFile: ' ' })), /headersFile/);
  await writeFile(f, JSON.stringify(minimal({ headersFile: './fehlt.json' })));
  await assert.rejects(loadConfig(f), /Header-Datei .*fehlt\.json kann nicht gelesen werden/);
});

test('validateDefaultHeaders: Namen, Werte, Duplikate und verbotene Header', () => {
  assert.deepEqual(validateDefaultHeaders({}), []);
  assert.deepEqual(validateDefaultHeaders({ 'X-A': 'a b', 'X-Latin': 'café' }), [['X-A', 'a b'], ['X-Latin', 'café']]);
  for (const bad of [null, [], 'x', 1]) assert.throws(() => validateDefaultHeaders(bad), /JSON-Objekt/);
  for (const name of [...FORBIDDEN_DEFAULT_HEADERS, 'HOST', 'X-Proxy-Service', 'Proxy-Authorization', 'Content-Length', 'Transfer-Encoding', 'Connection', 'Keep-Alive', 'TE', 'Trailer', 'Upgrade', 'Expect']) {
    assert.throws(() => validateDefaultHeaders({ [name]: 'x' }), /nicht erlaubt/, name);
  }
  for (const name of ['', 'X A', 'X:A', 'X-ä', '(x)']) assert.throws(() => validateDefaultHeaders({ [name]: 'x' }), /ungültiger Header-Name/, name);
  for (const value of ['', ' x', 'x ', 'a\r\nX-Evil: 1', 'a\u0000', 'a\u0100', '€']) assert.throws(() => validateDefaultHeaders({ 'X-A': value }), /ungültiger Wert/, JSON.stringify(value));
  for (const value of [1, true, null, ['a'], { a: 1 }]) assert.throws(() => validateDefaultHeaders({ 'X-A': value }), /muss ein String/, JSON.stringify(value));
  assert.throws(() => validateDefaultHeaders({ 'X-Team': 'a', 'x-team': 'b' }), /"x-team": doppelt/);
  // alle Fehler gesammelt
  assert.throws(() => validateDefaultHeaders({ Host: 'x', 'X A': 'y', 'X-B': 1 }), (err) => err instanceof ConfigError && /Host/.test(err.message) && /X A/.test(err.message) && /X-B/.test(err.message));
});
