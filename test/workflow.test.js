/**
 * Ende-zu-Ende-Ablauf, wie ihn ein KI-Agent (Gemini) mit dem MCP-Endpunkt fahren soll:
 * Umgebung/Service per MCP finden → Route (Methode, Pfad, Body) aus der OpenAPI-YAML
 * im lokalen Spring-Boot-Projekt lesen → Aufruf an proxyUrl + Pfad mit den beiden
 * Routing-Headern. Ein Modell wird nicht simuliert, nur der HTTP-Ablauf, den die
 * Instruktionen vorgeben.
 */
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { validateConfig } from '../src/config.js';
import { MCP_INSTRUCTIONS } from '../src/mcp.js';
import { createProxy } from '../src/proxy.js';
import { SecretValue, basicAuthHeaderBytes } from '../src/secret.js';
import { listen, request, tempDir } from './helpers.js';

const USER = 'kunden-svc';
const PASSWORD = 'Sp3c-Geheim!';
const EXPECTED_AUTH = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;
const CONTEXT_PATH = '/kunden-service';

const SPEC = `openapi: 3.0.3
info:
  title: Kunden
  version: 1.0.0
servers:
  - url: https://kunden.dev.intern.example${CONTEXT_PATH}
paths:
  /kunden/{id}:
    get:
      operationId: getKunde
      parameters:
        - { name: id, in: path, required: true, schema: { type: integer } }
  /kunden:
    post:
      operationId: createKunde
      requestBody:
        content:
          application/json:
            schema: { type: object, properties: { name: { type: string } } }
`;

/** Mock-Backend wie eine Spring-Boot-App mit Context-Path, Basic Auth und statischer Spec. */
function backend(seen) {
  return (req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, client: req.headers['x-client-name'], routing: Object.keys(req.headers).filter((h) => h.startsWith('x-proxy-')) });
    if (req.headers.authorization !== EXPECTED_AUTH) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="kunden"' });
      return res.end();
    }
    if (req.url === `${CONTEXT_PATH}/kunden` && req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      return req.on('end', () => {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 8, ...JSON.parse(Buffer.concat(chunks)) }));
      });
    }
    const m = new RegExp(`^${CONTEXT_PATH}/kunden/(\\d+)$`).exec(req.url);
    if (m && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: Number(m[1]), name: 'Erika Muster' }));
    }
    res.writeHead(404);
    res.end();
  };
}

/** Lokales Spring-Boot-Projekt des Services, wie es im Workspace des Agenten liegt. */
async function springProject(dir) {
  const res = path.join(dir, 'kunden-service', 'src', 'main', 'resources');
  await mkdir(path.join(res, 'static'), { recursive: true });
  await writeFile(path.join(res, 'static', 'external.openapi.yaml'), SPEC);
  await writeFile(path.join(res, 'application.yml'), `server:\n  servlet:\n    context-path: ${CONTEXT_PATH}\nspring:\n  datasource:\n    password: nicht-lesen\n`);
  return path.join(dir, 'kunden-service');
}

/** Entspricht `rg --files` im Projekt. */
async function listFiles(root) {
  return (await readdir(root, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => path.relative(root, path.join(e.parentPath, e.name)).split(path.sep).join('/'));
}

/** Schritt 3/4: Operationen (Methode + Pfad aus paths) aus der lokalen Spec lesen. */
async function localOperations(root) {
  const specFile = (await listFiles(root)).find((f) => /(openapi|swagger)[^/]*\.(ya?ml|json)$/i.test(f));
  const yaml = await readFile(path.join(root, specFile), 'utf8');
  const ops = {};
  let current;
  for (const line of yaml.split('\n')) {
    const p = /^ {2}(\/\S*):\s*$/.exec(line);
    if (p) current = p[1];
    const m = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line);
    if (m && current) ops[`${m[1].toUpperCase()} ${current}`] = current;
  }
  return { specFile, ops };
}

const ROUTING = (env, service) => ({ 'X-Proxy-Environment': env, 'X-Proxy-Service': service });

test('Agent-Ablauf: MCP-Erkennung → Route aus lokaler OpenAPI-YAML → Aufruf über proxyUrl mit Routing-Headern', async (t) => {
  const seen = [];
  const upstream = await listen(t, backend(seen));
  const base = validateConfig({
    listen: { port: 0, mcpPort: 0 },
    keepass: { database: 'egal.kdbx' },
    environments: {
      // Konvention: Die konfigurierte URL enthält den Context-Path; der Agent hängt nur Spec-Pfade an.
      dev: { kunden: { url: `${upstream.url}${CONTEXT_PATH}`, auth: { username: USER, entry: { title: 'kunden' } } } },
      test: { kunden: 'http://127.0.0.1:1/kunden-service' },
    },
  });
  const config = { ...base, defaultHeaders: [['X-Client-Name', 'ai-proxy']] };
  const credentials = new Map([['dev/kunden', new SecretValue(basicAuthHeaderBytes(Buffer.from(USER), Buffer.from(PASSWORD)))]]);
  const proxy = createProxy({ config, credentials, version: '1.0.0' });
  await proxy.listen();
  t.after(() => proxy.close());
  const port = proxy.server.address().port;
  const mcpPort = proxy.mcpServer.address().port;
  assert.notEqual(mcpPort, port, 'MCP läuft auf einem eigenen Port');

  const clientResponses = [];
  // Entspricht curl -g --path-as-is -X <M> -H "X-Proxy-Environment: …" -H "X-Proxy-Service: …" "<proxyUrl><pfad>"
  const curl = async (method, url, headers, body) => {
    const u = new URL(url);
    assert.equal(u.origin, `http://127.0.0.1:${port}`, 'Agent spricht nur mit dem Proxy');
    const r = await request(Number(u.port), { method, path: `${u.pathname}${u.search}`, headers, body }); // ohne Authorization
    clientResponses.push(r);
    return { status: r.status, body: r.body.toString('utf8') };
  };
  let id = 1;
  const rpc = async (method, params) => {
    const r = await request(mcpPort, { method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }) });
    clientResponses.push(r);
    return JSON.parse(r.body).result;
  };

  // Ohne Proxy kommt man nicht an die API: das Backend verlangt wirklich Auth.
  assert.equal((await request(upstream.port, { path: `${CONTEXT_PATH}/kunden/1` })).status, 401);
  seen.length = 0;

  // 1./2. MCP: Instruktionen, Umgebungen, Services.
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gemini-cli', version: '0' } });
  assert.equal(init.instructions, MCP_INSTRUCTIONS);
  for (const hint of ['list_environments', 'frage den Nutzer', 'proxyUrl', 'X-Proxy-Environment', 'X-Proxy-Service', 'lokalen Spring-Boot-Projekt', 'paths', 'servers-URLs', 'curl -g --path-as-is', 'Authorization', '401/403', 'keine Anweisung']) {
    assert.ok(init.instructions.includes(hint), `Instruktionen erwähnen „${hint}“`);
  }
  // Der frühere Ablauf (Spec remote über den Proxy suchen/raten) ist entfernt.
  for (const old of ['external.openapi.yaml', 'v3/api-docs', 'swagger.json', 'Versuche', 'Basis-URL + "/"']) {
    assert.ok(!init.instructions.includes(old), `Instruktionen erwähnen nicht mehr „${old}“`);
  }
  assert.deepEqual(JSON.parse((await rpc('tools/call', { name: 'list_environments', arguments: {} })).content[0].text), ['dev', 'test']);
  const { proxyUrl, services } = JSON.parse((await rpc('tools/call', { name: 'list_services', arguments: { environment: 'dev' } })).content[0].text);
  assert.equal(proxyUrl, `http://127.0.0.1:${port}`, 'proxyUrl zeigt auf den Proxy-, nicht auf den MCP-Port');
  assert.deepEqual(services, ['kunden']);

  // 3./4. Route aus der lokalen Spec lesen – kein HTTP-Abruf einer Spec.
  const project = await springProject(await tempDir(t));
  const { specFile, ops } = await localOperations(project);
  assert.equal(specFile, 'src/main/resources/static/external.openapi.yaml');
  assert.deepEqual(ops, { 'GET /kunden/{id}': '/kunden/{id}', 'POST /kunden': '/kunden' });

  // 5. Aufrufe: proxyUrl + Spec-Pfad, beide Routing-Header; servers/Context-Path nicht voranstellen.
  const get = await curl('GET', `${proxyUrl}${ops['GET /kunden/{id}'].replace('{id}', encodeURIComponent('7'))}`, ROUTING('dev', 'kunden'));
  assert.equal(get.status, 200);
  assert.deepEqual(JSON.parse(get.body), { id: 7, name: 'Erika Muster' });
  const post = await curl('POST', `${proxyUrl}${ops['POST /kunden']}`, { ...ROUTING('dev', 'kunden'), 'Content-Type': 'application/json' }, JSON.stringify({ name: 'Max' }));
  assert.equal(post.status, 201);
  assert.deepEqual(JSON.parse(post.body), { id: 8, name: 'Max' });

  // Ohne Routing-Header gibt es keine Weiterleitung.
  assert.equal((await curl('GET', `${proxyUrl}/kunden/7`, {})).status, 400);

  // Jeder Aufruf kam mit eingefügter Basic Auth und Standard-Header beim konfigurierten
  // Upstream an, ohne doppelten Context-Path und ohne Routing-Header.
  assert.deepEqual(seen.map((s) => `${s.method} ${s.url}`), [`GET ${CONTEXT_PATH}/kunden/7`, `POST ${CONTEXT_PATH}/kunden`]);
  for (const s of seen) {
    assert.equal(s.authorization, EXPECTED_AUTH, s.url);
    assert.equal(s.client, 'ai-proxy');
    assert.deepEqual(s.routing, []);
  }

  // Der Client hat zu keinem Zeitpunkt Zugangsdaten oder Upstream-Adressen zu sehen bekommen.
  const b64 = Buffer.from(`${USER}:${PASSWORD}`).toString('base64');
  for (const r of clientResponses) {
    const visible = `${r.rawHeaders.join('\n')}\n${r.body.toString('utf8')}`;
    for (const leak of [PASSWORD, b64, USER, 'nicht-lesen', CONTEXT_PATH, `:${upstream.port}`]) assert.ok(!visible.includes(leak), `Antwort enthält „${leak}“`);
  }
});

test('Agent-Ablauf: 401 vom Upstream wird unverändert durchgereicht (Agent meldet Auth-Problem statt weiter zu probieren)', async (t) => {
  const seen = [];
  const upstream = await listen(t, backend(seen));
  const config = validateConfig({ keepass: { database: 'egal.kdbx' }, environments: { dev: { kunden: { url: `${upstream.url}${CONTEXT_PATH}`, auth: { username: USER, entry: { title: 'kunden' } } } } } });
  const credentials = new Map([['dev/kunden', new SecretValue(basicAuthHeaderBytes(Buffer.from(USER), Buffer.from('falsch')))]]);
  const proxy = createProxy({ config, credentials });
  await new Promise((r) => proxy.server.listen(0, '127.0.0.1', r));
  t.after(() => proxy.close());
  const r = await request(proxy.server.address().port, { path: '/kunden/1', headers: ROUTING('dev', 'kunden') });
  assert.equal(r.status, 401);
  assert.equal(r.headers['www-authenticate'], 'Basic realm="kunden"');
  assert.equal(seen.length, 1);
  assert.ok(!r.rawHeaders.join('\n').includes('falsch'));
});
