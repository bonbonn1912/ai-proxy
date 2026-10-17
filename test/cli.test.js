import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { main, parseCli } from '../src/cli.js';
import { createKdbx, listen, request, tempDir } from './helpers.js';

const MASTER = 'Korrekt-Pferd-Batterie-Heftklammer';
const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`, 'utf8').toString('base64')}`;

function sink() {
  const s = new PassThrough();
  let text = '';
  s.on('data', (c) => (text += c));
  return { stream: s, text: () => text };
}

/** Prompt-Attrappe: liefert nacheinander die angegebenen Passwörter und merkt sich die Buffer. */
function fakePrompt(...answers) {
  const handed = [];
  const fn = async () => {
    const b = Buffer.from(answers.shift(), 'utf8');
    handed.push(b);
    return b;
  };
  fn.handed = handed;
  return fn;
}

async function fixture(t, { headersFile, headers, listen: listenOpts = { port: 0, mcpPort: 0 } } = {}) {
  const dir = await tempDir(t);
  const seen = [];
  const upstream = await listen(t, (req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization, ...(headers ? { client: req.headers['x-client-name'] } : {}) });
    res.end('ok');
  });
  if (headers !== undefined) {
    await mkdir(path.join(dir, 'conf'), { recursive: true });
    await writeFile(path.join(dir, 'conf', 'headers.json'), typeof headers === 'string' ? headers : JSON.stringify(headers));
  }
  const db = path.join(dir, 'zugang.kdbx');
  await createKdbx(db, {
    password: MASTER,
    build: (kdb, root, h) => {
      const dev = h.group(root, 'Dev');
      const prod = h.group(root, 'Prod');
      h.entry(dev, { Title: 'kunden', UserName: 'dev-user', Password: 'dev-geheim' });
      h.entry(prod, { Title: 'kunden', UserName: 'prod-user', Password: 'prod-geheim' });
    },
  });
  const configFile = path.join(dir, 'connection.json');
  await writeFile(
    configFile,
    JSON.stringify({
      listen: { host: '127.0.0.1', ...listenOpts },
      keepass: { database: './zugang.kdbx' },
      ...(headersFile ? { headersFile } : {}),
      environments: {
        dev: { kunden: { url: `${upstream.url}/dev`, auth: { entry: { group: 'Dev', title: 'kunden' } } } },
        prod: { kunden: { url: `${upstream.url}/prod`, auth: { username: 'prod-override', entry: { group: 'Prod', title: 'kunden' } } } },
        lokal: { kunden: `${upstream.url}/lokal` },
      },
    }),
  );
  return { configFile, seen, dir };
}

test('Ende-zu-Ende: echte KDBX, Prompt, Proxy, getrennte Zugangsdaten je Umgebung', async (t) => {
  const { configFile, seen } = await fixture(t);
  const stdout = sink();
  const stderr = sink();
  const prompt = fakePrompt('falsch', MASTER);
  const { exitCode, proxy, address } = await main(['--config', configFile], { stdout: stdout.stream, stderr: stderr.stream, prompt });
  assert.equal(exitCode, 0);
  t.after(() => proxy.close());

  assert.equal(prompt.handed.length, 2, 'nach falschem Passwort wird erneut gefragt');
  for (const b of prompt.handed) assert.ok(b.every((x) => x === 0), 'Passwort-Buffer wurden genullt');
  assert.match(stderr.text(), /Master-Passwort oder Schlüsseldatei ist falsch/);
  assert.match(stdout.text(), /dev \/ kunden {2}->.*\[Basic Auth\]/);
  assert.match(stdout.text(), new RegExp(`lauscht auf http://127\\.0\\.0\\.1:${address.port} `));
  assert.match(stdout.text(), new RegExp(`MCP-Endpunkt .*: http://127\\.0\\.0\\.1:${proxy.mcpServer.address().port}/mcp`));
  assert.notEqual(proxy.mcpServer.address().port, address.port);

  // Gleicher Service-Name, verschiedene Umgebungen: der Header wählt die Zugangsdaten.
  const call = (env, p, headers = {}) => request(address.port, { path: p, headers: { 'X-Proxy-Environment': env, 'X-Proxy-Service': 'kunden', ...headers } });
  await call('dev', '/a');
  await call('prod', '/b');
  await call('lokal', '/c', { Authorization: 'Bearer eigen' });
  await call('lokal', '/d');
  await call('prod', '/dev/kunden/e', { Authorization: 'Bearer eigen' });
  assert.deepEqual(seen, [
    { url: '/dev/a', auth: basic('dev-user', 'dev-geheim') },
    { url: '/prod/b', auth: basic('prod-override', 'prod-geheim') },
    { url: '/lokal/c', auth: 'Bearer eigen' },
    { url: '/lokal/d', auth: undefined },
    { url: '/prod/dev/kunden/e', auth: basic('prod-override', 'prod-geheim') },
  ]);

  const output = stdout.text() + stderr.text();
  for (const secret of [MASTER, 'dev-geheim', 'prod-geheim', basic('dev-user', 'dev-geheim')]) assert.ok(!output.includes(secret), 'kein Geheimnis in der Ausgabe');
});

test('--check prüft alles und beendet sich', async (t) => {
  const { configFile } = await fixture(t);
  const stdout = sink();
  const res = await main(['-c', configFile, '--check'], { stdout: stdout.stream, stderr: sink().stream, prompt: fakePrompt(MASTER) });
  assert.equal(res.exitCode, 0);
  assert.equal(res.proxy, undefined);
  assert.doesNotMatch(stdout.text(), /lauscht|MCP-Endpunkt/, '--check bindet keine Ports');
  assert.match(stdout.text(), /Konfiguration OK: 3 Umgebung\(en\), 3 Service\(s\), 2 Zugangsdaten/);
});

test('dreimal falsches Passwort → Exit-Code 1', async (t) => {
  const { configFile } = await fixture(t);
  const stderr = sink();
  const res = await main(['-c', configFile], { stdout: sink().stream, stderr: stderr.stream, prompt: fakePrompt('a', 'b', 'c') });
  assert.equal(res.exitCode, 1);
  assert.match(stderr.text(), /falsch/);
});

test('fehlende Datenbank wird gemeldet, bevor nach dem Passwort gefragt wird', async (t) => {
  const dir = await tempDir(t);
  const configFile = path.join(dir, 'c.json');
  await writeFile(configFile, JSON.stringify({ keepass: { database: 'fehlt.kdbx' }, environments: { e: { s: { url: 'http://x', auth: { entry: { title: 't' } } } } } }));
  let asked = false;
  const stderr = sink();
  const res = await main(['-c', configFile], { stdout: sink().stream, stderr: stderr.stream, prompt: async () => ((asked = true), Buffer.from('x')) });
  assert.equal(res.exitCode, 1);
  assert.equal(asked, false);
  assert.match(stderr.text(), /fehlt\.kdbx kann nicht gelesen werden: ENOENT/);
});

test('Konfiguration ohne auth benötigt kein Passwort', async (t) => {
  const dir = await tempDir(t);
  const configFile = path.join(dir, 'c.json');
  await writeFile(configFile, JSON.stringify({ environments: { e: { s: 'http://127.0.0.1:1' } } }));
  const res = await main(['-c', configFile, '--check'], { stdout: sink().stream, stderr: sink().stream, prompt: async () => assert.fail('kein Prompt erwartet') });
  assert.equal(res.exitCode, 0);
});

test('Passwörter als Argument werden abgelehnt, unbekannte Optionen ebenso', () => {
  for (const argv of [['--password', 'x'], ['--password=x'], ['-p', 'x'], ['--master-password', 'x'], ['--pw=x']]) {
    assert.throws(() => parseCli(argv), /nicht als Argument/, argv.join(' '));
  }
  assert.throws(() => parseCli(['--foo']), /Unknown option/);
  assert.equal(parseCli([]).config, 'connection.json');
});

test('headersFile wird relativ zur Konfigurationsdatei geladen und angehängt', async (t) => {
  const { configFile, seen } = await fixture(t, { headersFile: './conf/headers.json', headers: { 'X-Client-Name': 'ai-proxy' } });
  const stdout = sink();
  const { exitCode, proxy, address } = await main(['--config', configFile], { stdout: stdout.stream, stderr: sink().stream, prompt: fakePrompt(MASTER) });
  assert.equal(exitCode, 0);
  t.after(() => proxy.close());
  assert.match(stdout.text(), /Standard-Header aus .*headers\.json: X-Client-Name/);
  const route = { 'X-Proxy-Environment': 'lokal', 'X-Proxy-Service': 'kunden' };
  await request(address.port, { path: '/a', headers: route });
  await request(address.port, { path: '/b', headers: { ...route, 'x-client-name': 'eigener-client' } });
  assert.deepEqual(seen, [
    { url: '/lokal/a', auth: undefined, client: 'ai-proxy' },
    { url: '/lokal/b', auth: undefined, client: 'eigener-client' },
  ]);
});

test('leere Header-Datei {} ist erlaubt', async (t) => {
  const { configFile } = await fixture(t, { headersFile: 'conf/headers.json', headers: {} });
  const res = await main(['-c', configFile, '--check'], { stdout: sink().stream, stderr: sink().stream, prompt: fakePrompt(MASTER) });
  assert.equal(res.exitCode, 0);
});

test('fehlende oder ungültige Header-Datei → Abbruch vor Passwortabfrage und Listen', async (t) => {
  const cases = [
    [{ headersFile: './fehlt.json' }, /Header-Datei .*fehlt\.json kann nicht gelesen werden: ENOENT/],
    [{ headersFile: './conf/headers.json', headers: '{ kaputt' }, /kein gültiges JSON/],
    [{ headersFile: './conf/headers.json', headers: '["X-A"]' }, /muss ein JSON-Objekt/],
    [{ headersFile: './conf/headers.json', headers: { Authorization: 'Basic x' } }, /"Authorization": nicht erlaubt/],
    [{ headersFile: './conf/headers.json', headers: { 'X-A': 'a', 'x-a': 'b' } }, /"x-a": doppelt/],
  ];
  for (const [opts, re] of cases) {
    const { configFile } = await fixture(t, opts);
    const stderr = sink();
    const res = await main(['-c', configFile], { stdout: sink().stream, stderr: stderr.stream, prompt: async () => assert.fail('kein Prompt erwartet') });
    assert.equal(res.exitCode, 1, JSON.stringify(opts));
    assert.equal(res.proxy, undefined);
    assert.match(stderr.text(), re);
  }
});

/** Liefert einen gerade freien Port (kurz gebunden und wieder freigegeben). */
async function freePort(t) {
  const s = await listen(t, () => {});
  const { port } = s;
  s.server.closeAllConnections();
  await new Promise((r) => s.server.close(r));
  return port;
}

test('Start ist atomar: belegter MCP-Port → Exit 1, Proxy-Port wieder frei', async (t) => {
  const busy = (await listen(t, (req, res) => res.end())).port;
  const proxyPort = await freePort(t);
  const { configFile } = await fixture(t, { listen: { port: proxyPort, mcpPort: busy } });
  const stderr = sink();
  const res = await main(['-c', configFile], { stdout: sink().stream, stderr: stderr.stream, prompt: fakePrompt(MASTER) });
  assert.equal(res.exitCode, 1);
  assert.equal(res.proxy, undefined);
  assert.match(stderr.text(), new RegExp(`MCP-Port 127\\.0\\.0\\.1:${busy} kann nicht geöffnet werden \\(EADDRINUSE\\)`));
  // Der bereits gebundene Proxy-Port wurde zurückgegeben.
  await assert.rejects(request(proxyPort, { path: '/' }), (err) => err.code === 'ECONNREFUSED');
});

test('Start ist atomar: belegter Proxy-Port → Exit 1, MCP wird nicht gebunden', async (t) => {
  const busy = (await listen(t, (req, res) => res.end())).port;
  const mcpPort = await freePort(t);
  const { configFile } = await fixture(t, { listen: { port: busy, mcpPort } });
  const stderr = sink();
  const res = await main(['-c', configFile], { stdout: sink().stream, stderr: stderr.stream, prompt: fakePrompt(MASTER) });
  assert.equal(res.exitCode, 1);
  assert.match(stderr.text(), new RegExp(`Proxy-Port 127\\.0\\.0\\.1:${busy} kann nicht geöffnet werden \\(EADDRINUSE\\)`));
  await assert.rejects(request(mcpPort, { path: '/mcp' }), (err) => err.code === 'ECONNREFUSED');
});

test('mcp: false startet nur den Proxy-Listener', async (t) => {
  const dir = await tempDir(t);
  const configFile = path.join(dir, 'c.json');
  await writeFile(configFile, JSON.stringify({ listen: { port: 0, mcpPort: 0 }, mcp: false, environments: { e: { s: 'http://127.0.0.1:1' } } }));
  const stdout = sink();
  const { exitCode, proxy, mcpAddress } = await main(['-c', configFile], { stdout: stdout.stream, stderr: sink().stream });
  assert.equal(exitCode, 0);
  t.after(() => proxy.close());
  assert.equal(proxy.mcpServer, null);
  assert.equal(mcpAddress, null);
  assert.doesNotMatch(stdout.text(), /MCP-Endpunkt/);
});
