import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { pipeline } from 'node:stream';
import { NAME_RE } from './config.js';
import { createMcpHandler, rpcError, sendJson } from './mcp.js';

// RFC 9110 §7.6.1 + gängige Nicht-Standard-Header, die nur für eine Verbindung gelten.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export const ENV_HEADER = 'X-Proxy-Environment';
export const SERVICE_HEADER = 'X-Proxy-Service';
const ROUTING_HEADERS = [ENV_HEADER.toLowerCase(), SERVICE_HEADER.toLowerCase()];

/**
 * Liest die Routing-Header aus den rohen Headern. Jeder muss genau einmal mit einem
 * gültigen Namen vorkommen (Duplikate ohne Rücksicht auf Groß-/Kleinschreibung).
 * @returns {{present: false} | {present: true, error: string} | {present: true, env: string, service: string}}
 */
export function readRouting(rawHeaders) {
  const values = new Map(ROUTING_HEADERS.map((h) => [h, []]));
  for (let i = 0; i < rawHeaders.length; i += 2) values.get(rawHeaders[i].toLowerCase())?.push(rawHeaders[i + 1]);
  const [envValues, svcValues] = ROUTING_HEADERS.map((h) => values.get(h));
  if (envValues.length === 0 && svcValues.length === 0) return { present: false };
  for (const [label, list] of [[ENV_HEADER, envValues], [SERVICE_HEADER, svcValues]]) {
    if (list.length === 0) return { present: true, error: `Header ${label} fehlt` };
    if (list.length > 1) return { present: true, error: `Header ${label} ist mehrfach vorhanden` };
    if (!NAME_RE.test(list[0])) return { present: true, error: `Header ${label} hat einen ungültigen Wert` };
  }
  return { present: true, env: envValues[0], service: svcValues[0] };
}

/**
 * Prüft das Request-Target: nur origin-form ("/pfad?query"), ohne Fragment.
 * absolute-form ("http://…"), authority-form und "*" werden abgewiesen.
 */
export function isOriginForm(rawUrl) {
  return typeof rawUrl === 'string' && rawUrl[0] === '/' && !rawUrl.startsWith('//') && !rawUrl.includes('#');
}

/**
 * Hängt das rohe Request-Target (Pfad + Query, byte-genau) an den Basis-Pfad der
 * Upstream-URL an. Nichts wird entfernt, dekodiert oder normalisiert.
 * @param {string} basePath ohne abschließenden Slash, ggf. leer
 * @param {string} target origin-form, beginnt mit "/"
 */
export function buildUpstreamPath(basePath, target) {
  return basePath + target;
}

/** Header, die in „Connection: …“ aufgezählt sind, sind ebenfalls hop-by-hop. */
export function connectionTokens(rawHeaders) {
  const tokens = new Set();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === 'connection') {
      for (const t of rawHeaders[i + 1].split(',')) {
        const v = t.trim().toLowerCase();
        if (v) tokens.add(v);
      }
    }
  }
  return tokens;
}

/**
 * Filtert rohe Header (abwechselnd Name/Wert), Reihenfolge, Groß-/Kleinschreibung
 * und Duplikate bleiben erhalten.
 */
export function filterHeaders(rawHeaders, extraDrop = []) {
  const drop = connectionTokens(rawHeaders);
  for (const h of extraDrop) drop.add(h);
  const out = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || drop.has(lower)) continue;
    out.push(name, rawHeaders[i + 1]);
  }
  return out;
}

/**
 * Baut die Header für den Upstream. Vorrang (niedrig → hoch): Standard-Header aus
 * der Header-Datei < Ende-zu-Ende-Header des Clients < Host des Ziels und Basic Auth.
 * Standard-Header und Client-Header werden zuerst zusammengeführt und dann einmal
 * gefiltert: Routing-, Hop-by-Hop- und per „Connection“ benannte Header fallen weg –
 * auch Standard-Header, die der Client per „Connection“ benennt. Host und Basic Auth
 * werden erst danach gesetzt und lassen sich so nicht unterdrücken.
 * @param {string[]} rawHeaders
 * @param {object} opts
 * @param {string} opts.hostHeader
 * @param {ReadonlyArray<readonly [string, string]>} [opts.defaultHeaders]
 * @param {string | null} [opts.authorization] eingefügter Authorization-Wert
 */
export function buildUpstreamHeaders(rawHeaders, { hostHeader, defaultHeaders = [], authorization = null }) {
  const present = new Set();
  for (let i = 0; i < rawHeaders.length; i += 2) present.add(rawHeaders[i].toLowerCase());
  const merged = [];
  for (const [name, value] of defaultHeaders) if (!present.has(name.toLowerCase())) merged.push(name, value);
  merged.push(...rawHeaders);
  const out = filterHeaders(merged, ['host', 'expect', ...ROUTING_HEADERS, ...(authorization ? ['authorization'] : [])]);
  out.unshift('Host', hostHeader);
  if (authorization) out.push('Authorization', authorization);
  return out;
}

const LOOPBACK_OR_ANY = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0', '::']);

function formatHost(host) {
  return host.includes(':') ? `[${host}]` : host;
}

/**
 * Exakte Liste erlaubter Host-Header-Werte (klein geschrieben). Schützt vor
 * DNS-Rebinding: Eine fremde Website, deren Domain auf 127.0.0.1 zeigt, sendet
 * ihren eigenen Hostnamen im Host-Header und wird abgewiesen.
 */
export function allowedHostValues(listenHost, port, extra = []) {
  const names = new Set([formatHost(listenHost.toLowerCase())]);
  if (LOOPBACK_OR_ANY.has(listenHost.toLowerCase())) for (const n of ['127.0.0.1', 'localhost', '[::1]']) names.add(n);
  const values = new Set(extra);
  for (const n of names) {
    values.add(`${n}:${port}`);
    if (port === 80) values.add(n);
  }
  return values;
}

/** Basis-URL, unter der ein Listener lokal erreichbar ist (z. B. proxyUrl in den MCP-Antworten). */
export function advertisedBaseUrl(listenHost, port) {
  const h = listenHost === '0.0.0.0' ? '127.0.0.1' : listenHost === '::' ? '::1' : listenHost;
  return `http://${formatHost(h)}:${port}`;
}

/**
 * TLS-Optionen für einen https-Service; werden sowohl dem Agent als auch jedem
 * Request mitgegeben. Nie global (kein NODE_TLS_REJECT_UNAUTHORIZED, kein globalAgent).
 * @param {{rejectUnauthorized: boolean, ca: ReadonlyArray<string> | null} | null} tlsConfig
 */
export function tlsOptionsFor(tlsConfig) {
  const opts = { rejectUnauthorized: tlsConfig?.rejectUnauthorized !== false };
  // Einmal pro Service aufgebaut statt pro Verbindung (tls.ca enthält auch die Node-Root-CAs).
  if (tlsConfig?.ca) opts.secureContext = tls.createSecureContext({ ca: [...tlsConfig.ca] });
  return opts;
}

const CERT_ERROR_RE = /CERT|SELF_SIGNED|UNABLE_TO_(GET_ISSUER|VERIFY)|ALTNAME|HOSTNAME/;

function tlsHint(err) {
  if (!CERT_ERROR_RE.test(err.code ?? '')) return '';
  return err.code === 'ERR_TLS_CERT_ALTNAME_INVALID'
    ? '; Zertifikat passt nicht zum Hostnamen der URL'
    : '; Zertifikat nicht vertrauenswürdig – private CA per tls.caFile hinterlegen';
}

/** Pfad ohne Query. */
function pathOf(rawUrl) {
  const q = rawUrl.indexOf('?');
  return q === -1 ? rawUrl : rawUrl.slice(0, q);
}

/** Bindet einen Server; Fehler (z. B. EADDRINUSE) werden als Rejection geliefert. */
function bind(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

/** Schließt einen Server samt offener Verbindungen; auch wenn er nie gelauscht hat. */
function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/**
 * Erzeugt die HTTP-Server des Proxys: `server` (API-Weiterleitung, nur mit
 * Routing-Headern) und – falls `mcp` aktiv – `mcpServer` (nur `/mcp`, leitet nie weiter).
 * Beide laufen auf demselben Host, aber auf getrennten Ports.
 * @param {object} opts
 * @param {ReturnType<import('./config.js').validateConfig>} opts.config
 * @param {Map<string, import('./secret.js').SecretValue>} [opts.credentials] „env/service“ → Authorization-Wert
 * @param {(line: string) => void} [opts.log]
 * @param {string} [opts.version] für MCP serverInfo
 */
export function createProxy({ config, credentials = new Map(), log = () => {}, version = '0.0.0' }) {
  const routes = new Map();
  const httpAgent = new http.Agent({ keepAlive: true });
  const httpsAgents = [];
  for (const env of config.environments) {
    const services = new Map();
    for (const svc of env.services) {
      const key = `${env.name}/${svc.name}`;
      const secret = credentials.get(key) ?? null;
      if (svc.auth && !secret) throw new Error(`Für ${key} sind keine Zugangsdaten geladen`);
      if (svc.tls?.caFile && !svc.tls.ca) throw new Error(`Für ${key} ist tls.caFile ${svc.tls.caFile} nicht geladen (Konfiguration mit loadConfig() oder loadCaFiles() laden)`);
      let agent = httpAgent;
      let tlsOptions = {};
      if (svc.protocol === 'https:') {
        tlsOptions = tlsOptionsFor(svc.tls);
        // Eigener Pool je Service: Ein Socket, der ohne Prüfung aufgebaut wurde, wird
        // nie für einen Service mit Prüfung wiederverwendet (auch nicht die TLS-Session).
        agent = new https.Agent({ keepAlive: true, ...tlsOptions });
        httpsAgents.push(agent);
      }
      services.set(svc.name, { ...svc, key, secret, agent, tlsOptions });
    }
    routes.set(env.name, services);
  }

  const server = http.createServer({ requestTimeout: 0 }, (req, res) => handle(req, res));
  // Lange Up-/Downloads nicht abbrechen; Leerlauf wird pro Upstream über timeoutMs begrenzt.
  server.requestTimeout = 0;
  const mcpServer = config.mcp ? http.createServer((req, res) => handleMcpListener(req, res)) : null;

  const proxyPort = () => server.address()?.port ?? config.listen.port;
  const proxyGuard = createGuard(() => proxyPort());
  const mcpGuard = mcpServer ? createGuard(() => mcpServer.address()?.port ?? config.listen.mcpPort) : null;
  // Die Erkennung meldet die URL des Proxy-Listeners, nicht die des MCP-Listeners.
  const proxyUrl = () => advertisedBaseUrl(config.listen.host, proxyPort());
  const mcp = mcpServer ? createMcpHandler({ config, version, baseUrl: proxyUrl }) : null;

  /** Exakte Host-/Origin-Prüfung für einen Listener, bezogen auf dessen tatsächlichen Port. */
  function createGuard(port) {
    let cached = null;
    return function allowed(req) {
      const p = port();
      if (!cached || cached.port !== p) {
        const hosts = allowedHostValues(config.listen.host, p, config.listen.allowedHosts);
        const origins = new Set(config.listen.allowedOrigins);
        for (const h of hosts) origins.add(`http://${h}`);
        cached = { port: p, hosts, origins };
      }
      const host = req.headers.host?.toLowerCase();
      const origin = req.headers.origin?.toLowerCase();
      if (!host || !cached.hosts.has(host)) return 'Host';
      if (origin !== undefined && !cached.origins.has(origin)) return 'Origin';
      return null;
    };
  }

  function rejectForeign(guard, req, res, label) {
    const reason = guard(req);
    if (!reason) return false;
    log(`${label}${req.method} abgewiesen (${reason} nicht erlaubt) -> 403`);
    sendJson(res, 403, rpcError(undefined, -32600, 'Host oder Origin nicht erlaubt'));
    return true;
  }

  function handleMcpListener(req, res) {
    if (rejectForeign(mcpGuard, req, res, 'MCP ')) return;
    if (!isOriginForm(req.url) || pathOf(req.url) !== '/mcp') {
      log(`MCP ${req.method} abgewiesen (nur /mcp) -> 404`);
      return sendError(res, 404, `Dieser Port bietet nur den MCP-Endpunkt /mcp. API-Aufrufe gehen an ${proxyUrl()}`);
    }
    // Der MCP-Listener leitet nie weiter – Routing-Header sind hier ein Bedienfehler.
    if (readRouting(req.rawHeaders).present) {
      log(`MCP ${req.method} abgewiesen (Routing-Header am MCP-Port) -> 400`);
      return sendError(res, 400, `Der MCP-Port leitet nicht weiter. API-Aufrufe mit ${ENV_HEADER}/${SERVICE_HEADER} gehen an ${proxyUrl()}`);
    }
    return mcp(req, res);
  }

  function handle(req, res) {
    // Host und Origin exakt prüfen (kein Präfix-/Suffix-Vergleich).
    if (rejectForeign(proxyGuard, req, res, '')) return;

    if (!isOriginForm(req.url)) {
      log(`${req.method} abgewiesen (ungültiges Request-Target) -> 400`);
      return sendError(res, 400, 'Ungültiges Request-Target: nur Pfade wie /api/x?y=1 (ohne Schema, Host oder Fragment)');
    }

    // Der Proxy-Listener kennt keinen MCP-Endpunkt: auch /mcp braucht Routing-Header.
    const routing = readRouting(req.rawHeaders);
    const started = process.hrtime.bigint();
    if (!routing.present || routing.error) {
      const reason = routing.error ?? `Header ${ENV_HEADER} und ${SERVICE_HEADER} fehlen`;
      log(`${req.method} abgewiesen (${reason}) -> 400`);
      return sendError(res, 400, `${reason}. Jeder Request braucht genau einen ${ENV_HEADER}- und einen ${SERVICE_HEADER}-Header.\n${knownRoutes()}`);
    }
    const svc = routes.get(routing.env)?.get(routing.service);
    if (!svc) {
      log(`${req.method} abgewiesen (unbekannter Service) -> 404`);
      return sendError(res, 404, `Unbekannte Umgebung oder unbekannter Service.\n${knownRoutes()}`);
    }

    const path = buildUpstreamPath(svc.basePath, req.url);
    const headers = buildUpstreamHeaders(req.rawHeaders, { hostHeader: svc.hostHeader, defaultHeaders: config.defaultHeaders, authorization: svc.secret?.reveal() ?? null });

    let done = false;
    const finishLog = (status, note) => {
      if (done) return;
      done = true;
      const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
      // Bewusst ohne Pfad, Query und Header: dort können Tokens oder IDs stehen.
      log(`${req.method} ${svc.key} -> ${status}${note ? ` (${note})` : ''} ${ms}ms`);
    };

    let upstream;
    try {
      upstream = (svc.protocol === 'https:' ? https : http).request({
        protocol: svc.protocol,
        hostname: svc.hostname,
        port: svc.port,
        method: req.method,
        path,
        headers,
        agent: svc.agent,
        ...svc.tlsOptions,
        timeout: svc.timeoutMs,
        setHost: false,
      });
    } catch (err) {
      // z. B. ERR_UNESCAPED_CHARACTERS oder ungültige Header – synchron geworfen, darf den Prozess nicht beenden.
      finishLog(400, err.code ?? err.message);
      req.resume();
      return sendError(res, 400, `Request kann nicht weitergeleitet werden (${err.code ?? 'ungültig'})`);
    }

    let clientGone = false;
    res.on('close', () => {
      if (!res.writableFinished) {
        clientGone = true;
        upstream.destroy();
        finishLog(res.headersSent ? res.statusCode : 499, 'Client hat Verbindung abgebrochen');
      }
    });

    upstream.on('timeout', () => {
      upstream.destroy(Object.assign(new Error(`Keine Antwort innerhalb von ${svc.timeoutMs} ms`), { code: 'ETIMEDOUT' }));
    });

    upstream.on('error', (err) => {
      req.unpipe(upstream);
      if (clientGone) return;
      if (res.headersSent) {
        // Antwort läuft schon – Verbindung hart schließen, damit der Client den Abbruch merkt.
        finishLog(res.statusCode, `Upstream-Fehler während der Übertragung: ${err.code ?? err.message}`);
        res.destroy();
        return;
      }
      const timeout = err.code === 'ETIMEDOUT';
      const status = timeout ? 504 : 502;
      finishLog(status, err.code ?? err.message);
      sendError(res, status, timeout ? `Zeitüberschreitung beim Upstream ${svc.url}` : `Upstream ${svc.url} nicht erreichbar (${err.code ?? err.message})${tlsHint(err)}`);
    });

    upstream.on('response', (up) => {
      if (clientGone) {
        up.destroy();
        return;
      }
      res.sendDate = false; // Date-Header nur durchreichen, nicht erfinden
      res.writeHead(up.statusCode, up.statusMessage, filterHeaders(up.rawHeaders));
      pipeline(up, res, (err) => {
        if (err) {
          if (!clientGone) finishLog(up.statusCode, `Übertragung abgebrochen: ${err.code ?? err.message}`);
          upstream.destroy();
          res.destroy();
        } else {
          finishLog(up.statusCode);
        }
      });
    });

    req.on('error', (err) => {
      clientGone = true;
      upstream.destroy(err);
    });
    req.pipe(upstream);
  }

  function knownRoutes() {
    const known = [...routes].flatMap(([e, s]) => [...s.keys()].map((n) => `  ${ENV_HEADER}: ${e}  ${SERVICE_HEADER}: ${n}`));
    return `Verfügbar:\n${known.join('\n')}`;
  }

  function sendError(res, status, message) {
    if (res.headersSent || res.destroyed) return;
    const body = Buffer.from(`ai-proxy: ${message}\n`, 'utf8');
    res.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': body.length,
      'X-Proxy-Error': '1',
    });
    res.end(body);
  }

  /**
   * Bindet Proxy- und MCP-Listener gemeinsam. Scheitert einer, wird der andere wieder
   * geschlossen; der Fehler trägt `listener` ('proxy' | 'mcp') und `port`.
   */
  async function listen() {
    const steps = [[server, config.listen.port, 'proxy']];
    if (mcpServer) steps.push([mcpServer, config.listen.mcpPort, 'mcp']);
    const bound = [];
    for (const [srv, port, listener] of steps) {
      try {
        await bind(srv, port, config.listen.host);
        bound.push(srv);
      } catch (err) {
        await Promise.all(bound.map(closeServer));
        throw Object.assign(err, { listener, port });
      }
    }
  }

  /** Beide Server stoppen (auch nicht lauschende), Verbindungen schließen, Geheimnisse nullen. */
  async function close() {
    await Promise.all([server, mcpServer].filter(Boolean).map(closeServer));
    for (const agent of [httpAgent, ...httpsAgents]) agent.destroy();
    for (const services of routes.values()) for (const svc of services.values()) svc.secret?.dispose();
  }

  return { server, mcpServer, listen, close, routes };
}
