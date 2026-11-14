<!-- i18n-sync: source=README.md sha256=9b8c8ae505a939011bb9d47d7fe1805569fe951a52cef3444a46ceb58579ebf4 -->
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
`PATCH /api/v1/cards/:id`, `PATCH /api/v1/cards/:id/move`, `POST /api/v1/cards/promoted`.

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
selbst eine Datenbank an und migriert auch keine. Früher übernahm das das Aktivieren des
Moduls, aber `module.json` deklariert jetzt keine `runtime.database`: `enableModule` öffnet
keine Moduldatenbank, und nichts legt `t_<hex32>__board` mehr an. Eine Testumgebung, die den
Leaf betreibt (`BOARD_BACKEND=service`), muss daher die Datenbank jedes Mandanten auf
`board-postgres` selbst anlegen und `migrations/` von Hand darauf anwenden (die
Integrationstests tun genau das mit `runMigrations` aus `@gremion/tenant-store`, siehe
`test/support/scratch-pg.ts`; `test/lifecycle.integration.test.ts` deklariert Datenbank und
Export des Leaf selbst, damit der Ablauf aus Anlegen, Export und Sperren weiter geprüft wird).
Solange das nicht geschehen ist, antwortet der Leaf für den Mandanten mit
`404 tenant_not_provisioned`. Ein Schema-Gate prüft die angewendeten Dateien gegen
`migrations/manifest.json`, bevor eine Mandantendatenbank genutzt wird. Ein angelegter Kunde
ist davon nicht betroffen: Er wird im Prozess bedient und erreicht den Leaf nie.
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
- Nach einem Plattform-`disable_module` blendet der Modul-Schalt-Reconciler der App das Board
  aus: Er setzt `config.modules.board = false` innerhalb von etwa einer Minute. Er läuft nur,
  wenn `PLATFORM_MODULES_DATABASE_URL` gesetzt ist; die Deploy-Verdrahtung lässt sie leer, wenn
  `UI_MODULES_DB_PASSWORD` nicht gesetzt ist, und die App meldet dann `module self-service
  reconciler off`. Auf einem solchen Host blendet ein Plattform-Disable das Board nicht aus: Es
  bleibt erreichbar, bis `config.modules.board` von Hand auf false gesetzt wird. Nach einem
  Neustart der App ist die Sperre der Plattform bis zum ersten Abgleichlauf vergessen; in
  diesem kurzen Fenster kann eine Einstellungsänderung das Board noch einschalten, der Lauf
  schaltet es wieder aus.
- Wird board beim Anlegen nicht angehakt, ist es dadurch nicht ausgeblendet. Das Board folgt
  der Plattform nur dort, wo eine Plattform-Aktivierung existiert. Ein ohne sie angelegter
  Kunde ist ungesteuert und, wie jedes schaltbare Modul außer elections, standardmäßig an,
  genau wie bei votes, files und calendar; das Häkchen fügt nur die Plattform-Aktivierung
  hinzu. Das Board eines solchen Kunden später auszublenden erfordert eine Plattform-Aktivierung,
  die deaktiviert wird, oder `config.modules.board = false`.
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
