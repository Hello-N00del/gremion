<!-- i18n-sync: source=README.md sha256=60d873e410294fb4c6712c155345b2975fc33941ed4c2a95a9d3b35e739a0ae0 -->
[English](./README.md) | **Deutsch**

# finance

Geldverwaltung für eine Organisation: Haushaltsjahre und Haushaltspläne (Gruppen und
Positionen), Unterorganisationen, Projekte, Ausgaben mit Belegen, ein Freigabeablauf mit
mehreren Unterschriften, Zahlungsaufträge und Buchungen, Bankkonten mit Import von
Transaktionen (CSV und FinTS), SEPA-Export, Kassenabgleich sowie Auszugs- und Exportausgabe
(PDF, Tabelle). Beträge sind ganzzahlige Euro-Cent. Status: **standardmäßig deaktiviert**
(aufgeführt in `modules/disabled.json`; [docs/modules.md](../../docs/modules.de.md)).

**Nur der Leaf-Service liegt in diesem Baum.** Es gibt kein Verzeichnis `app/`, daher sind hier
weder Seiten noch API-Routen noch ein Manifest für die Kernel-App enthalten. Die Kernel-seitige
Hälfte ist in dieser README nicht dokumentiert.

| | |
|---|---|
| Verzeichnis / `module.json`-ID | `finance` |
| Manifest-ID (Schlüssel in `config.modules`) | nicht in diesem Baum (keine Manifestdatei) |
| Paket | `finance-service` |
| Navigationssegment | nicht in diesem Baum |
| Leaf-Service | ja, lauscht auf `PORT` (Standard 8080) |

## Aufbau

| Pfad | Inhalt |
|---|---|
| `src/` | Der Leaf: `http/` (Router, Guard, Routen, Multipart), `store/`, `tenant-store.ts`, `bank/` (Transaktionen, SEPA-Backend, XSD-Validierung), `csv/` (Import und IBAN-Prüfungen), `fints/` (Client, Sync, Passwortverschlüsselung), `exports/` (PDF, Tabelle), `storage/` (Belegspeicher), der Consumer für den Spiegel der Organisationseinheiten und `kernel-client.ts`. |
| `migrations/` | Schema des Leafs und das erzeugte `manifest.json`. |
| `scripts/` | `build-migration-manifest.mjs` (läuft als `prebuild`) und `backfill.ts` (einmaliges Kopieren aus der Datenbank eines Kernel-Mandanten). |
| `test/` | Unit- und Integrationstests des Leafs. |
| `RUNBOOK.md` | Betriebshinweise: Speicherschlüssel der Belege, die Ablehnung von Migration 006 bei doppelten Zeilen samt Vorabfragen, Probes. |

## Routen und API-Oberfläche

Nur Leaf (`src/http/routes.ts`), alle hinter dem Guard mit gemeinsamem Geheimnis außer
`/healthz`, alle unterhalb von `/api/v1`. Gruppen, keine vollständige Liste:

- `budget`, `budget-plans` (mit `groups`, `items`, `request-approval`, `activate`, `close`,
  `statement`, `statement/pdf`, `export`, `fiscal-year`), `fiscal-years`
- `projects`, `expenses` (mit `receipts` und `publish` für Belege), `bookings`
- `approvals` (`pending`, Anlegen, `sign`, `reject`) und `request-approval` bei Projekten und
  Ausgaben
- `bank-accounts` (mit `fints`, `fints/sync`, `csv-import`), `bank-transactions/:id/allocate-split`
- `payment-orders` (`record-cash-payout`, `record-manual-payout`, `suggest-matches`),
  `sepa/export`, `cash-boxes/:ledgerId/reconcile`
- `sub-org-types`, `sub-orgs` (mit `summary`), `org-units/:orgUnitId/finance-refs`
- `finanzordnung` (mit `signer-config`)
- `GET /healthz/tenants`, hinter dem gemeinsamen Geheimnis, nur boolesche Werte

## Migrationen

Eine Datenbank pro Mandant (`finance_<slug>`). Vom Leaf angewendet und gegen
`migrations/manifest.json` geprüft.

| Datei | Inhalt |
|---|---|
| `001_finance_init.sql` | das Schema `finance`: Profile, Einheiten, Bank- und Hauptbuchkonten, Transaktionen, FinTS-Konfiguration, CSV-Importprofile, Rücklagen, Haushaltsjahre, Haushaltspläne/-abschnitte/-gruppen/-titel, Projekte, Ausgaben, Belege, Anhänge, Buchungen, Zahlungsaufträge, Freigaben und Stufen, Inventar, Kassenprüfung, Entlastung, Kommentare, Abgleich |
| `002_org_unit_mirror.sql` | im Leaf liegender Spiegel der Organisationseinheiten, der Katalog der Governance-Typen für Unterorganisationen, das Idempotenz-Register des Consumers |
| `003_money_running_no_fiscal_year_idx.sql` | Unique-Index auf der laufenden Nummer, je Ledger und Haushaltsjahr |
| `004_money_fk_indexes.sql` | Indizes auf Fremdschlüsselspalten, die von den Geld-Routen verwendet werden |
| `005_unwrap_double_encoded_jsonb.sql` | repariert JSONB-Werte, die ein früheres Backfill doppelt kodiert gespeichert hat |
| `006_approval_single_open.sql` | eine offene Freigabe je freigabepflichtigem Objekt und ein aktiver Zahlungsauftrag je Ausgabe; wird nicht angewendet, wenn bereits Duplikate vorhanden sind (siehe `RUNBOOK.md`) |

Beim Deaktivieren des Moduls für einen Mandanten wird die Datenbank mit `pg_dump` exportiert
(Aufbewahrungsprofil `rp-fin-module-data`); `finance.fints_config.password_encrypted` wird
dabei zurückgehalten (`module.json`).

## Konfiguration

| Variable | Bedeutung |
|---|---|
| `INTERNAL_FINANCE_SECRET` | Gemeinsames Geheimnis in `x-internal-auth`. |
| `FINANCE_PG_URL` | PostgreSQL-Server des Moduls; Pflicht, kein Standardwert. |
| `NATS_URL` | Aktiviert den Consumer für den Spiegel der Organisationseinheiten (Stream `ORGUNIT`); ohne Wert bleibt er aus. |
| `ORGUNIT_CONSUMER_PATTERN` | Subject-Muster für diesen Consumer. |
| `FINANCE_FINTS_PASSWORD_KEY` (Alias `FINTS_PASSWORD_KEY`) | 64 Hexadezimalzeichen (32 Byte), AES-256-GCM-Schlüssel für das gespeicherte FinTS-Passwort. |
| `FINTS_PRODUCT_ID` | Produktregistrierungs-ID für FinTS. |
| `STORAGE_BACKEND` | Belegspeicher: `local` (Standard) oder `nextcloud`. |
| `RECEIPT_STORAGE_DIR` | Wurzelverzeichnis für das Backend `local`. |
| `STORAGE_NEXTCLOUD_USER` | Systembenutzer für das Backend `nextcloud` (Standard `NEXTCLOUD_ADMIN_USER`, sonst `admin`). |
| `NEXTCLOUD_URL`, `NEXTCLOUD_ADMIN_USER`, `NEXTCLOUD_ADMIN_PASSWORD` | WebDAV-Ziel für das Backend `nextcloud`. |
| `SHUTDOWN_TIMEOUT_MS`, `PORT` | Zeitlimit beim Herunterfahren, Listen-Port. |

Die Kernel-App erreicht den Leaf über `FINANCE_SERVICE_URL`
(`infra/host/templates/env/app.env.tmpl`); der Code, der sie liest, liegt nicht in diesem Baum.

Der PostgreSQL-Server des Moduls ist `finance-postgres` unter dem Compose-Profil `finance`
(`FINANCE_PG_USER`, `FINANCE_PG_PASSWORD`).

## Externe Dienste

- Der PostgreSQL-Server des Moduls.
- NATS, für den Spiegel der Organisationseinheiten (beim Start optional).
- Eine Bank über FinTS, nur wenn dafür ein Bankkonto konfiguriert ist.
- Nextcloud, nur mit `STORAGE_BACKEND=nextcloud`.

## Aktivieren und Deaktivieren

- Build: durch `modules/disabled.json` **ausgeschlossen**; das Runbook zum
  Mandanten-Lebenszyklus setzt voraus, dass ein Modul nicht in dieser Datei steht, bevor es
  für einen Kunden aktiviert werden kann.
- Leaf: `docker build -f modules/finance/Dockerfile .` im Wurzelverzeichnis des Repositorys.
- Die Schalter pro Kunde und für die Instanz benötigen das Kernel-seitige Manifest, das dieser
  Baum nicht enthält.

## Tests

- `pnpm --filter finance-service test` (Unit, `test/`), `typecheck`, `typecheck:tests`.
- `pnpm --filter finance-service test:integration`: benötigt einen Wegwerf-PostgreSQL über
  `FINANCE_TEST_PG_URL`.

## Aus dem Code nicht belegt

- Die Beschreibung in `package.json` besagt, die Routenoberfläche sei bis zu einer Umstellung
  (Cutover) gesperrt; die Kommentare im Quellcode besagen, jede Operation sei aktiv. Diese
  README folgt dem Quellcode.
- Die obige Routenliste stammt aus der Routentabelle; Request- und Response-Formate wurden
  hier nicht dokumentiert.
