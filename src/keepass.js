import { readFile } from 'node:fs/promises';
import { argon2d, argon2id } from 'hash-wasm';
// kdbxweb ist ein UMD/CommonJS-Bundle; Node 22 erkennt dessen benannte Exporte
// nicht, deshalb wird der Default-Export (module.exports) verwendet.
import kdbxweb from 'kdbxweb';
import { SecretValue, basicAuthHeaderBytes } from './secret.js';

export class KeePassError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message, { cause });
    this.name = 'KeePassError';
    this.code = code;
  }
}

// kdbxweb.CryptoEngine.Argon2Type: 0 = Argon2d, 2 = Argon2id (KDBX4 kennt nur diese beiden).
const ARGON2_TYPES = { 0: argon2d, 2: argon2id };

/**
 * Argon2-Implementierung für kdbxweb auf Basis von hash-wasm (WebAssembly,
 * kein nativer Build, läuft ab Node 22). Signatur wie von kdbxweb erwartet;
 * `memory` ist in KiB.
 */
export async function argon2Impl(password, salt, memory, iterations, length, parallelism, type, version) {
  const fn = ARGON2_TYPES[type];
  if (!fn) throw new KeePassError(`Argon2-Typ ${type} wird nicht unterstützt (nur Argon2d und Argon2id)`, { code: 'Unsupported' });
  if (version !== 0x13) {
    throw new KeePassError(`Argon2-Version 0x${Number(version).toString(16)} wird nicht unterstützt (nur 0x13)`, { code: 'Unsupported' });
  }
  const key = await fn({
    password: new Uint8Array(password),
    salt: new Uint8Array(salt),
    parallelism,
    iterations,
    memorySize: memory,
    hashLength: length,
    outputType: 'binary',
  });
  const out = new ArrayBuffer(key.length);
  new Uint8Array(out).set(key);
  key.fill(0);
  return out;
}

let argon2Installed = false;
export function installArgon2() {
  if (argon2Installed) return;
  kdbxweb.CryptoEngine.setArgon2Impl(argon2Impl);
  argon2Installed = true;
}

/**
 * Öffnet eine KDBX-Datenbank.
 * @param {object} opts
 * @param {string} opts.database Pfad zur .kdbx
 * @param {string|null} [opts.keyFile] Pfad zur Schlüsseldatei
 * @param {Uint8Array} opts.password Master-Passwort als UTF-8-Bytes. Wird von
 *   dieser Funktion NICHT genullt; das ist Aufgabe des Aufrufers.
 */
export async function openDatabase({ database, keyFile = null, password }) {
  installArgon2();
  let data;
  try {
    data = await readFile(database);
  } catch (err) {
    throw new KeePassError(`KeePass-Datenbank ${database} kann nicht gelesen werden: ${err.code ?? err.message}`, { cause: err });
  }
  let keyFileData = null;
  if (keyFile) {
    try {
      keyFileData = await readFile(keyFile);
    } catch (err) {
      throw new KeePassError(`Schlüsseldatei ${keyFile} kann nicht gelesen werden: ${err.code ?? err.message}`, { cause: err });
    }
  }

  // Achtung: ProtectedValue.fromBinary maskiert den übergebenen Puffer in-place
  // und verwendet ihn weiter. Deshalb bekommt kdbxweb eigene Kopien; die
  // Passwort-Kopie (maskiert) wird erst nach dem Laden genullt. Die
  // Schlüsseldatei-Kopie kann kdbxweb dauerhaft referenzieren (32-Byte-Format)
  // und wird deshalb nicht angefasst.
  const pwCopy = toArrayBuffer(password);
  const kfCopy = keyFileData ? toArrayBuffer(keyFileData) : null;
  keyFileData?.fill(0);
  try {
    const credentials = new kdbxweb.Credentials(
      pwCopy.byteLength > 0 ? kdbxweb.ProtectedValue.fromBinary(pwCopy) : null,
      kfCopy,
    );
    await credentials.ready;
    return await kdbxweb.Kdbx.load(toArrayBuffer(data), credentials);
  } catch (err) {
    if (err instanceof kdbxweb.KdbxError) {
      if (err.code === kdbxweb.Consts.ErrorCodes.InvalidKey) {
        throw new KeePassError('Master-Passwort oder Schlüsseldatei ist falsch', { code: 'InvalidKey', cause: err });
      }
      throw new KeePassError(`KeePass-Datenbank kann nicht geöffnet werden (${err.code}): ${err.message}`, { code: err.code, cause: err });
    }
    if (err instanceof KeePassError) throw err;
    throw new KeePassError(`KeePass-Datenbank kann nicht geöffnet werden: ${err.message}`, { cause: err });
  } finally {
    new Uint8Array(pwCopy).fill(0);
  }
}

/**
 * Löst für alle Services mit `auth` die Zugangsdaten auf und liefert eine Map
 * „env/service“ → SecretValue (fertiger Authorization-Headerwert).
 * Bricht beim ersten Problem nicht ab, sondern sammelt alle Fehler.
 */
export function resolveCredentials(db, config) {
  const index = buildIndex(db);
  const result = new Map();
  const errors = [];
  for (const env of config.environments) {
    for (const svc of env.services) {
      if (!svc.auth) continue;
      const key = `${env.name}/${svc.name}`;
      try {
        const entry = findEntry(index, svc.auth.lookup);
        result.set(key, credentialFromEntry(entry, svc.auth.username, index));
      } catch (err) {
        if (!(err instanceof KeePassError)) throw err;
        errors.push(`${key}: ${err.message}`);
      }
    }
  }
  if (errors.length > 0) {
    for (const secret of result.values()) secret.dispose();
    throw new KeePassError(`Zugangsdaten konnten nicht aufgelöst werden:\n  - ${errors.join('\n  - ')}`, { code: 'Unresolved' });
  }
  return result;
}

function buildIndex(db) {
  const root = db.getDefaultGroup();
  const recycleBinUuid = db.meta.recycleBinEnabled !== false ? db.meta.recycleBinUuid : undefined;
  const isRecycleBin = (g) => recycleBinUuid && !recycleBinUuid.empty && g.uuid.equals(recycleBinUuid);
  /** @type {{entry: any, path: string[], inRecycleBin: boolean}[]} */
  const entries = [];
  const walk = (group, pathParts, inBin) => {
    for (const e of group.entries) entries.push({ entry: e, path: pathParts, inRecycleBin: inBin });
    for (const g of group.groups) walk(g, [...pathParts, g.name ?? ''], inBin || isRecycleBin(g));
  };
  walk(root, [], false);
  return { root, entries, isRecycleBin };
}

function findEntry(index, lookup) {
  if (lookup.kind === 'uuid') {
    const wanted = Buffer.from(lookup.uuid, 'hex');
    const hits = index.entries.filter((x) => Buffer.from(x.entry.uuid.bytes).equals(wanted));
    if (hits.length === 0) throw new KeePassError(`Kein Eintrag mit UUID ${lookup.uuid} gefunden`);
    if (hits.length > 1) throw new KeePassError(`UUID ${lookup.uuid} ist mehrfach vorhanden`);
    if (hits[0].inRecycleBin) throw new KeePassError(`Eintrag mit UUID ${lookup.uuid} liegt im Papierkorb`);
    return hits[0];
  }

  const title = lookup.title;
  let candidates;
  if (lookup.group) {
    let group = index.root;
    const walked = [];
    for (const name of lookup.group) {
      walked.push(name);
      const matches = group.groups.filter((g) => g.name === name && !index.isRecycleBin(g));
      if (matches.length === 0) throw new KeePassError(`Gruppe „${walked.join('/')}“ nicht gefunden`);
      if (matches.length > 1) throw new KeePassError(`Gruppe „${walked.join('/')}“ ist mehrdeutig (${matches.length} gleichnamige Gruppen)`);
      group = matches[0];
    }
    candidates = index.entries.filter((x) => x.entry.parentGroup === group && fieldText(x.entry, 'Title') === title);
    const where = `„${lookup.group.join('/')}/${title}“`;
    if (candidates.length === 0) throw new KeePassError(`Kein Eintrag ${where} gefunden`);
    if (candidates.length > 1) throw new KeePassError(`Eintrag ${where} ist mehrdeutig (${candidates.length} Treffer) – bitte UUID verwenden`);
    return candidates[0];
  }

  candidates = index.entries.filter((x) => !x.inRecycleBin && fieldText(x.entry, 'Title') === title);
  if (candidates.length === 0) throw new KeePassError(`Kein Eintrag mit Titel „${title}“ gefunden`);
  if (candidates.length > 1) {
    const where = candidates.map((c) => `„${[...c.path, title].join('/')}“`).join(', ');
    throw new KeePassError(`Titel „${title}“ ist mehrdeutig (${where}) – bitte „group“ oder „uuid“ angeben`);
  }
  return candidates[0];
}

function credentialFromEntry(hit, configUsername) {
  const { entry } = hit;
  const label = `„${[...hit.path, fieldText(entry, 'Title') ?? ''].join('/')}“`;

  let username;
  if (configUsername) {
    username = Buffer.from(configUsername, 'utf8');
  } else {
    username = fieldBytes(entry, 'UserName');
    if (!username || username.length === 0) {
      throw new KeePassError(`Kein Benutzername: weder in der Konfiguration („auth.username“) noch im KeePass-Eintrag ${label}`);
    }
    if (username.includes(0x3a)) {
      username.fill(0);
      throw new KeePassError(`Benutzername im KeePass-Eintrag ${label} enthält einen Doppelpunkt (bei Basic Auth nicht erlaubt)`);
    }
  }

  const password = fieldBytes(entry, 'Password');
  if (!password || password.length === 0) {
    username.fill(0);
    throw new KeePassError(`KeePass-Eintrag ${label} hat kein Passwort`);
  }

  const header = basicAuthHeaderBytes(username, password);
  try {
    return new SecretValue(header);
  } finally {
    header.fill(0);
    username.fill(0);
    password.fill(0);
  }
}

function fieldText(entry, name) {
  const v = entry.fields.get(name);
  if (v === undefined) return undefined;
  return v instanceof kdbxweb.ProtectedValue ? v.getText() : v;
}

/** Liefert ein Feld als frische Byte-Kopie, die der Aufrufer nullen muss. */
function fieldBytes(entry, name) {
  const v = entry.fields.get(name);
  if (v === undefined) return null;
  if (v instanceof kdbxweb.ProtectedValue) {
    const bin = v.getBinary();
    const copy = Buffer.from(bin);
    bin.fill(0);
    return copy;
  }
  return Buffer.from(String(v), 'utf8');
}

function toArrayBuffer(u8) {
  // Kopie, damit der Aufrufer seinen Puffer unabhängig nullen kann.
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}

export { kdbxweb };
