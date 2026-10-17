import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateConfig } from '../src/config.js';
import { MCP_INSTRUCTIONS } from '../src/mcp.js';
import { advertisedBaseUrl, allowedHostValues, createProxy } from '../src/proxy.js';
import { SecretValue, basicAuthHeaderBytes } from '../src/secret.js';
import { listen, request } from './helpers.js';

const RAW_CONFIG = {
  keepass: { database: 'egal.kdbx' },
  environments: {
    dev: {
      orders: { url: 'https://orders.dev.intern.example/api', auth: { username: 'geheimer-user', entry: { group: 'Dev', title: 'orders' } } },
      katalog: 'http://localhost:9100/katalog',
    },
    'qa-2': { orders: 'https://orders.qa.intern.example' },
    prod: { billing: { url: 'https://billing.intern.example', auth: { entry: { uuid: '3F2504E04F8911D39A0C0305E82C3301' } } } },
  },
};

/** Startet Proxy- und MCP-Listener auf freien Ports. `port` ist der MCP-Port, `proxyPort` der API-Port. */
async function startProxy(t, raw = RAW_CONFIG) {
  const config = validateConfig({ ...raw, listen: { ...raw.listen, port: 0, mcpPort: 0 } });
  const credentials = new Map();
  for (const env of config.environments) {
    for (const svc of env.services) {
      if (svc.auth) credentials.set(`${env.name}/${svc.name}`, new SecretValue(basicAuthHeaderBytes(Buffer.from('geheimer-user'), Buffer.from('SuperGeheim!'))));
    }
  }
  const proxy = createProxy({ config, credentials, version: '9.9.9' });
  await proxy.listen();
  t.after(() => proxy.close());
  return { config, proxy, port: proxy.mcpServer?.address().port, proxyPort: proxy.server.address().port };
}

const ACCEPT = 'application/json, text/event-stream';
let nextId = 1;
async function rpc(port, method, params, headers = {}) {
  const msg = { jsonrpc: '2.0', id: nextId++, method, ...(params !== undefined ? { params } : {}) };
  const r = await request(port, { method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json', Accept: ACCEPT, ...headers }, body: JSON.stringify(msg) });
  return { ...r, json: r.body.length ? JSON.parse(r.body) : null, id: msg.id };
}

test('initialize handelt die Protokollversion aus', async (t) => {
  const { port } = await startProxy(t);
  for (const [requested, expected] of [['2025-06-18', '2025-06-18'], ['2025-03-26', '2025-03-26'], ['2025-11-25', '2025-11-25'], ['1999-01-01', '2025-11-25']]) {
    const r = await rpc(port, 'initialize', { protocolVersion: requested, capabilities: {}, clientInfo: { name: 'gemini-cli-mcp-client', version: '0' } });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^application\/json/);
    assert.equal(r.json.id, r.id);
    assert.deepEqual(r.json.result, { protocolVersion: expected, capabilities: { tools: {} }, serverInfo: { name: 'ai-proxy', version: '9.9.9' }, instructions: MCP_INSTRUCTIONS });
  }
});

test('notifications/initialized → 202 ohne Body; ping', async (t) => {
  const { port } = await startProxy(t);
  const r = await request(port, { method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json', Accept: ACCEPT }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(r.status, 202);
  assert.equal(r.body.length, 0);
  assert.deepEqual((await rpc(port, 'ping')).json.result, {});
});

test('tools/list: genau list_environments und list_services, Schema aus connection.json abgeleitet', async (t) => {
  const { port } = await startProxy(t);
  const r = await rpc(port, 'tools/list', {}, { 'MCP-Protocol-Version': '2025-06-18' });
  const tools = r.json.result.tools;
  assert.deepEqual(tools.map((x) => x.name), ['list_environments', 'list_services']);
  const [envTool, svcTool] = tools;
  assert.deepEqual(envTool.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
  assert.deepEqual(svcTool.inputSchema, {
    type: 'object',
    properties: { environment: { type: 'string', enum: ['dev', 'qa-2', 'prod'] } },
    required: ['environment'],
    additionalProperties: false,
  });
  for (const tool of tools) assert.equal(typeof tool.description, 'string');
});

test('tools/call list_environments liefert die Umgebungen aus der geladenen Konfiguration', async (t) => {
  const { port, config } = await startProxy(t);
  const r = await rpc(port, 'tools/call', { name: 'list_environments', arguments: {} });
  assert.equal(r.json.result.isError, undefined);
  assert.deepEqual(r.json.result.content, [{ type: 'text', text: '["dev","qa-2","prod"]' }]);
  assert.deepEqual(JSON.parse(r.json.result.content[0].text), config.environments.map((e) => e.name));

  // Andere Konfiguration → andere Antwort (nichts fest verdrahtet).
  const other = await startProxy(t, { environments: { alpha: { s: 'http://x' }, beta: { s: 'http://y' } } });
  const r2 = await rpc(other.port, 'tools/call', { name: 'list_environments' });
  assert.equal(r2.json.result.content[0].text, '["alpha","beta"]');
  const list = await rpc(other.port, 'tools/list');
  assert.deepEqual(list.json.result.tools[1].inputSchema.properties.environment.enum, ['alpha', 'beta']);
});

test('tools/call list_services liefert kompakt {proxyUrl, services}', async (t) => {
  const { port, proxyPort } = await startProxy(t);
  assert.notEqual(port, proxyPort);
  const r = await rpc(port, 'tools/call', { name: 'list_services', arguments: { environment: 'dev' } });
  const { result } = r.json;
  assert.equal(result.isError, undefined);
  assert.equal(result.content.length, 1);
  const text = result.content[0].text;
  // proxyUrl ist der Proxy-Listener, nicht der MCP-Listener, über den gefragt wurde.
  assert.equal(text, `{"proxyUrl":"http://127.0.0.1:${proxyPort}","services":["orders","katalog"]}`);
  // Nichts außer Namen und Proxy-URLs: keine Upstreams, Benutzer, KeePass-Verweise, Passwörter.
  const whole = r.body.toString();
  for (const leak of ['intern.example', 'localhost:9100', 'geheimer-user', 'SuperGeheim', 'Basic', 'Dev', 'keepass', 'egal.kdbx', 'uuid']) {
    assert.ok(!whole.includes(leak), `Antwort enthält „${leak}“`);
  }

  const qa = await rpc(port, 'tools/call', { name: 'list_services', arguments: { environment: 'qa-2' } });
  assert.equal(qa.json.result.content[0].text, `{"proxyUrl":"http://127.0.0.1:${proxyPort}","services":["orders"]}`);
});

test('proxyUrl + Routing-Header aus list_services ergeben eine funktionierende Route', async (t) => {
  const { port, proxyPort } = await startProxy(t, { environments: { dev: { tot: 'http://127.0.0.1:1/x' } } });
  const r = await rpc(port, 'tools/call', { name: 'list_services', arguments: { environment: 'dev' } });
  const { proxyUrl, services } = JSON.parse(r.json.result.content[0].text);
  const url = new URL(`${proxyUrl}/health`);
  assert.equal(Number(url.port), proxyPort);
  const res = await request(Number(url.port), { path: url.pathname, headers: { 'X-Proxy-Environment': 'dev', 'X-Proxy-Service': services[0] } });
  assert.equal(res.status, 502, 'Route existiert (Upstream absichtlich nicht erreichbar)');
});

test('getrennte Listener: MCP nur am MCP-Port, Weiterleitung nur am Proxy-Port (auch für /mcp)', async (t) => {
  const seen = [];
  const upstream = await listen(t, (req, res) => {
    seen.push({ method: req.method, url: req.url, env: req.headers['x-proxy-environment'] });
    res.end('vom-service');
  });
  const { port, proxyPort } = await startProxy(t, { environments: { dev: { api: `${upstream.url}/base` } } });
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
  const headers = { 'Content-Type': 'application/json', Accept: ACCEPT };
  const route = { 'X-Proxy-Environment': 'dev', 'X-Proxy-Service': 'api' };

  // MCP-Port: /mcp ist MCP.
  const mcp = await request(port, { method: 'POST', path: '/mcp', headers, body });
  assert.equal(mcp.status, 200);
  assert.deepEqual(JSON.parse(mcp.body).result, {});

  // MCP-Port leitet nie weiter – weder /mcp noch andere Pfade, auch nicht mit Routing-Headern.
  for (const [path, h, status] of [['/mcp', route, 400], ['/mcp?x=1', route, 400], ['/mcp', { 'X-Proxy-Environment': 'dev' }, 400], ['/v1/kunden', route, 404], ['/v1/kunden', {}, 404], ['/', route, 404]]) {
    const r = await request(port, { method: 'POST', path, headers: { ...headers, ...h }, body });
    assert.equal(r.status, status, `MCP-Port ${path} ${JSON.stringify(h)}`);
    assert.equal(r.headers['x-proxy-error'], '1');
    assert.match(r.body.toString(), new RegExp(`http://127\\.0\\.0\\.1:${proxyPort}`), 'Hinweis auf den Proxy-Port');
  }
  assert.equal(seen.length, 0);

  // Proxy-Port: /mcp ohne Routing-Header ist kein MCP-Endpunkt, sondern ein 400.
  const noMcp = await request(proxyPort, { method: 'POST', path: '/mcp', headers, body });
  assert.equal(noMcp.status, 400);
  assert.equal(noMcp.headers['x-proxy-error'], '1');
  assert.match(noMcp.body.toString(), /X-Proxy-Environment/);

  // Proxy-Port: /mcp mit Routing-Headern ist ein normaler Service-Pfad.
  const routed = await request(proxyPort, { method: 'POST', path: '/mcp?x=1', headers: { ...headers, ...route }, body });
  assert.equal(routed.status, 200);
  assert.equal(routed.body.toString(), 'vom-service');
  assert.deepEqual(seen, [{ method: 'POST', url: '/base/mcp?x=1', env: undefined }]);

  // Nur einer der beiden Header: weder MCP noch Weiterleitung.
  for (const one of [{ 'X-Proxy-Environment': 'dev' }, { 'x-proxy-service': 'api' }]) {
    const r = await request(proxyPort, { method: 'POST', path: '/mcp', headers: { ...headers, ...one }, body });
    assert.equal(r.status, 400, JSON.stringify(one));
    assert.equal(r.headers['x-proxy-error'], '1');
  }
  assert.equal(seen.length, 1);
});

test('unbekannte Umgebung, fehlendes Argument und unbekanntes Tool', async (t) => {
  const { port } = await startProxy(t);
  const unknown = await rpc(port, 'tools/call', { name: 'list_services', arguments: { environment: 'staging' } });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.json.result.isError, true);
  assert.equal(unknown.json.result.content[0].text, 'Unbekannte Umgebung "staging". Verfügbar: dev, qa-2, prod');

  const missing = await rpc(port, 'tools/call', { name: 'list_services', arguments: {} });
  assert.equal(missing.json.result.isError, true);

  const tool = await rpc(port, 'tools/call', { name: 'gibt_es_nicht', arguments: {} });
  assert.equal(tool.json.error.code, -32602);

  const method = await rpc(port, 'resources/list');
  assert.equal(method.json.error.code, -32601);
});

test('Transport: GET/DELETE → 405, kaputtes JSON → 400, falsche Protokollversion → 400', async (t) => {
  const { port } = await startProxy(t);
  for (const method of ['GET', 'DELETE']) {
    const r = await request(port, { method, path: '/mcp', headers: { Accept: 'text/event-stream' } });
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.allow, 'POST');
  }
  const bad = await request(port, { method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json', Accept: ACCEPT }, body: '{nope' });
  assert.equal(bad.status, 400);
  assert.equal(JSON.parse(bad.body).error.code, -32700);
  const batch = await request(port, { method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json' }, body: '[]' });
  assert.equal(batch.status, 400);
  const pv = await rpc(port, 'ping', undefined, { 'MCP-Protocol-Version': '2024-01-01' });
  assert.equal(pv.status, 400);
});

test('Host- und Origin-Prüfung ist exakt (Schutz vor DNS-Rebinding und Cross-Origin)', async (t) => {
  const { port, proxyPort } = await startProxy(t, { listen: { allowedOrigins: ['http://localhost:3000'] }, environments: { dev: { s: 'http://127.0.0.1:1' } } });
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
  const post = (headers, path = '/mcp') => request(port, { method: 'POST', path, headers: { 'Content-Type': 'application/json', Accept: ACCEPT, ...headers }, body });

  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`, `[::1]:${port}`]) {
    assert.equal((await post({ Host: host })).status, 200, host);
  }
  // Jeder Listener prüft gegen seinen eigenen Port: der Host des Proxy-Ports gilt am MCP-Port nicht.
  for (const host of [`evil.example:${port}`, `127.0.0.1.evil.example:${port}`, `localhost.evil.example:${port}`, `127.0.0.1:${port}.evil`, `127.0.0.1:${proxyPort}`, `localhost:${proxyPort}`, '127.0.0.1', 'localhost']) {
    const r = await post({ Host: host });
    assert.equal(r.status, 403, host);
    assert.equal(JSON.parse(r.body).id, undefined, 'JSON-RPC-Fehler ohne id');
  }
  assert.equal((await post({ Origin: `http://127.0.0.1:${port}` })).status, 200);
  assert.equal((await post({ Origin: 'http://localhost:3000' })).status, 200);
  for (const origin of ['https://evil.example', `http://127.0.0.1:${port}.evil.example`, 'http://localhost:30000', 'null', `https://127.0.0.1:${port}`, `http://127.0.0.1:${proxyPort}`]) {
    assert.equal((await post({ Origin: origin })).status, 403, origin);
  }
  // Gilt auch für den Proxy-Port (dort würde sonst Basic Auth eingefügt), dort gegen dessen Port.
  const route = { 'X-Proxy-Environment': 'dev', 'X-Proxy-Service': 's' };
  const api = (headers) => request(proxyPort, { path: '/x', headers: { ...route, ...headers } });
  for (const host of [`127.0.0.1:${proxyPort}`, `localhost:${proxyPort}`, `[::1]:${proxyPort}`]) assert.equal((await api({ Host: host })).status, 502, host);
  for (const host of [`evil.example:${proxyPort}`, `127.0.0.1:${port}`, `localhost:${port}`]) assert.equal((await api({ Host: host })).status, 403, host);
  assert.equal((await api({ Origin: `http://127.0.0.1:${proxyPort}` })).status, 502);
  assert.equal((await api({ Origin: 'http://localhost:3000' })).status, 502);
  for (const origin of ['https://evil.example', `http://127.0.0.1:${port}`]) assert.equal((await api({ Origin: origin })).status, 403, origin);
});

test('mcp: false deaktiviert den MCP-Listener (/mcp am Proxy-Port ohne Routing-Header → 400)', async (t) => {
  const { proxy, port, proxyPort } = await startProxy(t, { mcp: false, environments: { dev: { s: 'http://127.0.0.1:1' } } });
  assert.equal(proxy.mcpServer, null);
  assert.equal(port, undefined);
  const r = await request(proxyPort, { method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
  assert.equal(r.status, 400);
  assert.equal(r.headers['x-proxy-error'], '1');
  assert.match(r.body.toString(), /X-Proxy-Environment/);
});

test('allowedHostValues / advertisedBaseUrl', () => {
  assert.deepEqual([...allowedHostValues('127.0.0.1', 8075)].sort(), ['127.0.0.1:8075', '[::1]:8075', 'localhost:8075']);
  assert.deepEqual([...allowedHostValues('127.0.0.1', 8076)].sort(), ['127.0.0.1:8076', '[::1]:8076', 'localhost:8076']);
  assert.deepEqual([...allowedHostValues('192.168.1.5', 8080, ['proxy.lan:8080'])].sort(), ['192.168.1.5:8080', 'proxy.lan:8080']);
  assert.ok(allowedHostValues('localhost', 80).has('localhost'));
  assert.equal(advertisedBaseUrl('127.0.0.1', 8080), 'http://127.0.0.1:8080');
  assert.equal(advertisedBaseUrl('0.0.0.0', 8080), 'http://127.0.0.1:8080');
  assert.equal(advertisedBaseUrl('::', 8080), 'http://[::1]:8080');
  assert.equal(advertisedBaseUrl('localhost', 8080), 'http://localhost:8080');
});

test('Service namens „__proto__“ geht in der Antwort nicht verloren', async (t) => {
  // Wie beim Laden von connection.json: JSON.parse legt „__proto__“ als eigenen Schlüssel an.
  const raw = JSON.parse('{"environments":{"dev":{"__proto__":"http://127.0.0.1:1/a","normal":"http://127.0.0.1:1/b"}}}');
  const { port, proxyPort } = await startProxy(t, raw);
  assert.equal((await request(proxyPort, { path: '/x', headers: { 'X-Proxy-Environment': 'dev', 'X-Proxy-Service': '__proto__' } })).status, 502, 'Route existiert');
  assert.equal((await request(proxyPort, { path: '/x', headers: { 'X-Proxy-Environment': 'dev', 'X-Proxy-Service': 'constructor' } })).status, 404);
  const r = await rpc(port, 'tools/call', { name: 'list_services', arguments: { environment: 'dev' } });
  const text = r.json.result.content[0].text;
  assert.equal(text, `{"proxyUrl":"http://127.0.0.1:${proxyPort}","services":["__proto__","normal"]}`);
});

test('strikte Tool-Argumente', async (t) => {
  const { port } = await startProxy(t);
  const extra = await rpc(port, 'tools/call', { name: 'list_services', arguments: { environment: 'dev', debug: true } });
  assert.equal(extra.json.result.isError, true);
  assert.match(extra.json.result.content[0].text, /Unbekannte Parameter: debug/);
  const extraEnv = await rpc(port, 'tools/call', { name: 'list_environments', arguments: { x: 1 } });
  assert.equal(extraEnv.json.result.isError, true);
  const notObject = await rpc(port, 'tools/call', { name: 'list_services', arguments: 'dev' });
  assert.equal(notObject.json.result.isError, true);
  const nonStringEnv = await rpc(port, 'tools/call', { name: 'list_services', arguments: { environment: ['dev'] } });
  assert.equal(nonStringEnv.json.result.isError, true);
  const noName = await rpc(port, 'tools/call', { arguments: {} });
  assert.equal(noName.json.error.code, -32602);
  const badParams = await rpc(port, 'tools/list', [1, 2]);
  assert.equal(badParams.json.error.code, -32602);
});

test('fehlerhafte JSON-RPC-Nachrichten → 400 mit id:null bzw. der gesendeten id', async (t) => {
  const { port } = await startProxy(t);
  const post = (body) => request(port, { method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json', Accept: ACCEPT }, body });
  const cases = [
    ['{nope', null, -32700],
    ['[]', null, -32600],
    ['"text"', null, -32600],
    ['{"id":1,"method":"ping"}', 1, -32600], // jsonrpc fehlt
    ['{"jsonrpc":"2.0","id":7,"method":42}', 7, -32600],
    ['{"jsonrpc":"2.0","id":null,"method":"ping"}', null, -32600],
    ['{"jsonrpc":"2.0","id":{},"method":"ping"}', null, -32600],
    ['{"jsonrpc":"2.0","id":3}', 3, -32600], // weder method noch result/error
  ];
  for (const [body, id, code] of cases) {
    const r = await post(body);
    assert.equal(r.status, 400, body);
    const json = JSON.parse(r.body);
    assert.ok('id' in json, `${body}: id vorhanden`);
    assert.equal(json.id, id, body);
    assert.equal(json.error.code, code, body);
  }
  // Antworten des Clients werden angenommen.
  assert.equal((await post('{"jsonrpc":"2.0","id":5,"result":{}}')).status, 202);
});

test('listen() bindet beide Listener; close() schließt beide', async (t) => {
  const { proxy, port, proxyPort } = await startProxy(t);
  assert.equal(proxy.server.listening, true);
  assert.equal(proxy.mcpServer.listening, true);
  const secret = proxy.routes.get('dev').get('orders').secret;
  await proxy.close();
  assert.equal(proxy.server.listening, false);
  assert.equal(proxy.mcpServer.listening, false);
  assert.equal(secret.disposed, true);
  for (const p of [port, proxyPort]) await assert.rejects(request(p, { path: '/mcp' }), (err) => err.code === 'ECONNREFUSED', String(p));
});

test('close() funktioniert auch, wenn nie gelauscht wurde', async () => {
  const proxy = createProxy({ config: validateConfig({ environments: { dev: { s: 'http://127.0.0.1:1' } } }) });
  assert.ok(proxy.mcpServer);
  await proxy.close();
  assert.equal(proxy.server.listening, false);
  assert.equal(proxy.mcpServer.listening, false);
});

/** Belegt einen freien Port, damit listen() dort scheitert. */
async function occupy(t) {
  const blocker = await listen(t, (req, res) => res.end());
  return blocker.port;
}

test('listen(): ist der MCP-Port belegt, wird der Proxy-Listener zurückgerollt', async (t) => {
  const busy = await occupy(t);
  const config = validateConfig({ ...RAW_CONFIG, listen: { port: 0, mcpPort: busy } });
  const credentials = new Map([...['dev/orders', 'prod/billing']].map((k) => [k, new SecretValue(Buffer.from('Basic eA=='))]));
  const proxy = createProxy({ config, credentials });
  await assert.rejects(proxy.listen(), (err) => err.code === 'EADDRINUSE' && err.listener === 'mcp' && err.port === busy);
  assert.equal(proxy.server.listening, false, 'Proxy-Listener wieder geschlossen');
  assert.equal(proxy.mcpServer.listening, false);
  await proxy.close();
  assert.equal(credentials.get('dev/orders').disposed, true);
});

test('listen(): ist der Proxy-Port belegt, wird der MCP-Listener gar nicht erst gebunden', async (t) => {
  const busy = await occupy(t);
  const proxy = createProxy({ config: validateConfig({ listen: { port: busy, mcpPort: 0 }, environments: { dev: { s: 'http://127.0.0.1:1' } } }) });
  await assert.rejects(proxy.listen(), (err) => err.code === 'EADDRINUSE' && err.listener === 'proxy' && err.port === busy);
  assert.equal(proxy.server.listening, false);
  assert.equal(proxy.mcpServer.listening, false);
  await proxy.close();
});
