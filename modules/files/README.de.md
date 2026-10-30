<!-- i18n-sync: source=README.md sha256=d335cb6ef755d894a4690e06250d29b8d9dc4e8b23df63d1d23fd6453a3ec90f -->
[English](./README.md) | **Deutsch**

# files

Dokumentenbrowser über Nextcloud: Auflisten, Herunterladen, Hochladen (auch in Teilen),
Ordner anlegen, Verschieben, Kopieren und Löschen, dazu ein Dateibereich je Gruppe und die
Bearbeitung unterstützter Dokumenttypen im Browser über Collabora. Der Leaf ist ein dünner,
zustandsloser WebDAV-Proxy.
Status: **unterstützt** ([docs/modules.de.md](../../docs/modules.de.md)).

| | |
|---|---|
| Verzeichnis / `module.json`-ID | `files` |
| Manifest-ID (Schlüssel in `config.modules`) | `files` |
| Paket | `files-service` |
| Navigationssegment | `/files` (Mindestrolle: Mitglied; Gäste haben kein Nextcloud-Konto) |
| Leaf-Service | ja, zustandslos, lauscht auf `PORT` (Standard 8080) |

## Aufbau

| Pfad | Inhalt |
|---|---|
| `app/` | Die prozessinterne Hälfte, über `gremion-ui/src/` gelegt: Seiten, API-Routen, Komponenten des Dateibrowsers, der Nextcloud-Client und die WebDAV-Pfadbehandlung, Hilfsfunktionen für Protokolldokumente, Backend-Port, Manifest. |
| `src/` | Der Leaf: `http/` (Server und die Prüfung des gemeinsamen Geheimnisses), `nextcloud/` (WebDAV-Client und Pfadbereinigung). |
| `test/` | Unit- und Integrationstests des Leafs. |

## Routen und API-Oberfläche

Kernel-App (`app/routes/`):

| Route | Methoden |
|---|---|
| `/files`, `/files/[...path]`, `/files/groups/[group]`, `/files/edit/[...path]` | Seiten |
| `/api/files/[...path]` | GET, PUT, DELETE, PATCH |
| `/api/files/upload-chunk` | POST |
| `/api/files/edit-token/[...path]` | GET: liefert ein kurzlebiges WOPI-Token und die URL des Collabora-Editors (über die Nextcloud-API `richdocuments`); der Browser spricht danach direkt mit Collabora |

Leaf (`src/http/server.ts`): `/healthz` (ohne Prüfung) und die Operationen `/api/v1/propfind`,
`download`, `upload`, `mkcol`, `delete`, `move`, `copy` (jede läuft als die angemeldete Person,
mit deren Bearer in `x-webdav-bearer`) sowie `/api/v1/upload-chunk`. Das gemeinsame
Geheimnis steht in `x-internal-auth`, der Mandant in `x-tenant-id` und `x-tenant-slug`.

## Migrationen

Keine. Das Modul hat keine Datenbank (`module.json`: `database: null`).

## Konfiguration

| Variable | Verwendet von | Bedeutung |
|---|---|---|
| `FILES_BACKEND` | Kernel-App | `inprocess` (Standard) oder `service`; jeder andere Wert wird abgelehnt. |
| `FILES_SERVICE_URL` | Kernel-App | Basis-URL des Leafs, wenn das Backend `service` ist. |
| `INTERNAL_FILES_SECRET` | beide | Gemeinsames Geheimnis in `x-internal-auth`. Nicht gesetzt: Der Leaf startet, und jede geschützte Route antwortet mit 403. |
| `NEXTCLOUD_URL` | beide | Basis-URL von Nextcloud; der Leaf schreibt eine Warnung ins Log und fällt auf `http://nextcloud` zurück, wenn sie nicht gesetzt ist. |
| `NEXTCLOUD_ADMIN_USER`, `NEXTCLOUD_ADMIN_PASSWORD` | beide | Admin-Zugangsdaten für den Nextcloud-Client. |
| `PORT`, `TRACE_EXPORTER` | Leaf, App | Listen-Port; Tracing-Exporter. |

## Externe Dienste

- Nextcloud (WebDAV und die OCS-API `richdocuments`).
- Collabora, für die Bearbeitung.

Keiner der beiden ist in den Compose-Dateien im Repository-Stammverzeichnis definiert; die
Betreiber:in stellt sie bereit.

## Aktivieren und Deaktivieren

- Build: im Standard-Build enthalten.
- Pro Kunde: `--enable files` bei der Anlage oder die Anfragen `enable_module` und
  `disable_module` des Panels ([runbooks/tenant-lifecycle.md](../../docs/runbooks/tenant-lifecycle.md), englisch).
- Instanzeinstellung: `config.modules.files = false` beantwortet `/files` mit der Seite für
  deaktivierte Module und `/api/files` mit einem nackten 403 und entfernt den Eintrag
  „Dokumente“ aus der Navigation. Die Nutzer:innen behalten ihre Konten.
- Leaf: `docker build -f modules/files/Dockerfile .` aus dem Repository-Stammverzeichnis.

## Tests

- `pnpm --filter files-service test` (Unit, `test/`), `test:integration` (die Konfiguration
  existiert; was sie benötigt, wurde nicht geprüft), `typecheck`.
- Tests unter `app/` liegen neben dem Code und werden vom Skript `test` des Pakets nicht
  erfasst.

## Nicht aus dem Code belegt

- Auf welche Nextcloud-App oder welches App-Passwort die Admin-Zugangsdaten abgebildet sein
  müssen, wurde nicht nachverfolgt.
