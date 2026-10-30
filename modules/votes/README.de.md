<!-- i18n-sync: source=README.md sha256=a67f9c455bf47356220bccc4b79f09d3a95e51146c2a52b48ae3de876ae3742d -->
[English](./README.md) | **Deutsch**

# votes

Offene Umfragen und die kombinierte Liste `/votes` („Abstimmungen & Wahlen“): Die Liste
führt die offenen Umfragen des Mandanten mit den Abstimmungen der verfolgten Helios-Wahlen
zusammen. Umfragen sind Quick-Polls von Nextcloud Polls, die über die Kernel-App angelegt
und beantwortet werden. Der Leaf ist ein zustandsloser Aggregations-Proxy. Status:
**unterstützt** ([docs/modules.de.md](../../docs/modules.de.md)); es ist das einzige Modul,
das die Anlageanfrage des Piloten aktiviert
([pilot/module-defaults.md](../../docs/pilot/module-defaults.de.md)).

| | |
|---|---|
| Verzeichnis / `module.json`-ID | `votes` |
| Manifest-ID (Schlüssel in `config.modules`) | `votes` |
| Paket | `votes-service` |
| Navigation | Segmente `/polls` und `/votes` (Mindestrolle: member), ein zusammengeführter Eintrag in der Navigationsleiste unter `/votes` |
| Leaf-Service | ja, zustandslos (keine Datenbank), lauscht auf `PORT` (Standard 8080) |

## Aufbau

| Pfad | Inhalt |
|---|---|
| `app/` | Die In-Process-Hälfte, die über `gremion-ui/src/` gelegt wird: die Seiten `/votes` und `/polls`, `/api/polls`, der Polls-Client, das Manifest. |
| `src/` | Der Leaf: `http/` (Server, Guard), `helios/` (Lese-Client), `polls/` (Nextcloud-Polls-Client und die Umfragemarkierung je Mandant), `aggregator/` (Mapping und Zusammenführung), `boot-config.ts`. |
| `test/` | Unit-Tests des Leaf; die Integrationskonfiguration existiert, einen Integrationstest gibt es nicht. |

## Routen und API-Oberfläche

Kernel-App (`app/routes/`):

| Route | Methoden |
|---|---|
| `/votes`, `/polls`, `/polls/new`, `/polls/[id]` | Seiten |
| `/api/polls` | GET, POST |
| `/api/polls/[id]` | GET, POST (Abstimmen) |
| `/api/polls/[id]/options` | GET |

Die Seite `/votes` blendet jeden Helios-Eintrag aus, solange das Modul elections für den
Mandanten ausgeschaltet ist.

Leaf (`src/http/server.ts`): `/healthz` (ohne Guard); hinter dem Shared-Secret-Guard nur
`POST /api/v1/votes` (stellt die Liste aus einer Menge von Wahl-UUIDs zusammen; nicht
erreichbare Abstimmungen kommen als eingeschränkt (degraded) zurück, statt verworfen zu
werden) und `POST /api/v1/polls` (legt eine Umfrage an). Fehlerhafte Bodies werden mit 400
beantwortet, Fehler im Upstream mit 502. Der Leaf hat keine Umfrageroute nach ID; Lesen und
Abstimmen laufen über den Polls-Client der App.

Jede Umfrage trägt eine vom Server geschriebene Markierung für den aufrufenden Mandanten
(`x-tenant-id`), und die Liste wird danach gefiltert. Umfragen ohne Markierung gehören zu
keinem Mandanten, es sei denn, `VOTES_LEGACY_POLL_TENANT_ID` ordnet sie einem zu.

## Migrationen

Keine. Der Leaf hat keine eigene Datenbank (`module.json`: `database: null`).

## Konfiguration

| Variable | Verwendet von | Bedeutung |
|---|---|---|
| `INTERNAL_VOTES_SECRET` | beide | Shared Secret in `x-internal-auth`. Nicht gesetzt: Der Leaf startet, und jede geschützte Route antwortet mit 403. |
| `HELIOS_URL`, `PUBLIC_HELIOS_URL` | Leaf, App | Interne und browserseitige Helios-URL; ist `HELIOS_URL` nicht gesetzt, schreibt der Leaf eine Warnung ins Log und fällt auf `http://helios:8000` zurück. |
| `NEXTCLOUD_URL` | Leaf, App | Basis-URL von Nextcloud; Rückfall auf `http://nextcloud` mit einer Warnung. |
| `NEXTCLOUD_ADMIN_USER`, `NEXTCLOUD_ADMIN_PASSWORD` | Leaf, App | Admin-Zugangsdaten für Nextcloud Polls. Ohne sie verweigert der Leaf den Start. |
| `VOTES_LEGACY_POLL_TENANT_ID` | Leaf | Mandant, dem Umfragen gehören, die vor Einführung der Markierung angelegt wurden. |
| `PUBLIC_BASE_URL` | App | Öffentliche Basis-URL. |
| `PORT` | Leaf | Listen-Port. |

Das Backend-Flag dieses Moduls (`VOTES_BACKEND`, `inprocess` oder `service`, mit
`VOTES_SERVICE_URL`) wird von Code unter `modules/elections/app/lib/server/elections/backend/`
gelesen, nicht von der App-Hälfte dieses Moduls; siehe
[../elections/README.de.md](../elections/README.de.md).

## Externe Dienste

- Nextcloud mit der App Polls.
- Helios, nur um Abstimmungen anzuzeigen (die Helios-Administration liegt im Modul elections).

Keiner von beiden ist in den Compose-Dateien im Repository-Root definiert; die
Betreiber:innen stellen sie bereit.

## Aktivieren und Deaktivieren

- Build: im Standard-Build enthalten.
- Je Kunde: bei der Anlage ausdrücklich zu nennen (`--enable votes`); die Pilot-Anfrage nennt
  es. Die Panel-Anfragen `enable_module` und `disable_module` funktionieren wie bei den
  anderen Modulen
  ([runbooks/tenant-lifecycle.md](../../docs/runbooks/tenant-lifecycle.md) (englisch)).
- Instanzeinstellung: Mit `config.modules.votes = false` liefern `/votes`, `/polls` und
  `/api/polls` die Antwort für deaktivierte Module aus.
- Leaf: `docker build -f modules/votes/Dockerfile .` aus dem Repository-Root.

## Tests

- `pnpm --filter votes-service test` (Unit, `test/`), `typecheck`.
- `pnpm --filter votes-service test:integration` sammelt derzeit keine Tests ein.
- Tests unter `app/` (Umfrage-API, eingeschränkte Darstellung, Reflow) liegen neben dem Code
  und werden vom `test`-Skript des Pakets nicht eingesammelt.

## Nicht aus dem Code belegt

- Ob der Polls-Client der App-Hälfte und der Leaf in einem bestimmten Deployment beide
  genutzt werden oder nur einer von ihnen, hängt von der Verdrahtung der Instanz ab und
  wurde nicht nachverfolgt.
