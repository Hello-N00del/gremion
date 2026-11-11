<!-- i18n-sync: source=README.md sha256=d2f6faa7aaa789f9ce6e2a273cb2710c2b741fd9a98bde916ea9dbf9fe135251 -->
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
| Leaf-Service | ja, lauscht auf `PORT` (Standard 8080) |

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
| `/api/board/[id]/cards` | POST, PATCH |
| `/api/board/[id]/promotable` | GET |
| `/api/board/[id]/promote` | POST |

Leaf (`src/http/routes.ts`), alle Routen außer `/healthz` hinter dem Shared-Secret-Guard:

`GET|POST /api/v1/boards`, `GET /api/v1/boards/:id`, `POST /api/v1/boards/:id/stacks`,
`GET /api/v1/boards/:id/deck`, `POST /api/v1/boards/:id/promote`, `POST /api/v1/cards`,
`PATCH /api/v1/cards/:id/move`, `POST /api/v1/cards/promoted`.

## Migrationen

Im Standardmodus (im Prozess) liegen die Board-Tabellen (`board`, `stack`, `card`) in der eigenen
Kernel-Datenbank des Kunden und werden von der Kernel-Migration
`gremion-ui/migrations/0034_deck_board.sql` angelegt, unabhängig davon, ob das Modul an oder aus
ist. `module.json` deklariert deshalb weder `runtime.database` noch `runtime.export`: Das Aktivieren
von board öffnet keine Moduldatenbank und startet kein `board-postgres`. Der Rest dieses Abschnitts
beschreibt den Leaf (`BOARD_BACKEND=service`, nur Testumgebung).

Je Mandant eine Datenbank für das Modul board. `migrations/001_init.sql` legt `board`, `stack` und
`card` an. Die Fremdschlüssel auf die Kernel-Tabellen (Organisationseinheiten, Aktionspunkte
aus Protokollen) fehlen, weil sie Datenbankgrenzen überschreiten würden. Der Leaf legt nie
selbst eine Datenbank an und migriert auch keine; das übernimmt das Aktivieren des Moduls
für einen Mandanten, und ein Schema-Gate prüft die angewendeten Dateien gegen
`migrations/manifest.json`, bevor eine Mandantendatenbank genutzt wird.
Das Aufbewahrungsprofil `rp-brd-module-data` ist ein vorläufiges Profil des Katalog-Laders
(`packages/provisioning/src/catalogue-rows.ts`), kein Export aus `module.json`.

## Konfiguration

| Variable | Verwendet von | Bedeutung |
|---|---|---|
| `BOARD_BACKEND` | Kernel-App | `inprocess` (Standard) oder `service`; jeder andere Wert wird abgelehnt. |
| `BOARD_SERVICE_URL` | Kernel-App | Basis-URL des Leaf, wenn das Backend `service` ist. |
| `INTERNAL_BOARD_SECRET` | beide | Shared Secret im Header `x-internal-auth`. Nicht gesetzt: Der Leaf startet, und jede geschützte Route antwortet mit 403. |
| `GREMION_BOARD_PG_URL` | Leaf | PostgreSQL-Server des Moduls; der Datenbankname wird je Mandant ersetzt (`t_<hex32>__board`). Pflicht, es gibt keinen Standardwert; ohne sie verweigert der Leaf den Start. |
| `PORT` | Leaf | Listen-Port, Standard 8080. |
| `TRACE_EXPORTER` | Kernel-App | Auswahl des Tracing-Exporters. |

Nur im Service-Modus ist der PostgreSQL-Server des Moduls der Service `board-postgres` unter dem
Compose-Profil `board`; seine Zugangsdaten stammen aus `BOARD_PG_USER` und `BOARD_PG_PASSWORD`.
Der Standardmodus im Prozess braucht beides nicht.

## Externe Dienste

Keine außer dem Kernel (und im Service-Modus dem PostgreSQL-Server des Leaf).

## Aktivieren und Deaktivieren

- Build: im Standard-Build enthalten.
- Je Kunde: Aktivierung mit `--enable board` bei der Anlage oder über die
  `enable_module`-Anfrage des Panels. Board durchläuft dasselbe Isolations-Gate wie die anderen
  Module. Es hat keine Moduldatenbank; `disable_module` entfernt daher nur die
  Plattform-Aktivierung: Es erzeugt keinen Export und löscht keine Board-Daten, die in der
  Kernel-Datenbank des Kunden bleiben
  ([runbooks/tenant-lifecycle.md](../../docs/runbooks/tenant-lifecycle.md) (englisch)). Ein Gremium
  kann board in den eigenen Einstellungen nicht schalten: Dort ist es zurückgehalten.
- Instanzeinstellung: Mit `config.modules.board = false` liefern `/tasks` und `/api/board` die
  Antwort für deaktivierte Module aus.
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

## Nicht aus dem Code belegt

- `src/app.ts` des Leaf löst Mandantendatenbanken über `@gremion/tenant-store` auf; die
  Leaf-Abschnitte oben folgen dem. Der Leaf ist nicht das, was ein angelegter Kunde betreibt.
