<!-- i18n-sync: source=README.md sha256=0eb467782887420eec2596532fe0db4f232ed650833ce4254dd16da2976f3492 -->
[English](./README.md) | **Deutsch**

# content

Content-Engine: Ein Beitrag wird einmal verfasst und auf bis zu drei Kanälen veröffentlicht,
nämlich per E-Mail (über Mailinglisten), im Website-Portal (News-Beiträge) und auf Instagram
(Karussell). Das Modul enthält außerdem Mailinglisten, die Verwaltung von Abmeldungen, zeitgesteuerte
Veröffentlichung und eine Warteschlange für Veröffentlichungsvorgänge. Status:
**standardmäßig deaktiviert** (aufgeführt in `modules/disabled.json`, daher vom
Standard-Build und -Deploy ausgeschlossen; [docs/modules.md](../../docs/modules.de.md)).

| | |
|---|---|
| Verzeichnis / `module.json`-ID | `content` |
| Manifest-ID (Schlüssel in `config.modules`) | `content` |
| Paket | `content-service` |
| Navigationssegment | `/content` (Mindestrolle: Mitglied); Schreiben und Veröffentlichen sind durch Capabilities abgesichert |
| Leaf-Service | ja, lauscht auf `PORT` (Standard 8080) |

## Aufbau

| Pfad | Inhalt |
|---|---|
| `app/` | Die In-Process-Hälfte, über `gremion-ui/src/` gelegt: Seiten unter `/content` und `/news`, API-Routen, Backend-Port, Manifest, Kernel-Migrationen unter `app/migrations/`, ein Nachweisskript unter `app/scripts/`. |
| `src/` | Der Leaf-Service: `http/` (Routen und die Admin-Routen für den Abbau eines Mandanten), `store/`, `tenant-store.ts`, `publish-channel.ts`, `dispatch.ts`, `outbox.ts` und das NATS-Relay, `scheduler.ts`, `instagram/`, `kernel-client.ts`. |
| `migrations/` | Schema des Leafs und das erzeugte `manifest.json`. |
| `scripts/` | `build-migration-manifest.mjs` (läuft als `prebuild`) und `backfill.ts` (einmaliges Kopieren aus der Datenbank eines Kernel-Mandanten in die Leaf-Datenbank). |
| `test/` | Unit- und Integrationstests des Leafs. |

## Routen und API-Oberfläche

Kernel-App (`app/routes/`):

| Route | Methoden |
|---|---|
| `/content`, `/content/new`, `/content/[id]/edit`, `/content/lists`, `/content/lists/[id]`, `/content/unsubscribe` | Seiten |
| `/news`, `/news/[id]/edit` | Seiten |
| `/api/content/posts`, `/api/content/posts/[id]` | GET, POST; GET, PATCH, DELETE |
| `/api/content/posts/[id]/recipients` | GET, PUT |
| `/api/content/posts/[id]/publish/[channel]` | POST |
| `/api/content/posts/[id]/preview/[channel]` | GET |
| `/api/content/posts/[id]/carousel/[index]` | GET |
| `/api/content/lists`, `.../lists/[id]`, `.../lists/[id]/members`, `.../members/[memberId]` | GET, POST; DELETE; POST; DELETE |
| `/api/news`, `/api/news/[id]` | POST; PATCH, DELETE |
| `/api/internal/content/portal-publish` | POST (Callback vom Leaf an den Kernel) |

Leaf (`src/http/routes.ts`), Guard mit gemeinsamem Geheimnis außer bei `/healthz`:
`/api/v1/lists` und `/members`, `/api/v1/posts` mit `/recipients`, `/media`, `/channels`,
`/publish` und `/publish/:channel`, `/api/v1/unsubscribe`, `/api/v1/deliveries/...`,
`/api/v1/publications/:postId/:channel`, `/api/v1/publish-ops`, `/api/v1/stats`,
`POST /api/v1/posts/:id/audit` und `GET /healthz/tenants`. Die Admin-Routen
`DELETE /api/admin/tenants/:slug/db` und `DELETE /api/admin/tenants/:tenantId/catalog` werden
beim Löschen eines Mandanten aufgerufen und akzeptieren ausschließlich das gemeinsame Geheimnis.

Im Manifest deklarierte Capabilities: `content.author` und `content.publish` (an die Gruppen
`admin` und `it-admin` vergeben) sowie `content.publish.instagram`, deklariert mit leerer
Vergabeliste.

## Migrationen

Zwei Sätze an zwei Orten.

Leaf, eine Datenbank pro Mandant (`content_<slug>`), vom Leaf angewendet und gegen
`migrations/manifest.json` geprüft:

| Datei | Inhalt |
|---|---|
| `001_init.sql` | das Schema `content` (`posts`, `post_media`, `post_channels`, `mailing_lists`, `mailing_list_members`, `post_recipients`, `unsubscribes`, `send_tokens`, `deliveries`, `publications`, `publish_ops`) sowie `outbox` und `event_consumption` |
| `002_posts_status.sql` | Spalten für den Versand-Lebenszyklus in `content.posts` |
| `003_content_audit.sql` | `content.content_audit` |

Kernel, angewendet auf die Kernel-Datenbank: `app/migrations/1200_content_news_posts.sql` und
`1201_news_posts_public_reader_columns.sql` (die News-Beiträge, die der Portal-Kanal
schreibt). Das Manifest nennt außerdem die Kernel-Migrationen `044_content_schema`,
`045_content_publish` und `046_content_publish_ops` als Eigentum dieses Moduls; diese Dateien
liegen nicht in diesem Baum.

Beim Deaktivieren des Moduls für einen Mandanten wird die Datenbank mit `pg_dump` exportiert
(Aufbewahrungsprofil `rp-pub-module-data`); `content.send_tokens.token` wird dabei
zurückgehalten (`module.json`). Dort sind zwei zeitgesteuerte Jobs deklariert,
`content-publish` und `content-instagram-publish`, beide nur für die aktive Farbe.

## Konfiguration

| Variable | Verwendet von | Bedeutung |
|---|---|---|
| `CONTENT_BACKEND` | Kernel-App | `inprocess` (Standard) oder `service`. |
| `CONTENT_SERVICE_URL` | Kernel-App | Basis-URL des Leafs, wenn das Backend `service` ist. |
| `INTERNAL_CONTENT_SECRET` | beide | Gemeinsames Geheimnis in `x-internal-auth`. |
| `CONTENT_PG_URL` | Leaf | PostgreSQL-Server des Moduls; Pflicht, kein Standardwert. |
| `NATS_URL` | Leaf | Aktiviert das Outbox-Relay. |
| `KERNEL_BASE_URL` | Leaf | Basis-URL des Kernels für die Callbacks zu Portal-Veröffentlichung, Mailversand und Gruppenauflösung. |
| `PUBLIC_BASE_URL` | Leaf | Dient zum Bilden öffentlicher Links und Folien-URLs. |
| `CONTENT_ALLOW_LOOPBACK_LINKS` | Leaf | Erlaubt Loopback-Basen für Links (Entwicklung). |
| `CONTENT_SCHEDULER_ENABLED`, `SCHEDULER_ENABLED` | Leaf | Schalten den Veröffentlichungs-Scheduler ein oder aus; die modulspezifische Variable hat Vorrang, wenn sie nicht leer ist. |
| `CONTENT_INSTAGRAM_IG_USER_ID`, `CONTENT_INSTAGRAM_TOKEN_REF` | Kernel-App | Instagram-Konto-ID und ein Verweis auf das Token. |
| `IG_PAGE_ACCESS_TOKEN`, `IG_INSTAGRAM_ACCOUNT_ID` | Leaf | Instagram-Zugangsdaten, gelesen von `src/instagram/credentials.ts`; zusammen mit `PUBLIC_BASE_URL` müssen alle drei gesetzt sein, sonst werden Instagram-Veröffentlichungsvorgänge ohne jeden Netzwerkaufruf als fehlgeschlagen markiert. |
| `SHUTDOWN_TIMEOUT_MS`, `PORT`, `TRACE_EXPORTER` | Leaf, App | Zeitlimit beim Herunterfahren, Listen-Port, Tracing. |

Der PostgreSQL-Server des Moduls ist `content-postgres` unter dem Compose-Profil `content`
(`CONTENT_PG_USER`, `CONTENT_PG_PASSWORD`).

## Externe Dienste

- NATS, für das Outbox-Relay.
- SMTP, erreicht über den Callback `/api/internal/newsletter/send-mail` des Kernels.
- Die Instagram-API (Meta Graph), nur wenn die Instagram-Zugangsdaten gesetzt sind.
- Der PostgreSQL-Server des Moduls.

## Aktivieren und Deaktivieren

- Build: durch `modules/disabled.json` **ausgeschlossen**. Das Overlay-Skript lehnt ein
  deaktiviertes Modul im Build-Modus ab, und das Runbook zum Mandanten-Lebenszyklus setzt
  voraus, dass ein Modul nicht in dieser Datei steht, bevor es für einen Kunden aktiviert
  werden kann.
- Instanzeinstellung: `config.modules.content = false` beantwortet `/content` und
  `/api/content` mit der Oberfläche für deaktivierte Module.
- Leaf: `docker build -f modules/content/Dockerfile .` im Wurzelverzeichnis des Repositorys.

## Tests

- `pnpm --filter content-service test` (Unit, `test/`), `typecheck`, `typecheck:tests`.
- `pnpm --filter content-service test:integration`: benötigt einen Wegwerf-PostgreSQL über
  `CONTENT_TEST_PG_URL`.
- `app/scripts/news-posts-public-grant-proof.test.mjs` deckt das Grant-Nachweisskript für die
  News-Beiträge ab.

## Aus dem Code nicht belegt

- Es kommen zwei Sätze von Instagram-Variablennamen vor (`CONTENT_INSTAGRAM_*` in der
  App-Hälfte, `IG_*` im Leaf). Welcher Satz für welchen Backend-Modus gesetzt werden muss,
  wurde hier nicht geklärt.
- Die Capability `content.publish.instagram` hat im Manifest eine leere Vergabeliste; ob eine
  andere Datei eine Vergabe enthält, wurde nicht geprüft.
