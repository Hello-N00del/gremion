<!-- i18n-sync: source=README.md sha256=75f0658af595f3e21351bc1c4077fcbdcbfa9e013985451230af07ba4e4efd08 -->
[English](./README.md) | **Deutsch**

# publishing

Newsletter: Mailinglisten und Mitglieder, Newsletter-Entwürfe mit Empfänger:innen (Listen oder
Kernel-Gruppen), Vorschau, zeitgesteuerter und sofortiger Versand, Zustelldatensätze je
Empfänger:in, Abmeldelinks und ein Audit-Log. Entwürfe lassen sich in Collabora bearbeiten.
Status: **unterstützt** ([docs/modules.de.md](../../docs/modules.de.md)).

Das Modul ist als `newsletter` registriert, nicht als `publishing`.

| | |
|---|---|
| Verzeichnis / `module.json`-ID | `publishing` |
| Manifest-ID (Schlüssel in `config.modules`) | `newsletter` |
| Paket | `newsletter-service` |
| Navigationssegment | `/newsletter` (Mindestrolle: finance) |
| Leaf-Service | ja, lauscht auf `PORT` (Standard 8080); er ist das einzige Backend |

## Aufbau

| Pfad | Inhalt |
|---|---|
| `app/` | Die In-Process-Hälfte, die über `gremion-ui/src/` gelegt wird: Seiten unter `/newsletter`, API-Routen, der Service-Client hinter dem Backend-Port, Hilfsfunktion für die Collabora-Konvertierung, Manifest (`app/lib/modules/manifests/newsletter.ts`). |
| `src/` | Der Leaf: `http/`, `store/`, `tenant-store.ts`, `dispatch.ts` (Versandpipeline), `outbox.ts` und das NATS-Relay, `scheduler.ts`, `kernel-client.ts`. |
| `migrations/` | Leaf-Schema und das erzeugte `manifest.json`. |
| `scripts/` | `build-migration-manifest.mjs` (läuft als `prebuild`); `backfill.ts` (einmalige Kopie aus einem früheren SQLite-Store); `seed-sample-sqlite.mjs` (erzeugt dafür eine synthetische SQLite-Fixture). |
| `test/` | Unit- und Integrationstests des Leaf. |

## Routen und API-Oberfläche

Kernel-App (`app/routes/`):

| Route | Methoden |
|---|---|
| `/newsletter`, `/newsletter/new`, `/newsletter/[id]`, `/newsletter/[id]/preview`, `/newsletter/lists`, `/newsletter/lists/[id]`, `/newsletter/unsubscribe` | Seiten |
| `/api/newsletter` | GET, POST |
| `/api/newsletter/[id]` | GET, PATCH |
| `/api/newsletter/[id]/preview` | GET |
| `/api/newsletter/[id]/schedule`, `/api/newsletter/[id]/send-now` | POST |
| `/api/newsletter/[id]/wopi-token` | GET |
| `/api/newsletter/lists`, `.../lists/[id]`, `.../lists/[id]/members`, `.../members/[memberId]` | GET, POST; DELETE; GET, POST; DELETE |
| `/api/newsletter/unsubscribe` | POST |
| `/api/internal/newsletter/{render,resolve-group,send-mail}` | POST (Callbacks vom Leaf an den Kernel; außerhalb der Routenpräfixe des Moduls, daher funktionieren sie auch bei ausgeschaltetem Modul weiter) |

Leaf (`src/http/routes.ts`), Shared-Secret-Guard außer für `/healthz`: `/api/v1/lists` (und
`/:id`, `/:id/members`, `/:id/members/:memberId`), `/api/v1/newsletters` (`GET`, `POST`,
`/:id` GET und PATCH, `/:id/recipients` GET und PUT, `/:id/schedule`, `/:id/send`,
`/:id/audit`), `POST /api/v1/unsubscribe`, `GET /api/v1/stats`, `GET /healthz/tenants`.

## Migrationen

Je Mandant eine Datenbank (`newsletter_<slug>`, dazu eine Kontrolldatenbank
`newsletter_control` mit dem Mandantenkatalog), angelegt vom Tenant-Store des Leaf.
`migrations/001_init.sql` legt `mailing_lists`, `mailing_list_members`, `newsletters`,
`newsletter_recipients`, `unsubscribes`, `send_tokens`, `newsletter_audit`, `deliveries` und
`outbox` an. Der Leaf prüft jede Datei gegen `migrations/manifest.json`.

Wird das Modul für einen Mandanten deaktiviert, wird die Datenbank mit `pg_dump`
exportiert (Aufbewahrungsprofil `rp-nws-module-data`), unter Auslassung von
`public.unsubscribes.token` und `public.send_tokens.token` (`module.json`).

## Konfiguration

| Variable | Verwendet von | Bedeutung |
|---|---|---|
| `NEWSLETTER_BACKEND` | Kernel-App | `service` (Standard) ist der einzige gültige Wert; jeder andere Wert führt zu einem Auflösungsfehler. |
| `NEWSLETTER_SERVICE_URL` | Kernel-App | Basis-URL des Leaf. |
| `INTERNAL_NEWSLETTER_SECRET` | beide | Shared Secret in `x-internal-auth`. |
| `NEWSLETTER_PG_URL` | Leaf | PostgreSQL-Server des Moduls; Pflicht, kein Standardwert. |
| `NATS_URL` | Leaf | Aktiviert das Outbox-Relay. |
| `KERNEL_BASE_URL` | Leaf | Basis-URL des Kernels für die Callbacks render, resolve-group und send-mail. |
| `PUBLIC_BASE_URL`, `ORIGIN` | Leaf, App | Öffentliche Basis-URL, aus der Links gebaut werden. |
| `NEWSLETTER_ALLOW_LOOPBACK_LINKS` | Leaf | Erlaubt Loopback-Basen für Links (Entwicklung). |
| `NEWSLETTER_SCHEDULER_ENABLED`, `SCHEDULER_ENABLED` | Leaf | Schalten den Versand-Scheduler; die modulspezifische Variable hat Vorrang, wenn sie nicht leer ist. |
| `COLLABORA_INTERNAL_URL` | App | Interne Collabora-URL für die Konvertierung von Entwürfen. |
| `SHUTDOWN_TIMEOUT_MS`, `PORT`, `TRACE_EXPORTER` | Leaf, App | Zeitlimit beim Herunterfahren, Listen-Port, Tracing. |

Der PostgreSQL-Server des Moduls ist `newsletter-postgres` unter dem Compose-Profil
`newsletter` (`NEWSLETTER_PG_USER`, `NEWSLETTER_PG_PASSWORD`).

## Externe Dienste

- Der PostgreSQL-Server des Moduls.
- NATS, für das Outbox-Relay.
- SMTP, erreicht über den Send-Mail-Callback des Kernels; das Modul hält keine
  Mail-Zugangsdaten. Die Systemmails des Kernels (Passwort-Reset, Benachrichtigungen)
  laufen nicht über dieses Modul.
- Collabora, für die Bearbeitung und Konvertierung von Entwürfen.

## Aktivieren und Deaktivieren

- Build: im Standard-Build enthalten.
- Je Kunde: `--enable publishing` bei der Anlage (die Katalog-ID ist die ID aus
  `module.json`) oder die Panel-Anfragen `enable_module` und `disable_module`
  ([runbooks/tenant-lifecycle.md](../../docs/runbooks/tenant-lifecycle.md) (englisch)).
- Instanzeinstellung: `config.modules.newsletter = false` sperrt die Newsletter-Seiten und
  `/api/newsletter`, entfernt den Navigationseintrag und lässt den Demo-Seed das Modul
  überspringen.
- Leaf: `docker build -f modules/publishing/Dockerfile .` aus dem Repository-Root.

## Tests

- `pnpm --filter newsletter-service test` (Unit, `test/`), `typecheck`, `typecheck:tests`.
- `pnpm --filter newsletter-service test:integration`: benötigt ein Wegwerf-PostgreSQL über
  `NEWSLETTER_TEST_PG_URL`.
- Tests unter `app/` liegen neben dem Code und werden vom `test`-Skript des Pakets nicht
  eingesammelt.

## Nicht aus dem Code belegt

- Welche der Variablen `PUBLIC_BASE_URL` und `ORIGIN` jede Hälfte liest, wurde aus einer
  Suche nach Zugriffen auf Umgebungsvariablen übernommen, nicht aus einer vollständigen
  Nachverfolgung.
