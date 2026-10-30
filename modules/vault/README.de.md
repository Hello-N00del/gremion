<!-- i18n-sync: source=README.md sha256=44e76636aedb23c7d404801695858a56340a706ae6db2875da5e15abf3a2d626 -->
[English](./README.md) | **Deutsch**

# vault

Geheimnisspeicher für Organisationseinheiten: Einträge mit Metadaten, Geheimnisse, die der
Leaf-Prozess verschlüsselt speichert (AES-256-GCM, Encryption at Rest), ein Offenlegungspfad (Reveal), der
eine kürzlich erfolgte Step-up-Anmeldung verlangt und in ein Zugriffslog schreibt, und eine
Startseite (Launcher) für eine extern betriebene Vaultwarden-Instanz.
Status: **standardmäßig deaktiviert** (in `modules/disabled.json` aufgeführt und damit vom
Standard-Build und -Deploy ausgeschlossen; [docs/modules.de.md](../../docs/modules.de.md)).

| | |
|---|---|
| Verzeichnis / `module.json`-ID | `vault` |
| Manifest-ID (Schlüssel in `config.modules`) | `vault` |
| Paket | `vault-service` |
| Navigation | Segment `/vault` (Mindestrolle: member) mit dem Eintrag „Tresor“; `/vault-extern` für den Vaultwarden-Launcher |
| Leaf-Service | ja, lauscht auf `PORT` (Standard 8080); das einzige Backend, eine In-Process-Implementierung gibt es nicht |

## Aufbau

| Pfad | Inhalt |
|---|---|
| `app/` | Die In-Process-Hälfte, die über `gremion-ui/src/` gelegt wird: Seiten, API-Routen, der Service-Client hinter dem Backend-Port, Hilfsfunktionen für die Tresor-Ansicht, Manifest. |
| `src/` | Der Leaf: `http/` (Server, Guard, Routen), `store/`, `crypto.ts`. |
| `migrations/` | Leaf-Schema und das erzeugte `manifest.json`. |
| `scripts/build-migration-manifest.mjs` | Schreibt `migrations/manifest.json`; läuft als `prebuild`. |
| `test/` | Unit- und Integrationstests des Leaf. |

## Routen und API-Oberfläche

Kernel-App (`app/routes/`):

| Route | Methoden |
|---|---|
| `/vault`, `/vault-extern` | Seiten |
| `/api/vault` | GET, POST |
| `/api/vault/[id]` | GET, PUT, DELETE |
| `/api/vault/[id]/secret` | GET (Reveal; antwortet mit 401 `STEP_UP_REQUIRED`, bis eine frische Zweitstufen-Anmeldung vorliegt) |
| `/api/vault/access-log` | GET |

`/vault-extern` verlinkt nur auf die Instanz, die `VAULTWARDEN_BASE_URL` nennt; der Kernel
richtet sie weder ein noch verwaltet er sie. Solange die Variable nicht gesetzt ist, zeigt
die Seite einen deaktivierten Zustand.

Leaf (`src/http/routes.ts`), Shared-Secret-Guard außer für `/health` und `/healthz`:
`GET|POST /items`, `GET|PUT|DELETE /items/:id`, `GET /items/:id/secret`, `GET /access-log`.

## Migrationen

Der Leaf nutzt eine Datenbank, die über `VAULT_PG_URL` konfiguriert wird; die Migrationen
laufen beim ersten Kontakt des Stores und werden gegen `migrations/manifest.json` geprüft.

| Datei | Inhalt |
|---|---|
| `001_init.sql` | `vault_item` (Metadaten plus Geheimnis als Chiffretext) und `access_log` |
| `002_access_log_survives_delete.sql` | Zeilen des Zugriffslogs bleiben erhalten, wenn ihr Eintrag gelöscht wird |

Wird das Modul für einen Mandanten deaktiviert, wird die Datenbank mit `pg_dump` exportiert
(Aufbewahrungsprofil `rp-pwd-module-data`), unter Auslassung von
`public.vault_item.secret_ciphertext` (`module.json`).

## Konfiguration

| Variable | Verwendet von | Bedeutung |
|---|---|---|
| `VAULT_BACKEND` | Kernel-App | `service` (Standard) ist der einzige gültige Wert. |
| `VAULT_SERVICE_URL` | Kernel-App | Basis-URL des Leaf. |
| `INTERNAL_VAULT_SECRET` | beide | Shared Secret in `x-internal-auth`. Nicht gesetzt: Der Leaf startet, und jede geschützte Route antwortet mit 403. |
| `VAULT_PG_URL` | Leaf | PostgreSQL-URL der Datenbank des Leaf; Pflicht, kein Standardwert. |
| `VAULT_ENCRYPTION_KEY` | Leaf | 64 Hex-Zeichen (32 Bytes), der AES-256-GCM-Schlüssel. Fehlt er oder ist er fehlerhaft: Der Leaf verweigert den Start. |
| `VAULT_REVEAL_REQUIRE_STEPUP` | Kernel-App | Standardmäßig an; `false` schaltet die Step-up-Anforderung für das Reveal ab. |
| `STEPUP_FRESHNESS_SECONDS` | Kernel-App | Wie aktuell die Zweitstufen-Anmeldung sein muss. |
| `VAULTWARDEN_BASE_URL` | Kernel-App | Adresse eines extern betriebenen Vaultwarden für die Launcher-Seite. |
| `PORT`, `TRACE_EXPORTER` | Leaf, App | Listen-Port; Tracing-Exporter. |

Der PostgreSQL-Server des Moduls ist `vault-postgres` unter dem Compose-Profil `vault`
(`VAULT_PG_USER`, `VAULT_PG_PASSWORD`).

## Externe Dienste

- Der PostgreSQL-Server des Moduls.
- Vaultwarden, nur für die Launcher-Seite und nur, wenn die Betreiber:innen eine Instanz davon betreiben.

## Aktivieren und Deaktivieren

- Build: **ausgeschlossen** durch `modules/disabled.json`; das Runbook zum Mandanten-Lebenszyklus
  verlangt, dass ein Modul nicht in dieser Datei steht, bevor es für einen Kunden
  aktiviert werden kann.
- Instanzeinstellung: Mit `config.modules.vault = false` liefern `/vault` und `/api/vault`
  die Antwort für deaktivierte Module aus, und der Navigationseintrag entfällt.
- Leaf: `docker build -f modules/vault/Dockerfile .` aus dem Repository-Root.

## Tests

- `pnpm --filter vault-service test` (Unit, `test/`), `typecheck`.
- `pnpm --filter vault-service test:integration`: benötigt ein Wegwerf-PostgreSQL über
  `VAULT_TEST_PG_URL`; `test/support/pg-test-guard.ts` weist jede Datenbank zurück, die
  nicht eine lokale Wegwerf-Datenbank ist.
- Tests unter `app/` liegen neben dem Code und werden vom `test`-Skript des Pakets nicht
  eingesammelt.

## Nicht aus dem Code belegt

- Der Leaf liest genau eine `VAULT_PG_URL`. Alles darüber hinaus, wie ein Deployment
  Datenbanken anordnet, liegt außerhalb dieses Verzeichnisses und wird hier nicht
  beschrieben.
