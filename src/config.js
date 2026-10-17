import { readFile } from 'node:fs/promises';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import path from 'node:path';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 8075,
  mcpPort: 8076,
  timeoutMs: 30_000,
});

// Namen werden als Wert der Routing-Header verwendet, daher nur „unreservierte“ Zeichen.
export const NAME_RE = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/;
// Keine Steuerzeichen (verhindert Header-Injection und unsichtbare Zeichen).
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * Liest und validiert die Konfigurationsdatei.
 * @param {string} file Pfad zur connection.json
 */
export async function loadConfig(file) {
  const abs = path.resolve(file);
  let text;
  try {
    text = await readFile(abs, 'utf8');
  } catch (err) {
    throw new ConfigError(`Konfigurationsdatei ${abs} kann nicht gelesen werden: ${err.code ?? err.message}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`Konfigurationsdatei ${abs} ist kein gültiges JSON: ${err.message}`);
  }
  const config = validateConfig(json, path.dirname(abs));
  if (!config.headersFile) return config;
  const defaultHeaders = await loadHeadersFile(config.headersFile);
  return Object.freeze({ ...config, defaultHeaders });
}

/** Header, die der Proxy selbst verwaltet, die nur für eine Verbindung gelten oder Zugangsdaten tragen. */
export const FORBIDDEN_DEFAULT_HEADERS = Object.freeze([
  'x-proxy-environment',
  'x-proxy-service',
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
  'expect',
  'authorization',
]);

// RFC 9110 §5.6.2 (token).
const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// Sichtbare Zeichen, Leerzeichen und Tab, keine Steuerzeichen; nur Latin-1 (wie Node).
const FIELD_VALUE_RE = /^[\x21-\x7e\x80-\xff](?:[\t\x20-\x7e\x80-\xff]*[\x21-\x7e\x80-\xff])?$/;

/**
 * Liest die Datei mit Standard-Headern (JSON-Objekt Name → String-Wert).
 * @param {string} file absoluter Pfad
 * @returns {Promise<ReadonlyArray<readonly [string, string]>>}
 */
export async function loadHeadersFile(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    throw new ConfigError(`Header-Datei ${file} kann nicht gelesen werden: ${err.code ?? err.message}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`Header-Datei ${file} ist kein gültiges JSON: ${err.message}`);
  }
  return validateDefaultHeaders(json, file);
}

/**
 * Validiert Standard-Header und liefert sie als eingefrorene Liste [Name, Wert].
 * Alle Fehler werden gesammelt gemeldet.
 * @param {unknown} json
 * @param {string} [where] für Fehlermeldungen
 */
export function validateDefaultHeaders(json, where = 'Header-Datei') {
  if (!isPlainObject(json)) throw new ConfigError(`${where}: muss ein JSON-Objekt { "Header-Name": "Wert" } sein`);
  const errors = [];
  const seen = new Map();
  const out = [];
  for (const [name, value] of Object.entries(json)) {
    const label = JSON.stringify(name);
    const lower = name.toLowerCase();
    if (!TOKEN_RE.test(name) || !nodeAccepts(name, 'x')) {
      errors.push(`${label}: ungültiger Header-Name`);
      continue;
    }
    if (seen.has(lower)) {
      errors.push(`${label}: doppelt (Groß-/Kleinschreibung zählt nicht, schon als ${JSON.stringify(seen.get(lower))} vorhanden)`);
      continue;
    }
    seen.set(lower, name);
    if (FORBIDDEN_DEFAULT_HEADERS.includes(lower)) {
      errors.push(`${label}: nicht erlaubt (Routing-, Verbindungs- und Auth-Header verwaltet der Proxy selbst; Basic Auth kommt aus KeePass)`);
      continue;
    }
    if (typeof value !== 'string') {
      errors.push(`${label}: Wert muss ein String sein`);
      continue;
    }
    if (!FIELD_VALUE_RE.test(value) || !nodeAccepts(name, value)) {
      errors.push(`${label}: ungültiger Wert (nicht leer, keine Steuerzeichen, kein Leerraum am Rand, nur Latin-1)`);
      continue;
    }
    out.push(Object.freeze([name, value]));
  }
  if (errors.length > 0) throw new ConfigError(`Ungültige Header-Datei ${where}:\n  - ${errors.join('\n  - ')}`);
  return Object.freeze(out);
}

/**
 * Validiert ein bereits geparstes Konfigurationsobjekt und liefert eine
 * normalisierte, eingefrorene Struktur. Alle Fehler werden gesammelt gemeldet.
 * @param {unknown} json
 * @param {string} baseDir Basis für relative Pfade (Verzeichnis der Konfigurationsdatei)
 */
export function validateConfig(json, baseDir = process.cwd()) {
  const errors = [];
  const err = (where, msg) => errors.push(`${where}: ${msg}`);

  if (!isPlainObject(json)) throw new ConfigError('Konfiguration muss ein JSON-Objekt sein');
  checkKeys(json, ['$schema', '$comment', 'listen', 'keepass', 'upstream', 'mcp', 'headersFile', 'environments'], '(Wurzel)', err);

  // headersFile (wird von loadConfig gelesen, relativ zur Konfigurationsdatei)
  let headersFile = null;
  if (json.headersFile !== undefined && json.headersFile !== null) {
    if (typeof json.headersFile !== 'string' || json.headersFile.trim() === '') err('headersFile', 'muss ein Pfad (String) oder null sein');
    else headersFile = path.resolve(baseDir, json.headersFile);
  }

  // listen
  let host = DEFAULTS.host;
  let port = DEFAULTS.port;
  let mcpPort = DEFAULTS.mcpPort;
  let allowedHosts = [];
  let allowedOrigins = [];
  if (json.listen !== undefined) {
    if (!isPlainObject(json.listen)) err('listen', 'muss ein Objekt sein');
    else {
      checkKeys(json.listen, ['host', 'port', 'mcpPort', 'allowedHosts', 'allowedOrigins'], 'listen', err);
      if (json.listen.host !== undefined) {
        if (typeof json.listen.host !== 'string' || json.listen.host.trim() === '') err('listen.host', 'muss ein nicht-leerer String sein');
        else host = json.listen.host;
      }
      if (json.listen.port !== undefined) {
        if (!Number.isInteger(json.listen.port) || json.listen.port < 0 || json.listen.port > 65535) err('listen.port', 'muss eine ganze Zahl zwischen 0 und 65535 sein');
        else port = json.listen.port;
      }
      if (json.listen.mcpPort !== undefined) {
        if (!Number.isInteger(json.listen.mcpPort) || json.listen.mcpPort < 0 || json.listen.mcpPort > 65535) err('listen.mcpPort', 'muss eine ganze Zahl zwischen 0 und 65535 sein');
        else mcpPort = json.listen.mcpPort;
      }
      if (json.listen.allowedHosts !== undefined) {
        const list = json.listen.allowedHosts;
        if (!Array.isArray(list) || !list.every((h) => typeof h === 'string' && HOST_RE.test(h))) {
          err('listen.allowedHosts', 'muss ein Array exakter Host-Header-Werte sein, z. B. ["proxy.local:8075"]');
        } else allowedHosts = list.map((h) => h.toLowerCase());
      }
      if (json.listen.allowedOrigins !== undefined) {
        const list = json.listen.allowedOrigins;
        if (!Array.isArray(list) || !list.every(isOrigin)) {
          err('listen.allowedOrigins', 'muss ein Array exakter Origins sein, z. B. ["http://localhost:3000"]');
        } else allowedOrigins = list.map((o) => o.toLowerCase());
      }
    }
  }

  // upstream (globale Defaults)
  let timeoutMs = DEFAULTS.timeoutMs;
  if (json.upstream !== undefined) {
    if (!isPlainObject(json.upstream)) err('upstream', 'muss ein Objekt sein');
    else {
      checkKeys(json.upstream, ['timeoutMs'], 'upstream', err);
      if (json.upstream.timeoutMs !== undefined) {
        if (!isTimeout(json.upstream.timeoutMs)) err('upstream.timeoutMs', 'muss eine ganze Zahl > 0 sein');
        else timeoutMs = json.upstream.timeoutMs;
      }
    }
  }

  // mcp
  let mcp = true;
  if (json.mcp !== undefined) {
    if (typeof json.mcp !== 'boolean') err('mcp', 'muss true oder false sein');
    else mcp = json.mcp;
  }

  // Proxy und MCP sind getrennte Listener auf demselben Host (Port 0 = jeweils frei gewählt).
  if (mcp && port !== 0 && port === mcpPort) err('listen.mcpPort', `muss sich von listen.port (${port}) unterscheiden`);

  // keepass
  let keepass = null;
  if (json.keepass !== undefined) {
    if (!isPlainObject(json.keepass)) err('keepass', 'muss ein Objekt sein');
    else {
      checkKeys(json.keepass, ['database', 'keyFile'], 'keepass', err);
      const { database, keyFile } = json.keepass;
      if (typeof database !== 'string' || database.trim() === '') err('keepass.database', 'Pfad zur .kdbx-Datei fehlt');
      if (keyFile !== undefined && keyFile !== null && (typeof keyFile !== 'string' || keyFile.trim() === '')) err('keepass.keyFile', 'muss ein Pfad (String) oder null sein');
      if (typeof database === 'string' && database.trim() !== '') {
        keepass = Object.freeze({
          database: path.resolve(baseDir, database),
          keyFile: typeof keyFile === 'string' && keyFile.trim() !== '' ? path.resolve(baseDir, keyFile) : null,
        });
      }
    }
  }

  // environments
  const environments = [];
  let authRequested = false;
  if (!isPlainObject(json.environments) || Object.keys(json.environments).length === 0) {
    err('environments', 'muss ein Objekt mit mindestens einer Umgebung sein');
  } else {
    for (const [envName, envDef] of Object.entries(json.environments)) {
      const envWhere = `environments.${envName}`;
      if (!NAME_RE.test(envName)) err(envWhere, 'ungültiger Name (erlaubt: A-Z a-z 0-9 . _ ~ -, nicht mit Punkt beginnend)');
      if (!isPlainObject(envDef) || Object.keys(envDef).length === 0) {
        err(envWhere, 'muss ein Objekt mit mindestens einem Service sein');
        continue;
      }
      const services = [];
      for (const [svcName, svcDef] of Object.entries(envDef)) {
        if (isPlainObject(svcDef) && svcDef.auth !== undefined && svcDef.auth !== null) authRequested = true;
        const svc = validateService(svcName, svcDef, `${envWhere}.${svcName}`, timeoutMs, err);
        if (svc) services.push(svc);
      }
      environments.push(Object.freeze({ name: envName, services: Object.freeze(services) }));
    }
  }

  const needsKeepass = authRequested;
  if (needsKeepass && json.keepass === undefined) {
    err('keepass', 'mindestens ein Service nutzt Basic Auth, aber es ist keine KeePass-Datenbank konfiguriert');
  }

  if (errors.length > 0) {
    throw new ConfigError(`Ungültige Konfiguration:\n  - ${errors.join('\n  - ')}`);
  }

  return Object.freeze({
    listen: Object.freeze({ host, port, mcpPort, allowedHosts: Object.freeze(allowedHosts), allowedOrigins: Object.freeze(allowedOrigins) }),
    mcp,
    keepass,
    needsKeepass,
    headersFile,
    defaultHeaders: Object.freeze([]),
    environments: Object.freeze(environments),
  });
}

function validateService(name, def, where, defaultTimeout, err) {
  if (!NAME_RE.test(name)) err(where, 'ungültiger Service-Name (erlaubt: A-Z a-z 0-9 . _ ~ -, nicht mit Punkt beginnend)');
  if (typeof def === 'string') def = { url: def };
  if (!isPlainObject(def)) {
    err(where, 'muss ein Objekt (oder eine URL als String) sein');
    return null;
  }
  checkKeys(def, ['url', 'auth', 'timeoutMs', '$comment'], where, err);

  let url = null;
  if (typeof def.url !== 'string' || def.url.trim() === '') {
    err(`${where}.url`, 'fehlt');
  } else {
    try {
      url = new URL(def.url);
    } catch {
      err(`${where}.url`, `keine gültige URL: ${JSON.stringify(def.url)}`);
    }
    if (url) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') err(`${where}.url`, 'nur http:// und https:// werden unterstützt');
      if (url.username || url.password) err(`${where}.url`, 'darf keine Zugangsdaten enthalten (Benutzer über „auth.username“, Passwort aus KeePass)');
      if (url.search || def.url.includes('?')) err(`${where}.url`, 'darf keinen Query-String enthalten');
      if (url.hash || def.url.includes('#')) err(`${where}.url`, 'darf kein Fragment (#) enthalten');
    }
  }

  let timeoutMs = defaultTimeout;
  if (def.timeoutMs !== undefined) {
    if (!isTimeout(def.timeoutMs)) err(`${where}.timeoutMs`, 'muss eine ganze Zahl > 0 sein');
    else timeoutMs = def.timeoutMs;
  }

  let auth = null;
  if (def.auth !== undefined && def.auth !== null) {
    auth = validateAuth(def.auth, `${where}.auth`, err);
  }

  if (!url) return null;
  // Basis-Pfad ohne abschließenden Slash; der Rest-Pfad des Requests wird roh angehängt.
  const basePath = url.pathname.replace(/\/+$/, '');
  return Object.freeze({
    name,
    url: url.href,
    protocol: url.protocol,
    hostname: url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname,
    port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
    hostHeader: url.host,
    basePath,
    timeoutMs,
    auth,
  });
}

function validateAuth(auth, where, err) {
  if (!isPlainObject(auth)) {
    err(where, 'muss ein Objekt sein');
    return null;
  }
  checkKeys(auth, ['username', 'entry'], where, err);
  let ok = true;

  let username = null;
  if (auth.username !== undefined && auth.username !== null) {
    if (typeof auth.username !== 'string' || auth.username === '') {
      err(`${where}.username`, 'muss ein nicht-leerer String sein');
      ok = false;
    } else if (auth.username.includes(':')) {
      err(`${where}.username`, 'darf bei Basic Auth keinen Doppelpunkt enthalten');
      ok = false;
    } else if (CONTROL_RE.test(auth.username)) {
      err(`${where}.username`, 'darf keine Steuerzeichen enthalten');
      ok = false;
    } else {
      username = auth.username;
    }
  }

  const entry = auth.entry;
  let lookup = null;
  if (!isPlainObject(entry)) {
    err(`${where}.entry`, 'fehlt: KeePass-Eintrag über { "uuid": … } oder { "group": …, "title": … } angeben');
    ok = false;
  } else {
    checkKeys(entry, ['uuid', 'group', 'title'], `${where}.entry`, err);
    const hasUuid = entry.uuid !== undefined;
    const hasTitle = entry.title !== undefined;
    if (hasUuid && (hasTitle || entry.group !== undefined)) {
      err(`${where}.entry`, 'mehrdeutig: entweder „uuid“ oder „group“/„title“ angeben, nicht beides');
      ok = false;
    } else if (hasUuid) {
      const bytes = parseUuid(entry.uuid);
      if (!bytes) {
        err(`${where}.entry.uuid`, 'keine gültige UUID (32 Hex-Zeichen, optional mit Bindestrichen, oder Base64)');
        ok = false;
      } else {
        lookup = Object.freeze({ kind: 'uuid', uuid: bytes.toString('hex').toUpperCase() });
      }
    } else if (hasTitle) {
      if (typeof entry.title !== 'string' || entry.title === '') {
        err(`${where}.entry.title`, 'muss ein nicht-leerer String sein');
        ok = false;
      }
      let group = null;
      if (entry.group !== undefined && entry.group !== null) {
        group = parseGroupPath(entry.group);
        if (!group) {
          err(`${where}.entry.group`, 'muss ein Pfad wie "Dev/Services" oder ein Array ["Dev", "Services"] sein');
          ok = false;
        }
      }
      if (ok) lookup = Object.freeze({ kind: 'path', group, title: entry.title });
    } else {
      err(`${where}.entry`, 'entweder „uuid“ oder „title“ (optional mit „group“) angeben');
      ok = false;
    }
  }
  return ok ? Object.freeze({ username, lookup }) : null;
}

/**
 * Akzeptiert die Hex-Darstellung von KeePass/KeePassXC (32 Zeichen, Bindestriche
 * erlaubt) oder die Base64-Darstellung (22 Zeichen + „==“) aus der XML-Datei.
 * @returns {Buffer|null} 16 Bytes
 */
export function parseUuid(value) {
  if (typeof value !== 'string') return null;
  const hex = value.replace(/[-{}\s]/g, '');
  if (/^[0-9a-fA-F]{32}$/.test(hex)) return Buffer.from(hex, 'hex');
  if (/^[A-Za-z0-9+/]{22}==$/.test(value)) {
    const b = Buffer.from(value, 'base64');
    if (b.length === 16) return b;
  }
  return null;
}

function parseGroupPath(group) {
  let parts;
  if (typeof group === 'string') parts = group.split('/');
  else if (Array.isArray(group)) parts = group;
  else return null;
  if (parts.length === 0) return null;
  if (!parts.every((p) => typeof p === 'string' && p !== '')) return null;
  return Object.freeze([...parts]);
}

function nodeAccepts(name, value) {
  try {
    validateHeaderName(name);
    validateHeaderValue(name, value);
    return true;
  } catch {
    return false;
  }
}

function checkKeys(obj, allowed, where, err) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) err(where, `unbekannter Schlüssel „${key}“ (erlaubt: ${allowed.filter((k) => !k.startsWith('$')).join(', ')})`);
  }
}

// Host-Header-Wert: Hostname/IPv4 oder [IPv6], optional mit Port.
const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

function isOrigin(v) {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === v.toLowerCase();
  } catch {
    return false;
  }
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isTimeout(v) {
  return Number.isInteger(v) && v > 0 && v <= 2_147_483_647;
}
