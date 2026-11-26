<!-- i18n-sync: source=README.md sha256=26630e222d8138b4c623dc77cf58c696913619e0594916eb059e243857273581 -->
[English](./README.md) | **Deutsch**

# board

Aufgabenboard für Organisationseinheiten: Boards enthalten Stacks, Stacks enthalten Karten,
und der Status einer Karte ist der Stack, in dem sie liegt. Aktionspunkte aus Protokollen
können als übernehmbar aufgelistet und in Karten übernommen werden. Status: **unterstützt**
([docs/modules.de.md](../../docs/modules.de.md)).

| | |
|---|---|
| Verzeichnis / `module.json`-ID | `board` |
| Manifest-ID (Schlüssel in `config.modules`) | `board` |
| Paket | `board-service` |
| Navigationssegment | `/tasks` (Mindestrolle: member) |
| Leaf-Service | ja, lauscht auf `PORT` (Standard 8080); er bedient jeden Kunden, dessen Board in der eigenen Datenbank liegt |

## Aufbau

| Pfad | Inhalt |
|---|---|
| `app/` | Die In-Process-Hälfte, die über `gremion-ui/src/` gelegt wird: Seiten, API-Routen, der Backend-Port (`inprocess` oder `service`), das Manifest (`app/lib/modules/manifests/board.ts`), Kartenkomponenten, der Seeder. |
| `src/` | Der Leaf-Service: `app.ts` (der einzige Konstruktionspfad), `http/` (Router, Guard, Routen), `store/`. |
| `migrations/` | Leaf-Schema und das erzeugte `manifest.json`. |
| `scripts/build-migration-manifest.mjs` | Schreibt `migrations/manifest.json` (SHA-256 je Migration); läuft als `prebuild`. |
| `test/` | Unit- und Integrationstests des Leaf, einschließlich eines Bundle-Smoke-Tests. |

## Routen und API-Oberfläche

Kernel-App (`app/routes/`):

| Route | Methoden |
|---|---|
| `/tasks` | Seite |
| `/api/board` | GET |
| `/api/board/[id]` | GET |
| `/api/board/[id]/cards` | POST, PATCH, DELETE |
| `/api/board/[id]/promotable` | GET |
| `/api/board/[id]/promote` | POST |

Leaf (`src/http/routes.ts`), alle Routen außer `/healthz` hinter dem Shared-Secret-Guard:

`GET|POST /api/v1/boards`, `GET /api/v1/boards/:id`, `POST /api/v1/boards/:id/stacks`,
`GET /api/v1/boards/:id/deck`, `POST /api/v1/boards/:id/promote`, `POST /api/v1/cards`,
`PATCH|DELETE /api/v1/cards/:id`, `PATCH /api/v1/cards/:id/move`, `POST /api/v1/cards/promoted`.

## Wo das Board eines Kunden liegt

Das Board eines Kunden liegt an einem von zwei Orten, und eine Zeile sagt welchem: `location` in der
Tabelle `board_location` (Kernel-Migration `gremion-ui/migrations/0066_board_location.sql`, höchstens
eine Zeile je Kundendatenbank; keine Zeile bedeutet `kernel`).

| `location` | Wo das Board liegt | Welche Kunden |
|---|---|---|
| `module` | In der eigenen Datenbank `t_<hex32>__board` des Kunden auf `board-postgres`, bedient vom Leaf `board-service` | Ein Kunde, der mit angekreuztem board angelegt wurde: Der Anlageablauf aktiviert das Modul (das die Datenbank anlegt und `migrations/` anwendet) und setzt danach das Kennzeichen |
| `kernel` oder keine Zeile | In den Tabellen `board`, `stack` und `card` der eigenen Kernel-Datenbank des Kunden, angelegt von `gremion-ui/migrations/0034_deck_board.sql`, bedient in der Kernel-App | Ein Kunde, der ohne angekreuztes board angelegt wurde, und jeder Kunde, der angelegt wurde, bevor das board eine eigene Datenbank hatte |
| `moving` | Vorbehalten für einen späteren Schritt, der ein Board verschiebt; nichts in diesem Release schreibt ihn | keiner |

Board wird bei der Anlage des Kunden gewählt. Wird es nicht angekreuzt, bekommt der Kunde auch später
keine Board-Datenbank: Das spätere Einschalten von board für einen aktiven Kunden, dessen Kennzeichen
nicht `module` ist, wird abgelehnt, bevor etwas geschrieben wird, weil die Aktivierung eine leere
Datenbank neben den Kernel-Zeilen anlegen würde.

Das Board eines bestehenden Kunden aus den Kernel-Tabellen in die eigene Datenbank zu verschieben, ist
noch nicht verfügbar. Bis dahin behält ein Kunde, dessen Board bereits im Kernel liegt, es dort. Die
schreibgeschützte Prüfung des Betreibers, die auflistet, wo das Board jedes Kunden liegt, und die
Reihenfolge für die Anlage des echten Kunden stehen im Abschnitt „Board: where a customer's board lives“
des [Runbooks](../../docs/runbooks/tenant-lifecycle.md) (englisch).

## Migrationen

`module.json` deklariert die eigene Datenbank des Moduls (`board-postgres`, das Verzeichnis
`migrations/`) und seinen Export (`pg_dump`, Aufbewahrungsprofil `rp-brd-module-data`, aus
`module.json` gelesen von `packages/provisioning/src/catalogue-rows.ts`). Je Kunde eine Datenbank. Das
Aktivieren des Moduls legt `t_<hex32>__board` an und wendet `migrations/` mit `runMigrations` aus
`@gremion/tenant-store` an; der Leaf öffnet sie nur: Er legt nie selbst eine Datenbank an, migriert
keine und verbindet sich als App-Rolle des Moduls. `migrations/001_init.sql` legt `board`, `stack` und
`card` an. Die Fremdschlüssel auf die Kernel-Tabellen (Organisationseinheiten, Aktionspunkte aus
Protokollen) fehlen, weil sie Datenbankgrenzen überschreiten würden. Ein Schema-Gate prüft die
angewendeten Dateien gegen `migrations/manifest.json`, bevor die Datenbank eines Kunden genutzt wird. Der
Leaf antwortet für einen Kunden ohne eine solche Datenbank mit `404 tenant_not_provisioned`; mit
`BOARD_BACKEND=auto` erreicht ein Kunde, dessen Board im Kernel liegt, den Leaf nie.

Die Kernel-Tabellen `board`, `stack` und `card` (Migration `0034_deck_board.sql`) gibt es in der
Kernel-Datenbank jedes Kunden, unabhängig davon, ob das Modul an oder aus ist; bei einem Kunden mit
`module` bleiben sie leer.

## Konfiguration

| Variable | Verwendet von | Bedeutung |
|---|---|---|
| `BOARD_BACKEND` | Kernel-App | `auto` (Standard): je Mandant entscheidet das Ortskennzeichen (`board_location`, Migration 0066) zwischen den Kernel-Tabellen und dem Leaf; ein Mandant ohne Zeile wird aus den Kernel-Tabellen bedient. `inprocess` oder `service` erzwingen ein Backend und ignorieren das Kennzeichen. Jeder andere Wert wird abgelehnt. |
| `BOARD_SERVICE_URL` | Kernel-App | Basis-URL des Leaf; die App-Env-Vorlage zeigt auf den Leaf derselben Farbe. |
| `INTERNAL_BOARD_SECRET` | beide | Shared Secret im Header `x-internal-auth`. Nicht gesetzt: Der Leaf startet, und jede geschützte Route antwortet mit 403. |
| `GREMION_BOARD_PG_URL` | Leaf | PostgreSQL-Server des Moduls, als App-Rolle des Moduls `m_board_app`; der Datenbankname wird je Mandant ersetzt (`t_<hex32>__board`). Pflicht, es gibt keinen Standardwert; ohne sie verweigert der Leaf den Start. |
| `BOARD_APP_PASSWORD` | Leaf | Das Passwort von `m_board_app`; `gremion-init-secrets` übernimmt es aus der Datei, aus der der Modul-Lebenszyklus die Rolle setzt, sodass URL und Rolle nicht auseinanderlaufen. |
| `PORT` | Leaf | Listen-Port, Standard 8080. |
| `TRACE_EXPORTER` | Kernel-App | Auswahl des Tracing-Exporters. |

Der PostgreSQL-Server des Moduls ist der Service `board-postgres`, der Leaf ist `board-service`; beide
laufen unter dem Compose-Profil `board`, das ein Pilot-Host aus `infra/host/module-profiles.json`
rendert. Die Zugangsdaten des Servers stammen aus `BOARD_PG_USER` und `BOARD_PG_PASSWORD`.

## Externe Dienste

Keine außer dem Kernel, dem Leaf und dem PostgreSQL-Server des Leaf (`board-postgres`).

## Aktivieren und Deaktivieren

- Build: im Standard-Build enthalten.
- Je Kunde: board bei der Anlage des Kunden ankreuzen (`--enable board` oder das Anlageformular des
  Panels). Board durchläuft dasselbe Isolations-Gate wie die anderen Module. Ein Gremium kann board in
  den eigenen Einstellungen nicht schalten: Dort ist es zurückgehalten. Die `enable_module`-Anfrage des
  Panels aktiviert board nur für einen Kunden, dessen Board bereits in der eigenen Datenbank liegt (etwa
  um es innerhalb der Karenz wiederherzustellen); für jeden anderen aktiven Kunden wird sie abgelehnt.
- Das Ausschalten von board (`disable_module`) exportiert bei einem Kunden, dessen Board in der eigenen
  Datenbank liegt, die Datenbank, prüft den Export und sperrt die Datenbank; ein Einschalten innerhalb
  der 30 Tage entsperrt sie mit denselben Boards. An Tag 30 wird die gesperrte Datenbank gelöscht, und
  der Export wird danach für einen festen Zeitraum aufbewahrt, nicht mit ihr gelöscht
  ([runbooks/tenant-lifecycle.md](../../docs/runbooks/tenant-lifecycle.md) (englisch), die Karenz-Tabelle
  und die Katalogzeilen RC-MOD-EXPORT und RC-BRD der Aufbewahrungsübersicht).
- Ein Board, das noch in den Kernel-Tabellen liegt, hat keine Datenbank, die exportiert werden könnte.
  Es sollte nicht über die Plattform ausgeschaltet werden: Ein Plattform-`disable_module` für einen
  solchen Kunden, der eine Board-Aktivierung hatte, blendet das Board nur aus und startet die
  30-Tage-Uhr (nichts wird exportiert, nichts gelöscht), ein Einschalten wird vom selben Gate abgelehnt
  wie ein späteres Aktivieren (siehe oben), und solange die Plattformzeile deaktiviert ist, setzt der
  Reconciler (unten) ein von Hand auf true gesetztes `config.modules.board` wieder auf false zurück.
  Das Ausblenden ist in diesem Release eine Einbahnstraße; ein solches Board wird allein mit
  `config.modules.board = false` ausgeblendet.
- Instanzeinstellung: Mit `config.modules.board = false` liefern `/tasks` und `/api/board` die
  Antwort für deaktivierte Module aus. So wird ein Board ausgeblendet, das in den Kernel-Tabellen liegt.
- Nach einem Plattform-`disable_module` blendet der Modul-Schalt-Reconciler der App das Board
  aus: Er setzt `config.modules.board = false` innerhalb von etwa einer Minute. Er läuft nur,
  wenn `PLATFORM_MODULES_DATABASE_URL` gesetzt ist; die Deploy-Verdrahtung lässt sie leer, wenn
  `UI_MODULES_DB_PASSWORD` nicht gesetzt ist, und die App meldet dann `module self-service
  reconciler off`. Auf einem solchen Host weist das Verb `disable-module` `board` ab (bevor
  etwas geschrieben wird; die Meldung nennt `UI_MODULES_DB_PASSWORD`), ein Plattform-Disable
  wird also nie als erledigt gemeldet, während das Board erreichbar bleibt; zuerst die Variable
  setzen, `init` ausführen und die App-Container neu erstellen, oder `config.modules.board` von
  Hand auf false setzen. Nach einem
  Neustart der App ist die Sperre der Plattform bis zum ersten Abgleichlauf vergessen; in
  diesem kurzen Fenster kann eine Einstellungsänderung das Board noch einschalten, der Lauf
  schaltet es wieder aus.
- Wird board beim Anlegen nicht angehakt, ist es dadurch nicht ausgeblendet und lässt sich später auch
  nicht mehr anhaken. Das Board folgt der Plattform nur dort, wo eine Plattform-Aktivierung existiert.
  Ein ohne sie angelegter Kunde ist ungesteuert und, wie jedes schaltbare Modul außer elections,
  standardmäßig an und wird aus den Kernel-Tabellen bedient; es auszublenden erfordert
  `config.modules.board = false`.
- Leaf: `docker build -f modules/board/Dockerfile .` aus dem Repository-Root.

`docs/pilot/module-defaults.md` hält fest, dass board Teil der Pilot-Anlageanfrage ist und das
Aktivierungs-Gate durchläuft; nur vault wird weiterhin namentlich abgelehnt.

## Tests

- `pnpm --filter board-service test`: Unit-Tests des Leaf (`test/`), ohne Datenbank.
- `pnpm --filter board-service test:integration`: benötigt ein Wegwerf-PostgreSQL;
  `BOARD_TEST_PG_URL` und `BOARD_TEST_PG_CONTAINER` sind beide erforderlich (siehe
  `vitest.integration.config.ts`).
- `pnpm --filter board-service test:bundle`: baut das Bundle und prüft es per Smoke-Test.
- `pnpm --filter board-service typecheck`.
- Tests unter `app/` liegen neben dem Code, den sie abdecken, und gehören nicht zum eigenen
  `test`-Skript des Pakets (dessen `include` ist `test/**`). Dass sie nach dem Overlay mit
  der `gremion-ui`-Suite laufen, ist aus dem Overlay-Skript geschlossen und hier nicht
  geprüft.
