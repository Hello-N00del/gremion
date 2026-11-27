<!-- i18n-sync: source=README.md sha256=091eaa545430ffd69c2c92d76e45aec4e657c53607cb431e68da0acee59a21ca -->
[English](./README.md) | **Deutsch**

# calendar

Termine und Terminarten mit Wiederholung, Kalendereinstellungen je Gremium, ein Public-Flag
für die Anzeige im Portal und Automatisierungen, die Termine anlegen (Feiertagssync,
Helios-Abstimmungen, Protokolle). Termine werden per Push an CalDAV übertragen, und
Änderungsereignisse werden über eine transaktionale Outbox per NATS weitergereicht.
Status: **unterstützt** ([docs/modules.de.md](../../docs/modules.de.md)).

| | |
|---|---|
| Verzeichnis / `module.json`-ID | `calendar` |
| Manifest-ID (Schlüssel in `config.modules`) | `calendar` |
| Paket | `calendar-service` |
| Navigationssegment | `/calendar` (Mindestrolle: guest) |
| Leaf-Service | ja, lauscht auf `PORT` (Standard 8080) |

## Aufbau

| Pfad | Inhalt |
|---|---|
| `app/` | Die In-Process-Hälfte, die über `gremion-ui/src/` gelegt wird: Seiten, API-Routen, Kalenderkomponenten, CalDAV-Client und -Sync, Benachrichtigungs-Scheduler, Audit-Consumer, Backend-Port, Manifest, Seeder. |
| `src/` | Der Leaf-Service: `http/`, `store/`, `tenant-store.ts`, `caldav/`, `outbox.ts` und das NATS-Relay, `scheduler.ts`. |
| `migrations/` | Leaf-Schema und das erzeugte `manifest.json`. |
| `scripts/` | `build-migration-manifest.mjs` (läuft als `prebuild`), `backfill.ts`, eine einmalige Kopie von Kalenderzeilen aus einer Mandantendatenbank des Kernels in die Lebenszyklus-Datenbank des Mandanten (ein reiner Verifizierungsmodus ist verfügbar), und `move-to-lifecycle-db.mjs`, das Betreiberskript, das eine frühere `calendar_<slug>`-Datenbank in die Lebenszyklus-Datenbank verschiebt. |
| `test/` | Unit- und Integrationstests des Leaf. |

## Routen und API-Oberfläche

Kernel-App (`app/routes/`):

| Route | Methoden |
|---|---|
| `/calendar`, `/calendar/invite/[uid]` | Seiten |
| `/api/calendar/events` | GET, POST |
| `/api/calendar/events/[id]` | GET, PATCH, DELETE |
| `/api/calendar/event-types`, `/api/calendar/event-types/[id]` | GET, POST; DELETE |
| `/api/calendar/settings/shared` | GET, PATCH |
| `/api/calendar/settings/committees/[id]` | GET, PATCH |
| `/api/calendar/automations/holidays/sync` | POST |
| `/api/calendar/automations/helios` | POST |
| `/api/calendar/automations/minutes`, `.../minutes/confirm` | POST |

Leaf (`src/http/routes.ts`), Shared-Secret-Guard außer für `/healthz`:

`/api/v1/events` (GET, POST), `/api/v1/events/:id` (GET, PATCH, DELETE),
`/api/v1/events/by-external/:source/:externalId` (GET, DELETE), `/api/v1/event-types` (GET,
POST), `/api/v1/event-types/:id` (GET, DELETE), `/api/v1/committee-settings/:committeeId`
(GET, PUT), `GET /api/v1/caldav/failed` und `GET /healthz/tenants`.

## Migrationen

Der Kalender eines Mandanten liegt in der Datenbank, die der Modul-Lebenszyklus besitzt,
`t_<Mandanten-UUID als 32 Hex-Zeichen>__calendar`. `enableModule` legt sie an, führt
`migrations/*.sql` der Reihe nach aus (der eine Runner von `@gremion/tenant-store`, der den SHA-256
jeder Datei gegen `migrations/manifest.json` prüft) und gibt der App-Rolle des Moduls
`m_calendar_app` die DML-Rechte. Der Leaf legt keine Mandantendatenbank an und migriert keine: er
öffnet diese als `m_calendar_app` (`GREMION_CALENDAR_PG_URL`, der Datenbankname wird je Mandant
ersetzt) hinter dem Schema-Tor. Eine fehlende oder gesperrte Datenbank (das Modul ist abgeschaltet)
antwortet mit `404 tenant_not_provisioned`, eine Datenbank hinter den Migrationen mit
`503 schema_not_current`. Die Kontrolldatenbank `calendar_control` (mit dem Admin-Zugang
`CALENDAR_PG_URL` angelegt) enthält nur den Mandantenkatalog: sie bindet jede Mandanten-ID an genau
einen Slug und listet die Mandanten, die der CalDAV-Abgleich und das Outbox-Relay durchlaufen.
Frühere Versionen hielten jeden Mandanten in `calendar_<slug>`; `scripts/move-to-lifecycle-db.mjs`
verschiebt eine solche Datenbank einmalig (zuerst ein Probelauf; siehe `docs/ops/pilot-services.md`).

| Datei | Inhalt |
|---|---|
| `001_init.sql` | `event_types`, `calendar_events`, `event_recurrence`, `event_committees`, `committee_calendar_settings`, `caldav_sync_queue`, `calendar_audit`, `outbox` |
| `002_add_is_public.sql` | Flag `is_public` auf `calendar_events` |
| `003_holiday_unique.sql` | partieller Unique-Index auf Feiertagsterminen über `(source, external_id)` |

Wird das Modul für einen Mandanten deaktiviert, wird die Datenbank mit `pg_dump` unter dem
Aufbewahrungsprofil `rp-cal-module-data` exportiert (`module.json`).

## Konfiguration

| Variable | Verwendet von | Bedeutung |
|---|---|---|
| `CALENDAR_BACKEND` | Kernel-App | `inprocess` (Standard) oder `service`. |
| `CALENDAR_SERVICE_URL` | Kernel-App | Basis-URL des Leaf, wenn das Backend `service` ist. |
| `INTERNAL_CALENDAR_SECRET` | beide | Shared Secret in `x-internal-auth`. |
| `CALENDAR_PG_URL` | Leaf | PostgreSQL-Server des Moduls als Admin, nur für die Katalogdatenbank `calendar_control`; Pflicht, kein Standardwert. |
| `GREMION_CALENDAR_PG_URL` | Leaf | PostgreSQL-Server des Moduls als App-Rolle `m_calendar_app`; der Datenbankname wird je Mandant ersetzt (`t_<hex32>__calendar`). Pflicht, kein Standardwert. |
| `NATS_URL` | beide | Aktiviert das Outbox-Relay; ist sie nicht gesetzt, bleibt das Relay aus, und das Boot-Log vermerkt das in einer Zeile. |
| `KERNEL_BASE_URL` | Leaf | Basis-URL des Kernels; wird gelesen, ein Callback an den Kernel erfolgt derzeit aber nicht. |
| `NEXTCLOUD_URL`, `NEXTCLOUD_ADMIN_USER`, `NEXTCLOUD_ADMIN_PASSWORD` | beide | CalDAV-Push-Ziel und Zugangsdaten. |
| `CALDAV_SHARED_CALENDAR`, `CALDAV_SHARED_USER`, `CALDAV_TENANT_CALENDARS`, `CALDAV_CALENDAR_TEMPLATE` | beide | Welcher CalDAV-Kalender welche Termine erhält. |
| `CALENDAR_SCHEDULER_ENABLED`, `SCHEDULER_ENABLED` | Leaf | Schalten das Abarbeiten der CalDAV-Warteschlange (Drain) im 30-Sekunden-Takt. Ein nicht leeres `CALENDAR_SCHEDULER_ENABLED` hat Vorrang vor dem gemeinsamen `SCHEDULER_ENABLED`; nur die exakte Zeichenfolge `false` schaltet ab; Standard: an. |
| `SHUTDOWN_TIMEOUT_MS` | Leaf | Zeitlimit für das geordnete Herunterfahren. |
| `PORT`, `TRACE_EXPORTER` | Leaf, App | Listen-Port; Tracing-Exporter. |

Der PostgreSQL-Server des Moduls ist `calendar-postgres` unter dem Compose-Profil `calendar`
(`CALENDAR_PG_USER`, `CALENDAR_PG_PASSWORD`; das Passwort der App-Rolle ist `CALENDAR_APP_PASSWORD`).

## Externe Dienste

- Nextcloud, für CalDAV.
- NATS, für das Outbox-Relay (beim Start optional).
- Der PostgreSQL-Server des Moduls.

## Aktivieren und Deaktivieren

- Build: im Standard-Build enthalten.
- Je Kunde: `--enable calendar` bei der Anlage oder die Panel-Anfragen `enable_module` und
  `disable_module`
  ([runbooks/tenant-lifecycle.md](../../docs/runbooks/tenant-lifecycle.md) (englisch)).
- Instanzeinstellung: Mit `config.modules.calendar = false` liefern `/calendar` und
  `/api/calendar` die Antwort für deaktivierte Module aus.
- Leaf: `docker build -f modules/calendar/Dockerfile .` aus dem Repository-Root.

## Tests

- `pnpm --filter calendar-service test` (Unit, `test/`), `typecheck`, `typecheck:tests`.
- `pnpm --filter calendar-service test:integration`: benötigt ein Wegwerf-PostgreSQL über
  `CALENDAR_TEST_PG_URL` (siehe `vitest.integration.config.ts` und den Guard in `test/`).
- Tests unter `app/` liegen neben dem Code und werden vom `test`-Skript des Pakets nicht
  eingesammelt.

## Nicht aus dem Code belegt

- Welche der als „beide“ aufgeführten Variablen die Kernel-App (im Unterschied zum Leaf) für
  den In-Process-CalDAV-Client liest, wurde aus einer Suche nach Zugriffen auf
  Umgebungsvariablen übernommen, nicht aus einer vollständigen Nachverfolgung beider
  Hälften.
