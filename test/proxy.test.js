import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { test } from 'node:test';
import { validateConfig, validateDefaultHeaders } from '../src/config.js';
import { buildUpstreamHeaders, buildUpstreamPath, createProxy, isOriginForm, readRouting } from '../src/proxy.js';
import { SecretValue, basicAuthHeaderBytes } from '../src/secret.js';
import { listen, request } from './helpers.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`, 'utf8').toString('base64')}`;

test('readRouting: genau ein gültiger Wert je Header, Duplikate ohne Rücksicht auf Groß-/Kleinschreibung', () => {
  assert.deepEqual(readRouting(['X-Proxy-Environment', 'dev', 'x-proxy-service', 'kunden']), { present: true, env: 'dev', service: 'kunden' });
  assert.deepEqual(readRouting(['Accept', '*/*']), { present: false });
  const err = (raw) => readRouting(raw).error;
  assert.match(err(['X-Proxy-Environment', 'dev']), /X-Proxy-Service fehlt/);
  assert.match(err(['X-Proxy-Service', 'kunden']), /X-Proxy-Environment fehlt/);
  assert.match(err(['X-Proxy-Environment', 'dev', 'x-proxy-environment', 'dev', 'X-Proxy-Service', 'k']), /mehrfach/);
  assert.match(err(['X-Proxy-Environment', 'dev', 'X-PROXY-SERVICE', 'k', 'x-proxy-service', 'k']), /mehrfach/);
  for (const bad of ['', 'dev, test', 'a b', '.x', 'ä']) assert.match(err(['X-Proxy-Environment', bad, 'X-Proxy-Service', 'k']), /ungültigen Wert/, bad);
});

test('isOriginForm / buildUpstreamPath', () => {
  for (const ok of ['/', '/x?y=1', '/a/b%2Fc/../d', '/mcp', '/local/demo']) assert.equal(isOriginForm(ok), true, ok);
  for (const bad of ['*', 'http://evil/x', 'evil:80', '', '//evil/x', '/x#frag', undefined]) assert.equal(isOriginForm(bad), false, String(bad));
  assert.equal(buildUpstreamPath('/base', '/'), '/base/');
  assert.equal(buildUpstreamPath('/base', '/?a=1'), '/base/?a=1');
  assert.equal(buildUpstreamPath('/base', '/x/y?a=%2F'), '/base/x/y?a=%2F');
  assert.equal(buildUpstreamPath('', '/'), '/');
  assert.equal(buildUpstreamPath('', '/local/demo/x'), '/local/demo/x');
});

test('buildUpstreamHeaders: Vorrang, Connection-Benennung, Host und Auth zuletzt', () => {
  const defaults = [['X-Client-Name', 'ai-proxy'], ['X-Team', 'a'], ['Accept', 'application/json']];
  const out = buildUpstreamHeaders(
    ['host', 'proxy', 'x-team', 'b', 'Connection', 'X-Client-Name, Authorization, Host', 'X-Proxy-Environment', 'dev', 'X-Proxy-Service', 's', 'Authorization', 'Bearer x', 'Expect', '100-continue'],
    { hostHeader: 'up:1', defaultHeaders: defaults, authorization: 'Basic abc' },
  );
  assert.deepEqual(out, ['Host', 'up:1', 'Accept', 'application/json', 'x-team', 'b', 'Authorization', 'Basic abc']);
  const noAuth = buildUpstreamHeaders(['Authorization', 'Bearer x'], { hostHeader: 'up', defaultHeaders: defaults });
  assert.deepEqual(noAuth, ['Host', 'up', 'X-Client-Name', 'ai-proxy', 'X-Team', 'a', 'Accept', 'application/json', 'Authorization', 'Bearer x']);
});

test('SecretValue / basicAuthHeaderBytes', () => {
  const user = Buffer.from('bénutzer');
  for (const pw of ['', 'a', 'ab', 'abc', 'pässwört:mit:doppelpunkt', randomBytes(100).toString('latin1')]) {
    const header = basicAuthHeaderBytes(user, Buffer.from(pw, 'utf8'));
    assert.equal(header.toString('latin1'), basic('bénutzer', pw));
    const s = new SecretValue(header);
    header.fill(0);
    assert.equal(s.reveal(), basic('bénutzer', pw));
    s.dispose();
    assert.equal(s.disposed, true);
    assert.throws(() => s.reveal());
  }
});

/**
 * Startet Upstream + Proxy. Der Upstream-Handler kann pro Test gesetzt werden.
 */
async function setup(t, { handler, services, timeoutMs, defaultHeaders } = {}) {
  let current = handler;
  const upstream = await listen(t, (req, res) => current(req, res));
  const svcDefs = services?.(upstream.url) ?? {
    plain: `${upstream.url}/base/`,
    root: upstream.url,
    secured: { url: `${upstream.url}/sec`, auth: { username: 'svc', entry: { title: 'x' } } },
  };
  const base = validateConfig({ keepass: { database: 'egal.kdbx' }, upstream: { timeoutMs: timeoutMs ?? 5000 }, environments: { dev: svcDefs, test: { other: `${upstream.url}/other` } } });
  const config = defaultHeaders ? { ...base, defaultHeaders: validateDefaultHeaders(defaultHeaders) } : base;
  const credentials = new Map();
  for (const env of config.environments) {
    for (const svc of env.services) {
      if (svc.auth) credentials.set(`${env.name}/${svc.name}`, new SecretValue(basicAuthHeaderBytes(Buffer.from('svc'), Buffer.from('Gehe1m!'))));
    }
  }
  const logs = [];
  const proxy = createProxy({ config, credentials, log: (l) => logs.push(l) });
  await new Promise((r) => proxy.server.listen(0, '127.0.0.1', r));
  t.after(() => proxy.close());
  const port = proxy.server.address().port;
  /** Request mit Routing-Headern; `to` = "env/service". */
  const call = (to, opts = {}) => {
    const [env, service] = to.split('/');
    return request(port, { ...opts, headers: { 'X-Proxy-Environment': env, 'X-Proxy-Service': service, ...opts.headers } });
  };
  return { upstream, proxy, port, logs, call, setHandler: (h) => (current = h) };
}

const route = (to) => {
  const [env, service] = to.split('/');
  return { 'X-Proxy-Environment': env, 'X-Proxy-Service': service };
};

function echo(req, res) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const payload = Buffer.from(JSON.stringify({ method: req.method, url: req.url, rawHeaders: req.rawHeaders, headers: req.headers, bodyHash: sha(body), bodyLength: body.length }));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
    res.end(payload);
  });
}

test('der rohe Pfad samt Query wird unverändert an den Basis-Pfad gehängt', async (t) => {
  const { call } = await setup(t, { handler: echo });
  const cases = [
    ['dev/plain', '/', '/base/'],
    ['dev/plain', '/?x=1', '/base/?x=1'],
    ['dev/plain', '/a/b%2Fc/../d;m=1?x=1&y=%20&x=2', '/base/a/b%2Fc/../d;m=1?x=1&y=%20&x=2'],
    ['dev/root', '/', '/'],
    ['dev/root', '/v1/items?q=%C3%A4&q=a+b', '/v1/items?q=%C3%A4&q=a+b'],
    ['test/other', '/z', '/other/z'],
    // Kein Präfix-Stripping mehr: /dev/plain bzw. /local/demo sind ganz normale Pfade.
    ['dev/root', '/local/demo/x', '/local/demo/x'],
    ['dev/plain', '/dev/plain/x', '/base/dev/plain/x'],
    ['dev/root', '/mcp', '/mcp'],
  ];
  for (const [to, path, expected] of cases) {
    const r = await call(to, { path });
    assert.equal(r.status, 200, `${to} ${path}`);
    assert.equal(JSON.parse(r.body).url, expected, `${to} ${path}`);
  }
});

test('Routing-Header werden nie an den Upstream weitergereicht', async (t) => {
  const { call } = await setup(t, { handler: echo });
  const r = await call('dev/plain', { path: '/x', headers: { 'x-proxy-environment': 'dev', 'X-PROXY-SERVICE': 'plain' } });
  // Gleicher Name, andere Schreibweise überschreibt in node:http nur das Objekt – hier gibt es je einen.
  const seen = JSON.parse(r.body);
  assert.equal(r.status, 200);
  assert.ok(!seen.rawHeaders.some((h) => /^x-proxy-/i.test(h)), seen.rawHeaders.join(','));
});

test('fehlende, doppelte oder ungültige Routing-Header → 400, unbekannte → 404', async (t) => {
  let hits = 0;
  const { port } = await setup(t, { handler: (req, res) => (hits++, echo(req, res)) });
  const raw = (headers) => new Promise((resolve, reject) => {
    // Rohe Header-Liste, damit Duplikate wirklich doppelt gesendet werden.
    const req = http.request({ host: '127.0.0.1', port, path: '/x', agent: false, headers: ['Host', `127.0.0.1:${port}`, ...headers] });
    req.on('response', (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    });
    req.on('error', reject);
    req.end();
  });
  const cases = [
    [[], 400],
    [['X-Proxy-Environment', 'dev'], 400],
    [['X-Proxy-Service', 'plain'], 400],
    [['X-Proxy-Environment', 'dev', 'X-Proxy-Environment', 'dev', 'X-Proxy-Service', 'plain'], 400],
    [['X-Proxy-Environment', 'dev', 'X-Proxy-Service', 'plain', 'x-proxy-service', 'plain'], 400],
    [['X-Proxy-Environment', 'dev,test', 'X-Proxy-Service', 'plain'], 400],
    [['X-Proxy-Environment', '', 'X-Proxy-Service', 'plain'], 400],
    [['X-Proxy-Environment', 'prod', 'X-Proxy-Service', 'plain'], 404],
    [['X-Proxy-Environment', 'dev', 'X-Proxy-Service', 'unbekannt'], 404],
    [['X-Proxy-Environment', 'test', 'X-Proxy-Service', 'plain'], 404],
  ];
  for (const [headers, status] of cases) {
    const r = await raw(headers);
    assert.equal(r.statusCode, status, JSON.stringify(headers));
    assert.equal(r.headers['x-proxy-error'], '1');
  }
  assert.equal(hits, 0, 'nichts erreicht den Upstream');
});

test('absolute-form, * und Fragment als Request-Target → 400', async (t) => {
  let hits = 0;
  const { port } = await setup(t, { handler: (req, res) => (hits++, echo(req, res)) });
  for (const target of [`http://127.0.0.1:${port}/x`, '*', '//evil.example/x', '/x#frag']) {
    const socket = net.connect(port, '127.0.0.1');
    socket.end(`OPTIONS ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-Proxy-Environment: dev\r\nX-Proxy-Service: root\r\nConnection: close\r\n\r\n`);
    let text = '';
    for await (const c of socket) text += c;
    assert.match(text, /^HTTP\/1\.1 400 /, target);
  }
  assert.equal(hits, 0);
});

test('Standard-Header: Client überschreibt, Connection-Benennung entfernt, Auth und Host gewinnen', async (t) => {
  const { call } = await setup(t, { handler: echo, defaultHeaders: { 'X-Client-Name': 'ai-proxy', 'X-Team': 'a', Accept: 'application/json' } });
  const plain = JSON.parse((await call('dev/plain', { path: '/x' })).body);
  assert.equal(plain.headers['x-client-name'], 'ai-proxy');
  assert.equal(plain.headers['x-team'], 'a');
  assert.ok(plain.rawHeaders.includes('X-Client-Name'), 'Schreibweise aus der Datei bleibt');

  const override = JSON.parse((await call('dev/plain', { path: '/x', headers: { 'x-team': 'b', ACCEPT: 'text/plain' } })).body);
  assert.equal(override.headers['x-team'], 'b');
  assert.equal(override.headers.accept, 'text/plain');
  assert.equal(override.rawHeaders.filter((h) => /^(x-team|accept)$/i.test(h)).length, 2, 'keine Duplikate');

  const nominated = JSON.parse((await call('dev/plain', { path: '/x', headers: { Connection: 'X-Client-Name' } })).body);
  assert.equal(nominated.headers['x-client-name'], undefined, 'per Connection benannter Standard-Header entfällt');
  assert.equal(nominated.headers['x-team'], 'a');

  const secured = JSON.parse((await call('dev/secured', { path: '/x', headers: { Connection: 'Authorization, Host', Authorization: 'Bearer client' } })).body);
  assert.equal(secured.headers.authorization, basic('svc', 'Gehe1m!'), 'Connection: Authorization unterdrückt die Basic Auth nicht');
  assert.match(secured.headers.host, /^127\.0\.0\.1:\d+$/);
  assert.equal(secured.headers['x-client-name'], 'ai-proxy');
});

test('ungültige Zeichen im Pfad zum Upstream beenden den Prozess nicht', async (t) => {
  const { proxy, port } = await setup(t, { handler: echo });
  // node:http lehnt solche Targets oft schon beim Parsen ab; ein synchroner Fehler in
  // http.request wird zusätzlich abgefangen.
  const socket = net.connect(port, '127.0.0.1');
  socket.end(`GET /\u00e4 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-Proxy-Environment: dev\r\nX-Proxy-Service: root\r\nConnection: close\r\n\r\n`, 'latin1');
  let text = '';
  for await (const c of socket) text += c;
  assert.match(text, /^HTTP\/1\.1 400 /);
  assert.equal(proxy.server.listening, true);
});

test('synchroner Fehler in http.request → 400 statt Absturz', async (t) => {
  const upstream = await listen(t, echo);
  const base = validateConfig({ environments: { dev: { s: upstream.url } } });
  // Umgeht absichtlich die Validierung, um den Schutz in createProxy selbst zu prüfen.
  const proxy = createProxy({ config: { ...base, defaultHeaders: [['X-Kaputt', 'a\u0100']] } });
  await new Promise((r) => proxy.server.listen(0, '127.0.0.1', r));
  t.after(() => proxy.close());
  const port = proxy.server.address().port;
  const r = await request(port, { method: 'POST', path: '/x', headers: route('dev/s'), body: 'daten' });
  assert.equal(r.status, 400);
  assert.equal(r.headers['x-proxy-error'], '1');
  assert.equal((await request(port, { path: '/x', headers: route('dev/s') })).status, 400, 'Server läuft weiter');
});

test('Methoden, Header und Host werden korrekt weitergegeben, Hop-by-Hop entfernt', async (t) => {
  const { call, upstream } = await setup(t, { handler: echo });
  const r = await call('dev/plain', {
    method: 'PATCH',
    path: '/x',
    headers: {
      'X-CaSe-Test': 'wert',
      'X-Multi': ['a', 'b'],
      Connection: 'keep-alive, X-Hop',
      'X-Hop': 'weg',
      'Keep-Alive': 'timeout=5',
      'Proxy-Authorization': 'Basic xyz',
      TE: 'trailers',
      Upgrade: 'h2c',
      Authorization: 'Bearer client-token',
      'Content-Type': 'text/plain',
    },
    body: 'hallo',
  });
  const seen = JSON.parse(r.body);
  assert.equal(seen.method, 'PATCH');
  assert.equal(seen.headers.host, `127.0.0.1:${upstream.port}`);
  assert.ok(seen.rawHeaders.includes('X-CaSe-Test'), 'Groß-/Kleinschreibung bleibt erhalten');
  assert.equal(seen.headers['x-multi'], 'a, b');
  assert.equal(seen.headers.authorization, 'Bearer client-token', 'ohne auth-Konfiguration wird Authorization durchgereicht');
  for (const h of ['x-hop', 'keep-alive', 'proxy-authorization', 'te', 'upgrade']) assert.equal(seen.headers[h], undefined, h);
  assert.equal(seen.headers['content-length'], '5');
  assert.equal(seen.bodyHash, sha(Buffer.from('hallo')));
});

test('Basic Auth wird gesetzt und ersetzt einen Client-Authorization-Header', async (t) => {
  const { call, logs } = await setup(t, { handler: echo });
  for (const headers of [{}, { Authorization: 'Bearer client-token' }, { authorization: 'Basic ZmFsc2NoOmZhbHNjaA==' }]) {
    const r = await call('dev/secured', { path: '/y?token=abc', headers });
    const seen = JSON.parse(r.body);
    assert.equal(seen.headers.authorization, basic('svc', 'Gehe1m!'));
    assert.equal(seen.rawHeaders.filter((h) => h.toLowerCase() === 'authorization').length, 1);
    assert.equal(seen.url, '/sec/y?token=abc');
  }
  const allLogs = logs.join('\n');
  assert.match(allLogs, /GET dev\/secured -> 200/);
  assert.doesNotMatch(allLogs, /Gehe1m|token=abc|Basic|\/y/);
});

test('Status, Statustext und Antwort-Header (inkl. mehrfacher Set-Cookie) bleiben erhalten', async (t) => {
  const { port } = await setup(t, {
    handler: (req, res) => {
      res.sendDate = false;
      res.writeHead(418, 'Ich bin eine Teekanne', [
        'Set-Cookie', 'a=1; Path=/',
        'Set-Cookie', 'b=2; HttpOnly',
        'X-Upstream', 'ja',
        'Connection', 'X-Resp-Hop',
        'X-Resp-Hop', 'weg',
        'Proxy-Authenticate', 'Basic',
        'Content-Length', '4',
      ]);
      res.end('tee!');
    },
  });
  const r = await request(port, { path: '/', headers: route('dev/plain') });
  assert.equal(r.status, 418);
  assert.equal(r.statusMessage, 'Ich bin eine Teekanne');
  assert.deepEqual(r.headers['set-cookie'], ['a=1; Path=/', 'b=2; HttpOnly']);
  assert.equal(r.headers['x-upstream'], 'ja');
  assert.equal(r.headers['x-resp-hop'], undefined);
  assert.equal(r.headers['proxy-authenticate'], undefined);
  assert.equal(r.headers.date, undefined, 'kein erfundener Date-Header');
  assert.equal(r.headers['content-length'], '4');
  assert.equal(r.body.toString(), 'tee!');
});

test('Redirects werden nicht verfolgt, Location bleibt unverändert', async (t) => {
  let hits = 0;
  const { port } = await setup(t, {
    handler: (req, res) => {
      hits++;
      res.writeHead(302, { Location: 'http://anderswo.example/ziel' });
      res.end();
    },
  });
  const r = await request(port, { path: '/x', headers: route('dev/plain') });
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, 'http://anderswo.example/ziel');
  assert.equal(hits, 1);
});

test('HEAD, 204 und POST ohne Body', async (t) => {
  const { port, setHandler } = await setup(t, {
    handler: (req, res) => {
      res.writeHead(200, { 'Content-Length': '1234', 'Content-Type': 'application/octet-stream' });
      res.end();
    },
  });
  const head = await request(port, { method: 'HEAD', path: '/datei', headers: route('dev/plain') });
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-length'], '1234');
  assert.equal(head.body.length, 0);

  setHandler((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(204, { 'X-Len': String(req.headers['content-length'] ?? 'none'), 'X-TE': String(req.headers['transfer-encoding'] ?? 'none') });
      res.end();
    });
  });
  const post = await request(port, { method: 'POST', path: '/leer', headers: route('dev/plain') });
  assert.equal(post.status, 204);
  assert.equal(post.headers['x-te'], 'none');
});

test('große Bodies werden in beide Richtungen gestreamt (chunked Upload)', async (t) => {
  const data = randomBytes(8 * 1024 * 1024);
  const { port } = await setup(t, {
    handler: (req, res) => {
      const hash = createHash('sha256');
      let n = 0;
      req.on('data', (c) => {
        hash.update(c);
        n += c.length;
      });
      req.on('end', () => {
        res.writeHead(200, { 'X-Upload-Hash': hash.digest('hex'), 'X-Upload-Len': String(n), 'X-TE': req.headers['transfer-encoding'] ?? '' });
        // Antwort chunked und in Stücken
        let off = 0;
        const step = () => {
          while (off < data.length) {
            const ok = res.write(data.subarray(off, off + 65536));
            off += 65536;
            if (!ok) return res.once('drain', step);
          }
          res.end();
        };
        step();
      });
    },
  });
  const res = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'PUT', path: '/upload', headers: route('dev/plain'), agent: false }, resolve);
    req.on('error', reject);
    // ohne Content-Length → chunked
    let off = 0;
    const step = () => {
      while (off < data.length) {
        const ok = req.write(data.subarray(off, off + 100_000));
        off += 100_000;
        if (!ok) return req.once('drain', step);
      }
      req.end();
    };
    step();
  });
  assert.equal(res.headers['x-upload-hash'], sha(data));
  assert.equal(res.headers['x-upload-len'], String(data.length));
  assert.equal(res.headers['x-te'], 'chunked');
  const hash = createHash('sha256');
  for await (const c of res) hash.update(c);
  assert.equal(hash.digest('hex'), sha(data));
});

test('Antwort wird gestreamt, nicht gepuffert', async (t) => {
  let release;
  const released = new Promise((r) => (release = r));
  const { port } = await setup(t, {
    handler: async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: erstes\n\n');
      await released;
      res.end('data: letztes\n\n');
    },
  });
  const res = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/events', headers: route('dev/plain'), agent: false }, resolve));
  const [first] = await once(res, 'data');
  assert.equal(first.toString(), 'data: erstes\n\n', 'erstes Stück kommt an, bevor der Upstream fertig ist');
  release();
  let rest = '';
  for await (const c of res) rest += c;
  assert.equal(rest, 'data: letztes\n\n');
});

test('ohne Routing-Header gibt es kein Präfix-Routing mehr → 400 mit Übersicht', async (t) => {
  const { port } = await setup(t, { handler: echo });
  for (const path of ['/', '/dev', '/dev/plain/x', '/prod/plain/x']) {
    const r = await request(port, { path });
    assert.equal(r.status, 400, path);
    assert.equal(r.headers['x-proxy-error'], '1');
    assert.match(r.body.toString(), /X-Proxy-Environment: dev {2}X-Proxy-Service: plain/);
  }
  const unknown = await request(port, { path: '/', headers: route('dev/unbekannt') });
  assert.equal(unknown.status, 404);
  assert.match(unknown.body.toString(), /X-Proxy-Service: secured/);
});

test('Upstream nicht erreichbar → 502', async (t) => {
  const free = net.createServer();
  await new Promise((r) => free.listen(0, '127.0.0.1', r));
  const deadPort = free.address().port;
  await new Promise((r) => free.close(r));
  const { port } = await setup(t, { services: () => ({ dead: `http://127.0.0.1:${deadPort}/x` }) });
  const r = await request(port, { path: '/y', headers: route('dev/dead') });
  assert.equal(r.status, 502);
  assert.match(r.body.toString(), /ECONNREFUSED/);
});

test('Upstream antwortet nicht → 504 nach timeoutMs', async (t) => {
  const { port } = await setup(t, { timeoutMs: 200, handler: () => {} });
  const start = Date.now();
  const r = await request(port, { path: '/langsam', headers: route('dev/plain') });
  assert.equal(r.status, 504);
  assert.ok(Date.now() - start >= 190);
});

test('Client-Abbruch bricht den Upstream-Request ab', async (t) => {
  let upstreamClosed;
  const closed = new Promise((r) => (upstreamClosed = r));
  let arrived;
  const arrivedP = new Promise((r) => (arrived = r));
  const { port, logs } = await setup(t, {
    handler: (req, res) => {
      res.on('close', () => upstreamClosed(true));
      res.writeHead(200);
      res.write('anfang');
      arrived();
    },
  });
  const req = http.get({ host: '127.0.0.1', port, path: '/ewig', headers: route('dev/plain'), agent: false });
  req.on('error', () => {});
  req.on('response', (res) => res.resume());
  await arrivedP;
  await new Promise((r) => setTimeout(r, 20));
  req.destroy();
  assert.equal(await closed, true);
  await new Promise((r) => setTimeout(r, 20));
  assert.match(logs.join('\n'), /Client hat Verbindung abgebrochen/);
});

test('Upstream bricht mitten in der Antwort ab → Client-Verbindung wird abgebrochen', async (t) => {
  const { port } = await setup(t, {
    handler: (req, res) => {
      res.writeHead(200, { 'Content-Length': '1000' });
      res.write('nur ein Teil');
      setTimeout(() => res.socket.destroy(), 20);
    },
  });
  await assert.rejects(request(port, { path: '/kaputt', headers: route('dev/plain') }), (err) => err.code === 'ECONNRESET' || /aborted/i.test(err.message));
});

test('createProxy verweigert Services mit auth, aber ohne geladene Zugangsdaten', () => {
  const config = validateConfig({ keepass: { database: 'x' }, environments: { e: { s: { url: 'http://x', auth: { entry: { title: 't' } } } } } });
  assert.throws(() => createProxy({ config }), /keine Zugangsdaten/);
});

test('close() nullt die Zugangsdaten', async (t) => {
  const { proxy } = await setup(t, { handler: echo });
  const secret = proxy.routes.get('dev').get('secured').secret;
  await proxy.close();
  assert.equal(secret.disposed, true);
});
