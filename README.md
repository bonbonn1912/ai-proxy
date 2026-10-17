# ai-proxy

Lokaler Reverse-Proxy für viele Microservices über mehrere Umgebungen
(dev, test, prod …). URLs und Benutzernamen stehen in `connection.json`.
Passwörter kommen ausschließlich aus einer KeePass-Datenbank (`.kdbx`, KDBX4
mit Argon2d/Argon2id). Das Master-Passwort wird beim Start verdeckt abgefragt.
Alle Geheimnisse liegen nur im Arbeitsspeicher.

Lokale Werkzeuge, Skripte oder KI-Agenten rufen den Proxy ohne Zugangsdaten auf.
Der Proxy setzt pro Service den passenden `Authorization: Basic …`-Header und
reicht Requests und Antworten gestreamt und möglichst unverändert durch.

Welcher Service gemeint ist, steht nicht im Pfad, sondern in zwei Headern:
`X-Proxy-Environment` und `X-Proxy-Service`. Der Pfad samt Query geht unverändert
an die konfigurierte Service-URL.

Über einen eingebauten **MCP-Endpunkt** auf einem **eigenen Port**
(`http://127.0.0.1:8076/mcp`) kann z. B. die Gemini CLI selbst herausfinden, welche
Umgebungen und Services es gibt. Die Route (Methode, Pfad, Body) liest Gemini aus der
OpenAPI-YAML im lokalen Spring-Boot-Projekt; die API-Aufrufe gehen an den Proxy-Port
`http://127.0.0.1:8075`.

![Architektur](architecture.png)

| Listener | Standard | Aufgabe |
|---|---|---|
| Proxy (`listen.port`) | `127.0.0.1:8075` | leitet **nur** Requests mit `X-Proxy-Environment` + `X-Proxy-Service` weiter (auch den Pfad `/mcp`); kein MCP |
| MCP (`listen.mcpPort`) | `127.0.0.1:8076` | **nur** `/mcp` (Erkennung von Umgebungen/Services); leitet **nie** weiter, auch nicht mit Routing-Headern |

**Gemeinsamer Lebenszyklus:** Beide Listener gehören zum selben Prozess
(`npm start` bzw. `ai-proxy`). Es gibt keinen eigenständigen MCP-Dienst, keinen
Hintergrund-Daemon und keinen Autostart. Beide werden erst nach erfolgreich
geladener Konfiguration und entsperrter KeePass-Datenbank gebunden; scheitert das
Binden eines der beiden Ports, wird der andere sofort wieder geschlossen, die
Zugangsdaten werden genullt und der Prozess endet mit Exit-Code `1`. `SIGINT`/`SIGTERM`
(Strg+C) beenden beide gemeinsam. `--check` bindet keinen Port. Gemini, Codex & Co.
verbinden sich nur per HTTP-URL mit dem laufenden Prozess und starten ihn nicht.

```
Client ──► http://127.0.0.1:8075/v1/kunden?id=7
           X-Proxy-Environment: dev
           X-Proxy-Service: kunden
                    │  − X-Proxy-Environment, X-Proxy-Service
                    │  + Standard-Header aus headers.json (optional)
                    │  + Authorization: Basic … (aus KeePass)
                    ▼
           https://kunden.dev.example.com/api/v1/kunden?id=7
```

## Voraussetzungen

- Node.js **22 oder neuer** (getestet mit 22.12 und 26)
- Abhängigkeiten (bewusst minimal):
  - [`kdbxweb`](https://github.com/keeweb/kdbxweb) liest KDBX-Dateien.
  - [`hash-wasm`](https://github.com/Daninet/hash-wasm) liefert Argon2 als WebAssembly, ohne nativen Build.
  - Für HTTP, Proxy und MCP wird nur Node selbst verwendet (`node:http`/`node:https`).

```bash
npm install
cp connection.example.json connection.json   # anpassen
cp headers.example.json headers.json         # optionale Standard-Header
npm start                                     # oder: node bin/ai-proxy.js -c connection.json
```

Optional lässt sich der Befehl global verfügbar machen: `npm link`, danach `ai-proxy`.

## Aufruf

```
ai-proxy [--config <datei>] [--check]

  -c, --config <datei>  Konfigurationsdatei (Standard: ./connection.json)
      --check           Konfiguration und KeePass-Einträge prüfen, dann beenden
  -h, --help            Hilfe
  -v, --version         Version
```

Ablauf beim Start:

1. `connection.json` wird gelesen und vollständig validiert. Alle Fehler werden auf
   einmal gemeldet, auch Tippfehler bei Schlüsseln. Ist `headersFile` gesetzt, wird
   auch diese Datei gelesen und geprüft. Fehlt sie oder ist sie ungültig, bricht der
   Start ab, noch vor der Passwortabfrage.
2. Nur wenn mindestens ein Service `auth` nutzt: Der Proxy prüft, ob die KeePass-Datei
   (und ggf. die Schlüsseldatei) lesbar ist. Danach fragt er das Master-Passwort
   **verdeckt** im Terminal ab. Es gibt höchstens 3 Versuche.
3. Alle benötigten Einträge werden aufgelöst. Fehlt ein Eintrag, ist er mehrdeutig
   oder fehlt ein Benutzername oder Passwort, bricht der Proxy **vor** dem Start ab.
4. Erst jetzt bindet er gemeinsam den Proxy-Port (8075) und – bei `mcp: true` – den
   MCP-Port (8076). Ist einer belegt, wird der andere wieder geschlossen und der Start
   bricht mit Exit-Code `1` ab. Danach listet er alle Umgebungen und Services auf.

Das Master-Passwort kann absichtlich **nicht** per Argument, Umgebungsvariable,
Datei oder Pipe übergeben werden. Ohne interaktives Terminal (TTY) bricht der Start ab.
`--password` und ähnliche Optionen werden mit einer Fehlermeldung abgelehnt.

Beenden mit `Strg+C`: Der Proxy schließt alle Verbindungen und überschreibt die
Zugangsdaten im Speicher mit Nullen. Wird der Prozess während der Passwortabfrage
per Signal (`SIGINT`, `SIGTERM`, `SIGHUP`) beendet, stellt er den Terminalmodus
wieder her.

## Konfiguration (`connection.json`)

```json
{
  "listen": { "host": "127.0.0.1", "port": 8075, "mcpPort": 8076 },
  "keepass": { "database": "./zugangsdaten.kdbx", "keyFile": null },
  "upstream": { "timeoutMs": 30000 },
  "mcp": true,
  "headersFile": "./headers.json",
  "environments": {
    "dev": {
      "kunden": {
        "url": "https://kunden.dev.example.com/api",
        "auth": {
          "username": "svc-kunden-dev",
          "entry": { "group": "Dev/Services", "title": "kunden" }
        }
      },
      "bestellungen": {
        "url": "https://bestellungen.dev.example.com",
        "auth": { "entry": { "uuid": "3F2504E0-4F89-11D3-9A0C-0305E82C3301" } }
      },
      "katalog": "http://localhost:9003/katalog"
    },
    "test": {
      "kunden": {
        "url": "https://kunden.test.example.com/api",
        "timeoutMs": 60000,
        "auth": { "entry": { "group": ["Test", "Services"], "title": "kunden" } }
      }
    }
  }
}
```

| Schlüssel | Bedeutung | Standard |
|---|---|---|
| `listen.host` | Adresse, an die Proxy- **und** MCP-Listener binden | `127.0.0.1` |
| `listen.port` | Port des Proxy-Listeners (API-Weiterleitung; `0` = beliebiger freier Port) | `8075` |
| `listen.mcpPort` | Port des MCP-Listeners (nur `/mcp`; `0` = beliebiger freier Port). Muss sich von `listen.port` unterscheiden. | `8076` |
| `listen.allowedHosts` | zusätzliche, **exakte** `Host`-Header-Werte (für beide Listener), z. B. `["proxy.lan:8075"]` | `[]` |
| `listen.allowedOrigins` | zusätzliche, **exakte** Browser-Origins, z. B. `["http://localhost:3000"]` | `[]` |
| `keepass.database` | Pfad zur `.kdbx`. Wird relativ zur `connection.json` aufgelöst. | nötig, sobald ein Service `auth` hat |
| `keepass.keyFile` | optionale Schlüsseldatei | `null` |
| `upstream.timeoutMs` | Leerlauf-Timeout zum Upstream (Verbindungsaufbau und Pausen zwischen Daten) | `30000` |
| `mcp` | MCP-Listener auf `listen.mcpPort` starten (`false` = nur der Proxy-Listener) | `true` |
| `headersFile` | JSON-Datei mit Standard-Headern für jeden weitergeleiteten Request, relativ zur `connection.json` (siehe unten) | keine |
| `environments.<env>.<service>` | URL als String oder Objekt `{ url, auth?, timeoutMs? }` | – |

Regeln:

- Namen von Umgebungen und Services dürfen nur `A–Z a–z 0–9 . _ ~ -` enthalten.
  Sie werden 1:1 als Wert der Routing-Header verwendet, Groß-/Kleinschreibung zählt.
- `url` muss `http://` oder `https://` sein und darf weder Zugangsdaten noch
  Query-String noch Fragment enthalten. Ein Basis-Pfad (`/api`) ist erlaubt.
- **Die `url` ist für den Basis-Pfad des Services verantwortlich.** Sie enthält
  alles, was vor den Pfaden aus `paths` der OpenAPI-Spec steht: Spring-Context-Path
  (`server.servlet.context-path`, `spring.webflux.base-path`) und den Pfadanteil der
  `servers`-URL. Beispiel: Context-Path `/kunden-service`, Spec-Pfad `/kunden/{id}` →
  `"url": "https://h/kunden-service"`, der Agent ruft `/kunden/7` auf. Der Agent
  sieht die Upstream-URL nicht und hängt deshalb nie selbst einen Context-Path an.
- Services ohne `auth` werden ohne eigene Authentifizierung weitergeleitet.
  Ein vom Client mitgeschickter `Authorization`-Header bleibt dann erhalten.

### Standard-Header (`headers.json`)

Mit `"headersFile": "./headers.json"` hängt der Proxy feste Header an jeden
weitergeleiteten Request, z. B. zur Kennzeichnung des Clients. Der Pfad wird relativ
zum Verzeichnis der `connection.json` aufgelöst. Ohne `headersFile` gibt es keine
Standard-Header. Vorlage: [`headers.example.json`](headers.example.json),
die echte `headers.json` ist in `.gitignore`.

```json
{
  "X-Client-Name": "ai-proxy"
}
```

- Ein JSON-Objekt `{ "Name": "Wert" }`, Werte nur als String. `{}` ist erlaubt.
- Namen müssen gültige HTTP-Token sein. Werte dürfen nicht leer sein, keine
  Steuerzeichen (also auch kein CR/LF), keinen Leerraum am Anfang oder Ende und nur
  Latin-1-Zeichen enthalten. Geprüft wird zusätzlich mit den Validatoren von `node:http`.
- Doppelte Namen, die sich nur in der Groß-/Kleinschreibung unterscheiden
  (`X-Team` und `x-team`), sind ein Fehler. Exakt gleiche Schlüssel kann
  `JSON.parse` nicht erkennen; dort gewinnt stillschweigend der letzte.
- **Nicht erlaubt** sind Header, die der Proxy selbst verwaltet oder die nur für eine
  Verbindung gelten: `X-Proxy-Environment`, `X-Proxy-Service`, `Host`,
  `Content-Length`, `Transfer-Encoding`, `Connection`, `Keep-Alive`,
  `Proxy-Connection`, `Proxy-Authenticate`, `TE`, `Trailer`, `Upgrade`, `Expect`,
  sowie `Authorization` und `Proxy-Authorization`. Zugangsdaten kommen
  ausschließlich aus KeePass.
- Die Datei wird beim Start gelesen. Fehlt sie oder ist sie ungültig, startet der
  Proxy nicht. Änderungen wirken erst nach einem Neustart.

Vorrang (niedrig → hoch), Namen ohne Rücksicht auf Groß-/Kleinschreibung:

1. Standard-Header aus der Datei
2. Ende-zu-Ende-Header des Clients: **Ein Client kann jeden Standard-Header
   bewusst überschreiben**, indem er ihn selbst mitschickt.
3. `Host` des Ziels und die Basic Auth aus KeePass

Standard-Header und Client-Header werden zuerst zusammengeführt und dann einmal
gefiltert. Benennt der Client einen Header in `Connection: …`, entfällt er also auch
dann, wenn er aus der Datei stammt. Verbotene Header kann man darüber nicht
zurückholen, und `Host` und `Authorization` setzt der Proxy erst nach dem Filtern.

### Basic Auth und KeePass-Einträge

`auth.entry` verweist auf genau **einen** KeePass-Eintrag, auf eine von zwei Arten:

1. **Per UUID**, die eindeutigste Variante: `{ "uuid": "…" }`.
   Akzeptiert werden die 32-stellige Hex-Darstellung (mit oder ohne Bindestriche)
   und die Base64-Form aus der KDBX-XML. In KeePassXC findet man die UUID unter
   *Eintrag bearbeiten → Erweitert*. In KeePass 2 steht sie unter
   *Eigenschaften → UUID*.
2. **Per Gruppe und Titel**: `{ "group": "Dev/Services", "title": "kunden" }`
   - `group` ist der Pfad **unterhalb** der Wurzelgruppe, als String mit `/` oder als
     Array (`["Dev", "Services"]`). Das Array braucht man, wenn ein Gruppenname
     selbst einen `/` enthält.
   - Gesucht wird nur direkt in dieser Gruppe, nicht in Untergruppen.
   - Ohne `group` wird die ganze Datenbank nach dem Titel durchsucht.

Der Papierkorb wird nie berücksichtigt. **Mehrdeutigkeit ist ein Fehler:** Gibt es
mehrere gleichnamige Gruppen auf dem Pfad oder mehrere Einträge mit dem Titel,
bricht der Start mit einer Liste der Fundstellen ab. Passwörter tauchen in keiner
Fehlermeldung auf.

Benutzername:

- `auth.username` in der Konfiguration **hat Vorrang**.
- Sonst wird das Feld *Benutzername* des KeePass-Eintrags verwendet.
- Fehlen beide, startet der Proxy nicht. Ein Benutzername mit `:` ist bei Basic
  Auth nicht erlaubt.

Passwort: immer aus dem Feld *Passwort* des Eintrags. Ein leeres Passwort ist ein Fehler.

### KeePass-Datenbank anlegen

KeePassXC und KeePass 2.x legen neue Datenbanken standardmäßig als KDBX4 mit
Argon2 an. Das passt so. Ältere KDBX3-Dateien mit AES-KDF funktionieren ebenfalls.
Argon2 mit Version 0x10 (sehr alt) wird nicht unterstützt.

1. Neue Datenbank anlegen, z. B. `zugangsdaten.kdbx` neben `connection.json`.
2. Gruppen nach Belieben anlegen, z. B. `Dev/Services` und `Test/Services`.
3. Pro technischem Benutzer einen Eintrag mit Titel, Benutzername und Passwort anlegen.
4. In `connection.json` per `group`/`title` oder `uuid` darauf verweisen.
5. `ai-proxy --check` ausführen: Das prüft alle Einträge, ohne zu lauschen.

## Routing

```
curl -g --path-as-is \
  -H 'X-Proxy-Environment: dev' -H 'X-Proxy-Service: kunden' \
  'http://127.0.0.1:8075/v1/kunden?id=7'
```

- Jeder weitergeleitete Request braucht **genau einen** `X-Proxy-Environment`- und
  **genau einen** `X-Proxy-Service`-Header mit einem gültigen Namen. Mehrfach
  gesendete Header gelten unabhängig von der Groß-/Kleinschreibung als Duplikat.
  - fehlend, doppelt, leer oder ungültig (z. B. `dev, test`) → `400`
  - unbekannte Umgebung oder unbekannter Service → `404`
  - Beide Antworten listen die gültigen Kombinationen auf.
- Beide Header werden entfernt, bevor der Request zum Upstream geht.
- Der **komplette** Pfad samt Query wird **byte-genau** an den Pfad der Upstream-URL
  angehängt. Es wird nichts entfernt, dekodiert, normalisiert oder umsortiert:
  `%2F`, `..`, `;matrix` und doppelte Query-Parameter bleiben, wie sie sind.
  Auch `/dev/kunden/x` oder `/local/demo/x` ist einfach ein Pfad und wird nicht
  als Route gedeutet. Das frühere Präfix-Routing `/<umgebung>/<service>/…` gibt es
  nicht mehr.
- Erlaubt ist nur die übliche Pfadform (`/pfad?query`). Absolute URLs
  (`GET http://host/x`), `*`, Ziele mit `//` am Anfang und Fragmente (`#`) werden
  mit `400` abgewiesen. `curl -g --path-as-is` verhindert, dass curl `[]`/`{}`
  deutet oder `..` selbst auflöst.

| Request an den Proxy | Upstream (`url` = `https://h/api`) |
|---|---|
| `/` | `https://h/api/` |
| `/?x=1` | `https://h/api/?x=1` |
| `/v1/a%2Fb?x=1&x=2` | `https://h/api/v1/a%2Fb?x=1&x=2` |
| `/dev/kunden/x` | `https://h/api/dev/kunden/x` |

### `/mcp`

Proxy- und MCP-Listener sind getrennt; es gibt keine Weiterleitung zwischen beiden:

- **Proxy-Port (8075):** `/mcp` ist ein ganz normaler Pfad. Mit beiden Routing-Headern
  wird er an den Service weitergeleitet, ohne (oder mit nur einem) Routing-Header
  gibt es `400` – auch bei `mcp: false`.
- **MCP-Port (8076):** Nur `/mcp` (ggf. mit Query) ist der MCP-Endpunkt. Andere
  Pfade → `404`, Requests mit Routing-Headern → `400`. Beides mit Hinweis auf den
  Proxy-Port; weitergeleitet wird hier nie.

## Weiterleitungsverhalten

- **Methode, Body, Status, Statustext und Header** werden durchgereicht.
  Groß-/Kleinschreibung, Reihenfolge und Duplikate (z. B. mehrere `Set-Cookie`)
  bleiben erhalten.
- **Streaming** in beide Richtungen, ohne Pufferung. Große Uploads, Downloads und
  Server-Sent Events funktionieren.
- **Entfernt** werden nur Hop-by-Hop-Header (`Connection`, `Keep-Alive`,
  `Proxy-Connection`, `Proxy-Authenticate`, `Proxy-Authorization`, `TE`,
  `Trailer`, `Transfer-Encoding`, `Upgrade`) sowie alle Header, die in
  `Connection: …` aufgezählt sind. Außerdem `Expect`, weil der Proxy
  `100 Continue` selbst beantwortet.
- `X-Proxy-Environment` und `X-Proxy-Service` werden entfernt.
- Standard-Header aus `headersFile` werden ergänzt, sofern der Client sie nicht
  selbst schickt (siehe oben).
- `Host` wird auf den Host der Upstream-URL gesetzt.
- Bei Services mit `auth` ersetzt der Proxy einen vorhandenen `Authorization`-Header
  durch den eigenen. Das lässt sich auch mit `Connection: Authorization` nicht
  verhindern.
- **Keine Redirects folgen:** `3xx` und `Location` gehen unverändert an den Client.
- Der Proxy fügt keine `X-Forwarded-*`-, `Via`- oder `Date`-Header hinzu.
- Fehler erzeugt der Proxy selbst. Solche Antworten tragen `X-Proxy-Error: 1`.
  - `400`: fehlende/doppelte/ungültige Routing-Header, ungültiges Request-Target
  - `404`: unbekannte Umgebung oder unbekannter Service
  - `502`: Upstream nicht erreichbar (z. B. `ECONNREFUSED`, DNS, TLS)
  - `504`: kein Lebenszeichen innerhalb von `timeoutMs`
  - Bricht der Upstream **während** der Antwort ab, wird die Client-Verbindung hart
    geschlossen, damit der Client den Abbruch bemerkt.
  - Bricht der **Client** ab, wird auch der Upstream-Request abgebrochen.
- TLS: Es gelten die Zertifikatsprüfung und die CA-Liste von Node. Firmeneigene CAs
  bindet man über `NODE_EXTRA_CA_CERTS=/pfad/ca.pem` ein.

Nicht unterstützt: WebSockets/`Upgrade`, `CONNECT`, HTTP/2 zum Client,
Request- und Response-Trailer, das Weiterreichen von `1xx`-Zwischenantworten
(z. B. `103 Early Hints`) und das Umschreiben von `Location`-Headern.

### Log

Pro Request schreibt der Proxy eine Zeile auf stderr:
`2026-10-16T… GET dev/kunden -> 200 12ms`.
Die Zeile enthält bewusst **keinen** Pfad, Query-String oder Header, weil dort
Tokens oder personenbezogene IDs stehen können.

## MCP-Endpunkt für Gemini CLI und andere KI-Agenten

Solange der Proxy läuft, bietet er auf dem eigenen MCP-Port unter
`http://127.0.0.1:8076/mcp` einen MCP-Server (Model Context Protocol) an. Der
MCP-Listener lebt und stirbt mit dem Proxy-Prozess (siehe oben):

- Transport: *Streamable HTTP*, zustandslos.
- Antworten kommen als `application/json`. Es gibt keine Sessions und keinen
  SSE-Stream, `GET` liefert `405`.
- Unterstützte Protokollversionen: `2025-11-25`, `2025-06-18`, `2025-03-26`.

Es gibt genau zwei Tools, beide nur lesend:

| Tool | Parameter | Antwort (Text, kompaktes JSON) |
|---|---|---|
| `list_environments` | – | `["dev","test"]` |
| `list_services` | `environment` (string) | `{"proxyUrl":"http://127.0.0.1:8075","services":["kunden","bestellungen"]}` |

- Beide Antworten werden direkt aus der geladenen `connection.json` erzeugt.
  Es gibt keine separat gepflegte Liste.
- Das Eingabeschema von `list_services` enthält die Umgebungsnamen als `enum`.
- `proxyUrl` ist immer die URL des **Proxy-Listeners** (8075), nicht die des
  MCP-Listeners (8076), über den gefragt wurde.
- Herausgegeben werden **nur Namen und die lokale Proxy-URL** (einmal, nicht pro
  Service): keine Upstream-URLs, Benutzernamen, KeePass-Verweise oder Passwörter.
- Der Agent ruft `proxyUrl` + Pfad mit beiden Routing-Headern auf, z. B.
  `curl -g --path-as-is -H 'X-Proxy-Environment: dev' -H 'X-Proxy-Service: kunden' 'http://127.0.0.1:8075/v1/kunden?id=7'`.
  Die Authentifizierung übernimmt der Proxy.
- Bei einer unbekannten Umgebung kommt ein Tool-Fehler (`isError: true`) mit der
  Liste der gültigen Umgebungen. Unbekannte Parameter werden ebenfalls als
  Tool-Fehler abgewiesen.
- Ungültige JSON-RPC-Nachrichten beantwortet der Server mit `400` und einem
  JSON-RPC-Fehler: `-32700` bei Parse-Fehlern, `-32600` bei ungültigen Requests,
  jeweils mit `id: null` bzw. der gesendeten id. Unbekannte Methoden ergeben
  `-32601`, ungültige Parameter `-32602`.

### Ablauf für den Agenten

Beim `initialize` schickt der Server kurze `instructions` mit (Text in
`src/mcp.js`, `MCP_INSTRUCTIONS`), die Tool-Beschreibungen verweisen darauf.
Damit soll ein Auftrag wie *„mache Aufruf XY mit proxy-mcp“* so ablaufen:

1. `list_environments`. Ist die Umgebung nicht eindeutig, fragt der Agent nach.
2. `list_services({"environment":"dev"})` liefert `proxyUrl` und die Servicenamen.
   Ist der Service nicht eindeutig, fragt der Agent nach.
3. **Route aus dem lokalen Spring-Boot-Projekt lesen.** Der Agent hat das Projekt des
   Services im Workspace und liest dessen OpenAPI-YAML direkt (z. B. per
   `rg --files` nach `*openapi*.yml|yaml|json`, `*swagger*`; nur im Workspace bzw. in
   freigegebenen Ordnern). Daraus bestimmt er Methode, Pfad aus `paths`, Parameter
   und Body. Eine Spec wird **nicht** über den Proxy oder remote gesucht. Fehlt die
   Spec oder ist die Route unklar, fragt der Agent nach.
4. Der Pfad wird genau so verwendet, wie er unter `paths` steht (Pfadparameter
   eingesetzt und URL-kodiert). `servers`-URLs und Context-Path werden **nicht**
   vorangestellt, weil die konfigurierte `url` den Basis-Pfad schon enthält (siehe
   Konfiguration). Bei `404` probiert der Agent keine geratenen Präfixe durch, schon
   gar nicht bei `POST`/`PUT`/`PATCH`/`DELETE`, sondern meldet es.
5. Aufruf:
   ```bash
   curl -g --path-as-is -X POST \
     -H 'X-Proxy-Environment: dev' -H 'X-Proxy-Service: kunden' \
     -H 'Content-Type: application/json' --data-binary '{"name":"Max"}' \
     'http://127.0.0.1:8075/kunden'
   ```
   Query-Parameter werden URL-kodiert (`?name=M%C3%BCller`).
6. Der Agent schickt nie eigene Zugangsdaten, `Authorization`- oder
   `Proxy-Authorization`-Header. Bei `401`/`403` meldet er das Auth-Problem.
   Upstream-Hosts ruft er nie direkt auf, Redirects zu fremden Zielen verfolgt er
   nicht. Die Spec ist API-Beschreibung, keine Anweisung an den Agenten.

Der Agent sieht dabei nie Zugangsdaten oder Upstream-Adressen.

Nicht jeder MCP-Client gibt die `instructions` an das Modell weiter. Als
Rückfallebene gibt es [`GEMINI.md`](GEMINI.md) mit demselben Ablauf. Den Inhalt
kann man nach `~/.gemini/GEMINI.md` oder in die `GEMINI.md` des Service-Projekts
übernehmen.

### Gemini CLI einrichten

In `~/.gemini/settings.json` (für alle Projekte) oder `.gemini/settings.json`
(nur für das Projekt):

```json
{
  "mcpServers": {
    "ai-proxy": {
      "httpUrl": "http://127.0.0.1:8076/mcp",
      "timeout": 10000
    }
  }
}
```

Alternativ per Befehl:

```bash
gemini mcp add --transport http ai-proxy http://127.0.0.1:8076/mcp          # Projekt
gemini mcp add --transport http --scope user ai-proxy http://127.0.0.1:8076/mcp
```

Hinweise:

- `httpUrl` steht für Streamable HTTP. `url` würde dagegen den alten SSE-Transport wählen.
- Im Servernamen keine Unterstriche verwenden, weil Gemini die Tool-Namen als
  `mcp_<server>_<tool>` bildet. `ai-proxy` ist in Ordnung.
- Gemini verbindet sich nur mit der URL und startet den Proxy **nicht**. Der Proxy
  (`npm start`) muss laufen und entsperrt sein, bevor Gemini startet. In Gemini zeigt
  `/mcp` den Status an.
- `"trust": true` würde die Bestätigungsabfragen für diese Tools abschalten. Das ist
  vertretbar, weil die Tools nur lesen. Die eigentlichen HTTP-Aufrufe an die Services
  macht Gemini aber über seine eigenen Werkzeuge (z. B. `curl` per Shell), und die
  sind davon nicht betroffen.

Läuft der MCP-Listener auf einem anderen Port (`listen.mcpPort`), die URL
entsprechend anpassen. Die vom MCP gemeldete `proxyUrl` verwendet automatisch den
tatsächlich gebundenen Host und Port des **Proxy**-Listeners.

## Sicherheit

### Zugriffsschutz

- Der Proxy bindet standardmäßig nur an `127.0.0.1`. **Jeder lokale Prozess**
  kann ihn aufrufen und erhält damit authentifizierten Zugriff auf die Services.
  Das ist der Zweck des Proxys. Man sollte ihn aber nur auf Rechnern betreiben, auf
  denen man das akzeptiert, und `listen.host` nicht ohne Not auf `0.0.0.0` setzen.
- **Host-Prüfung gegen DNS-Rebinding**: Für alle Requests, also Weiterleitungen **und**
  `/mcp`, muss der `Host`-Header **exakt** einem erlaubten Wert entsprechen.
  - Erlaubt sind `127.0.0.1:<port>`, `localhost:<port>` und `[::1]:<port>` bzw. der
    konfigurierte Host, plus `listen.allowedHosts`.
  - `<port>` ist der tatsächlich gebundene Port **des jeweiligen Listeners**: Am
    MCP-Port wird `127.0.0.1:8075` abgewiesen, am Proxy-Port `127.0.0.1:8076` (gilt
    ebenso für `Origin`).
  - Es gibt keinen Präfix- oder Suffix-Vergleich. `localhost.evil.example` wird abgewiesen.
- **Origin-Prüfung gegen Cross-Origin-Zugriffe aus dem Browser**:
  - Requests ohne `Origin` (curl, CLI-Tools, Gemini) sind erlaubt.
  - Ist ein `Origin` vorhanden, muss er exakt `http://<erlaubter Host>` oder ein
    Eintrag aus `listen.allowedOrigins` sein. Sonst antwortet der Proxy mit `403`,
    wie es die MCP-Spezifikation verlangt.
  - So können fremde Webseiten keine authentifizierten POST-Requests über den Proxy
    absetzen.
  - Grenze: Einfache `GET`-Requests aus dem Browser ohne `Origin` (z. B. `<img>`)
    werden zwar weitergeleitet, die fremde Seite kann die Antwort aber nicht lesen.

### Umgang mit Geheimnissen

- Das Master-Passwort wird im Raw-Modus byteweise in einen `Buffer` gelesen. Es wird
  nie zu einem JavaScript-String und nach dem Öffnen der Datenbank mit Nullen
  überschrieben.
- Aus der Datenbank werden nur die benötigten Einträge gelesen. Pro Service entsteht
  daraus der fertige Header-Wert `Basic base64(user:pass)`. Er wird ohne
  Zwischen-Strings in einen `Buffer` kodiert und XOR-maskiert mit einem
  Zufallsschlüssel gespeichert (`SecretValue`). Danach wird die Datenbank nicht mehr
  referenziert. Beim Beenden werden alle `SecretValue` genullt.
- Nichts davon wird geloggt oder auf die Platte geschrieben. `SecretValue` gibt bei
  `toString`, `JSON.stringify` und `console.log` nur `[SecretValue]` aus.
  Fehlermeldungen nennen Eintragspfade, aber nie Passwörter.

### Grenzen der Speicherbereinigung in JavaScript

Ehrlich gesagt: Vollständiges, garantiertes Löschen von Geheimnissen ist in Node.js
nicht möglich.

- Node verlangt Header-Werte als **String**. Für jeden Request mit `auth` wird der
  Authorization-Wert daher kurz als String erzeugt. Strings sind unveränderlich und
  können nicht überschrieben werden. Sie verschwinden erst, wenn der Garbage
  Collector den Speicher irgendwann wiederverwendet.
- kdbxweb hält Feldwerte intern ebenfalls maskiert, erzeugt beim Entschlüsseln aber
  eigene Kopien: XML-Text der Datenbank, Titel und Benutzernamen als Strings, Kopien
  in WebAssembly-Speicher von Argon2. Diese Kopien kontrolliert der Proxy nicht.
- Der Garbage Collector kann Puffer verschieben und alte Kopien zurücklassen.
- Ausgelagerter Speicher (Swap/Hibernation) und Core-Dumps können Fragmente enthalten.
  Wer das ausschließen muss, sollte verschlüsselten Swap verwenden und Core-Dumps
  abschalten (`ulimit -c 0`).
- Ein Angreifer mit Zugriff auf den Prozess (Debugger, gleicher Benutzer) kann die
  Geheimnisse immer auslesen. Die Maskierung schützt nur vor beiläufigem Auftauchen
  im Klartext, etwa in Heap-Dumps oder Logs.

## Tests

```bash
npm test                                            # mit der Standard-Node-Version
/opt/homebrew/opt/node@22/bin/node --test           # explizit mit Node 22
```

Die Tests nutzen nur `node:test`, ohne weitere Abhängigkeiten. Sie decken ab:

- **Echte KDBX4-Dateien** mit Argon2id und Argon2d, erzeugt mit kdbxweb. Dazu
  Schlüsseldatei, falsches Passwort, Papierkorb, mehrdeutige oder fehlende Einträge
  und Gruppen, Vorrang des Benutzernamens.
- Argon2 gegen die Testvektoren der Referenzimplementierung. Unter Node ≥ 24.7
  zusätzlich gegen OpenSSL.
- **HTTP-Weiterleitung** gegen echte lokale Server:
  - Routing per Header: fehlend, doppelt (auch in anderer Schreibweise), ungültig → `400`,
    unbekannt → `404`; Routing-Header kommen nie beim Upstream an
  - roher Pfad unverändert, auch `/local/demo/…` und `/mcp`; absolute Targets, `*`, `#` → `400`
  - Methoden und Header, Hop-by-Hop inkl. `Connection`-Liste, Host
  - Standard-Header: Vorrang, Überschreiben durch den Client, Entfernen per
    `Connection`, Validierung, relativer Pfad, Abbruch bei fehlender/ungültiger Datei
  - Basic Auth, auch getrennt je Umgebung bei gleichem Servicenamen, und
    Durchreichen ohne `auth`
  - Status und `Set-Cookie`, Redirects, HEAD/204, 8-MiB-Streaming in beide Richtungen, SSE
  - 502/504, Client- und Upstream-Abbrüche, synchrone Fehler ohne Absturz
- MCP: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`
  für beide Tools, unbekannte Umgebung, unbekanntes Tool, Transportfehler, exakte
  Host- und Origin-Prüfung je Listener-Port, getrennte Listener ohne gegenseitige
  Weiterleitung (`/mcp` am Proxy-Port nur mit Routing-Headern, MCP-Port leitet nie
  weiter), `proxyUrl` zeigt auf den Proxy-Port, atomarer Start (belegter Port →
  der andere wird zurückgerollt, Zugangsdaten genullt), `close()` schließt beide.
- Agent-Ablauf Ende-zu-Ende (`test/workflow.test.js`): MCP-Erkennung →
  Methode und Pfad aus der lokalen OpenAPI-YAML eines Spring-Boot-Testprojekts →
  `GET` und `POST` an `proxyUrl` + Spec-Pfad mit Routing-Headern. Jeder Request
  kommt mit Basic Auth und Standard-Header, ohne Routing-Header und ohne doppelten
  Context-Path beim Upstream an; der Client sieht weder Zugangsdaten noch
  Upstream-Adressen. `401` wird durchgereicht.
- Verdeckte Passworteingabe: kein Echo, Backspace und UTF-8, Escape-Sequenzen,
  `Strg+C`, Ende des Eingabestroms, externe Signale mit Wiederherstellung des Terminals.
- CLI Ende-zu-Ende: echte KDBX → Prompt (mit falschem erstem Versuch) → Proxy →
  Upstream, und die Ausgabe enthält kein Geheimnis.

## Projektstruktur

```
bin/ai-proxy.js          CLI-Einstieg, Signal-Handling
src/cli.js               Ablauf: Konfiguration → Passwort → KeePass → Server
src/config.js            Laden und Validieren von connection.json und headers.json
src/keepass.js           KDBX öffnen (kdbxweb + Argon2 via hash-wasm), Einträge auflösen
src/prompt.js            verdeckte Terminal-Eingabe in einen Buffer
src/secret.js            SecretValue (maskiert, nullbar), Basic-Header ohne Strings
src/proxy.js             Reverse-Proxy, Routing-Header, Standard-Header, Host-/Origin-Prüfung
src/mcp.js               MCP-Endpunkt (list_environments, list_services, Instruktionen)
GEMINI.md                Ablauf für Gemini als Kontextdatei
connection.example.json  Beispielkonfiguration
headers.example.json     Beispiel für Standard-Header (headersFile)
test/                    node:test-Suite
```
