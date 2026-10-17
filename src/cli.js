import { readFileSync } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from './config.js';
import { KeePassError, openDatabase, resolveCredentials } from './keepass.js';
import { promptHidden } from './prompt.js';
import { advertisedBaseUrl, createProxy } from './proxy.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const MAX_ATTEMPTS = 3;

const HELP = `ai-proxy ${VERSION} – lokaler Reverse-Proxy mit Zugangsdaten aus KeePass

Aufruf:
  ai-proxy [--config <datei>] [--check]

Optionen:
  -c, --config <datei>  Konfigurationsdatei (Standard: ./connection.json)
      --check           Konfiguration und KeePass-Einträge prüfen, dann beenden
  -h, --help            Diese Hilfe anzeigen
  -v, --version         Version anzeigen

Das Master-Passwort wird beim Start verdeckt im Terminal abgefragt.
Es kann absichtlich NICHT per Argument, Umgebungsvariable oder Datei übergeben werden.

Routing: http://<host>:<port>/<pfad>?<query>   (listen.port, Standard 8075)
         mit den Headern X-Proxy-Environment: <umgebung> und X-Proxy-Service: <service>.
         Der Pfad wird unverändert an die konfigurierte Service-URL angehängt.
MCP:     http://<host>:<mcpPort>/mcp            (listen.mcpPort, Standard 8076; eigener Port)
`;

export class UsageError extends Error {}

export function parseCli(argv) {
  if (argv.some((a) => /^--?(p|pw|pass|password|master(-?password)?)(=|$)/i.test(a))) {
    throw new UsageError('Passwörter werden aus Sicherheitsgründen nicht als Argument akzeptiert; das Master-Passwort wird beim Start abgefragt.');
  }
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        config: { type: 'string', short: 'c', default: 'connection.json' },
        check: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    return values;
  } catch (err) {
    throw new UsageError(err.message);
  }
}

/**
 * Startet den Proxy. Alle Ein-/Ausgaben sind injizierbar, damit sich der Ablauf
 * testen lässt.
 * @returns {Promise<{exitCode: number, proxy?: ReturnType<typeof createProxy>, address?: import('node:net').AddressInfo, mcpAddress?: import('node:net').AddressInfo | null}>}
 */
export async function main(argv, { stdout = process.stdout, stderr = process.stderr, prompt = promptHidden } = {}) {
  const out = (s) => stdout.write(`${s}\n`);
  const errOut = (s) => stderr.write(`${s}\n`);

  let opts;
  try {
    opts = parseCli(argv);
  } catch (err) {
    errOut(`Fehler: ${err.message}\n\n${HELP}`);
    return { exitCode: 2 };
  }
  if (opts.help) {
    out(HELP);
    return { exitCode: 0 };
  }
  if (opts.version) {
    out(VERSION);
    return { exitCode: 0 };
  }

  let config;
  try {
    config = await loadConfig(opts.config);
  } catch (err) {
    if (err instanceof ConfigError) {
      errOut(`Fehler: ${err.message}`);
      return { exitCode: 1 };
    }
    throw err;
  }

  let credentials = new Map();
  if (config.needsKeepass) {
    try {
      credentials = await unlock(config, prompt, errOut);
    } catch (err) {
      if (err instanceof KeePassError || err.code === 'ENOTTY' || err.code === 'ABORTED' || err.code === 'EIO') {
        errOut(`Fehler: ${err.message}`);
        return { exitCode: 1 };
      }
      throw err;
    }
  }

  const proxy = createProxy({ config, credentials, version: VERSION, log: (line) => errOut(`${new Date().toISOString()} ${line}`) });

  if (opts.check) {
    const count = credentials.size;
    await proxy.close();
    out(`Konfiguration OK: ${config.environments.length} Umgebung(en), ${config.environments.reduce((n, e) => n + e.services.length, 0)} Service(s), ${count} Zugangsdaten aus KeePass geladen.`);
    return { exitCode: 0 };
  }

  try {
    // Beide Listener oder keiner: scheitert einer, ist der andere schon wieder geschlossen.
    await proxy.listen();
  } catch (err) {
    await proxy.close();
    const label = err.listener === 'mcp' ? 'MCP-Port' : 'Proxy-Port';
    errOut(`Fehler: ${label} ${config.listen.host}:${err.port ?? '?'} kann nicht geöffnet werden (${err.code ?? err.message})`);
    return { exitCode: 1 };
  }

  const address = proxy.server.address();
  const mcpAddress = proxy.mcpServer?.address() ?? null;
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  out(`ai-proxy lauscht auf http://${host}:${address.port} (API, nur mit Routing-Headern)`);
  if (mcpAddress) out(`MCP-Endpunkt (Streamable HTTP, eigener Port): ${advertisedBaseUrl(config.listen.host, mcpAddress.port)}/mcp`);
  if (config.defaultHeaders.length > 0) out(`Standard-Header aus ${config.headersFile}: ${config.defaultHeaders.map(([n]) => n).join(', ')}`);
  out('Routing per X-Proxy-Environment / X-Proxy-Service:');
  for (const env of config.environments) {
    for (const svc of env.services) {
      out(`  ${env.name} / ${svc.name}  ->  ${svc.url}${svc.auth ? '  [Basic Auth]' : ''}`);
    }
  }
  return { exitCode: 0, proxy, address, mcpAddress };
}

async function unlock(config, prompt, errOut) {
  // Fehlende Dateien melden, bevor nach dem Passwort gefragt wird.
  for (const [label, file] of [['KeePass-Datenbank', config.keepass.database], ['Schlüsseldatei', config.keepass.keyFile]]) {
    if (!file) continue;
    try {
      await access(file, constants.R_OK);
    } catch (err) {
      throw new KeePassError(`${label} ${file} kann nicht gelesen werden: ${err.code ?? err.message}`);
    }
  }
  for (let attempt = 1; ; attempt++) {
    const password = await prompt(`Master-Passwort für ${config.keepass.database}: `);
    let db;
    try {
      db = await openDatabase({ ...config.keepass, password });
    } catch (err) {
      if (err instanceof KeePassError && err.code === 'InvalidKey' && attempt < MAX_ATTEMPTS) {
        errOut(`${err.message}. Bitte erneut versuchen (${attempt}/${MAX_ATTEMPTS}).`);
        continue;
      }
      throw err;
    } finally {
      password.fill(0);
    }
    // Nur die benötigten Zugangsdaten herauslösen; die Datenbank selbst wird
    // danach nicht mehr referenziert und kann vom GC eingesammelt werden.
    return resolveCredentials(db, config);
  }
}
