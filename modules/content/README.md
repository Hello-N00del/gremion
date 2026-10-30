# content

Content engine: a post is written once and published to up to three channels, e-mail
(through mailing lists), the website portal (news posts) and Instagram (carousel). It also
holds mailing lists, unsubscribe handling, scheduled publishing and a publish-operation
queue. Status: **disabled by default** (listed in `modules/disabled.json`, so it is excluded
from the default build and deploy; [docs/modules.md](../../docs/modules.md)).

| | |
|---|---|
| Directory / `module.json` id | `content` |
| Manifest id (`config.modules` key) | `content` |
| Package | `content-service` |
| Navigation segment | `/content` (minimum role: member); writing and publishing are capability-gated |
| Leaf service | yes, listens on `PORT` (default 8080) |

## Layout

| Path | Contents |
|---|---|
| `app/` | The in-process half, overlaid onto `gremion-ui/src/`: pages under `/content` and `/news`, API routes, backend port, manifest, kernel migrations under `app/migrations/`, a proof script under `app/scripts/`. |
| `src/` | The leaf service: `http/` (routes and the tenant-teardown admin routes), `store/`, `tenant-store.ts`, `publish-channel.ts`, `dispatch.ts`, `outbox.ts` and the NATS relay, `scheduler.ts`, `instagram/`, `kernel-client.ts`. |
| `migrations/` | Leaf schema and the generated `manifest.json`. |
| `scripts/` | `build-migration-manifest.mjs` (runs as `prebuild`) and `backfill.ts` (one-shot copy from a kernel tenant database into the leaf database). |
| `test/` | Leaf unit and integration tests. |

## Routes and API surface

Kernel app (`app/routes/`):

| Route | Methods |
|---|---|
| `/content`, `/content/new`, `/content/[id]/edit`, `/content/lists`, `/content/lists/[id]`, `/content/unsubscribe` | pages |
| `/news`, `/news/[id]/edit` | pages |
| `/api/content/posts`, `/api/content/posts/[id]` | GET, POST; GET, PATCH, DELETE |
| `/api/content/posts/[id]/recipients` | GET, PUT |
| `/api/content/posts/[id]/publish/[channel]` | POST |
| `/api/content/posts/[id]/preview/[channel]` | GET |
| `/api/content/posts/[id]/carousel/[index]` | GET |
| `/api/content/lists`, `.../lists/[id]`, `.../lists/[id]/members`, `.../members/[memberId]` | GET, POST; DELETE; POST; DELETE |
| `/api/news`, `/api/news/[id]` | POST; PATCH, DELETE |
| `/api/internal/content/portal-publish` | POST (leaf-to-kernel callback) |

Leaf (`src/http/routes.ts`), shared-secret guard except `/healthz`: `/api/v1/lists` and
`/members`, `/api/v1/posts` with `/recipients`, `/media`, `/channels`, `/publish` and
`/publish/:channel`, `/api/v1/unsubscribe`, `/api/v1/deliveries/...`,
`/api/v1/publications/:postId/:channel`, `/api/v1/publish-ops`, `/api/v1/stats`,
`POST /api/v1/posts/:id/audit`, and `GET /healthz/tenants`. The admin routes
`DELETE /api/admin/tenants/:slug/db` and `DELETE /api/admin/tenants/:tenantId/catalog` are
called by tenant deletion and take the shared secret only.

Capabilities declared in the manifest: `content.author` and `content.publish` (granted to the
`admin` and `it-admin` groups), and `content.publish.instagram`, declared with an empty grant
list.

## Migrations

Two sets, in two places.

Leaf, one database per tenant (`content_<slug>`), applied by the leaf and checked against
`migrations/manifest.json`:

| File | Content |
|---|---|
| `001_init.sql` | the `content` schema (`posts`, `post_media`, `post_channels`, `mailing_lists`, `mailing_list_members`, `post_recipients`, `unsubscribes`, `send_tokens`, `deliveries`, `publications`, `publish_ops`) plus `outbox` and `event_consumption` |
| `002_posts_status.sql` | dispatch-lifecycle columns on `content.posts` |
| `003_content_audit.sql` | `content.content_audit` |

Kernel, applied to the kernel database: `app/migrations/1200_content_news_posts.sql` and
`1201_news_posts_public_reader_columns.sql` (the news posts the portal channel writes). The
manifest also names the kernel migrations `044_content_schema`, `045_content_publish` and
`046_content_publish_ops` as owned by this module; those files are not in this tree.

Disabling the module for a tenant exports the database with `pg_dump` (retention profile
`rp-pub-module-data`), withholding `content.send_tokens.token` (`module.json`). Two timed
jobs are declared there, `content-publish` and `content-instagram-publish`, both for the
active colour only.

## Configuration

| Variable | Used by | Meaning |
|---|---|---|
| `CONTENT_BACKEND` | kernel app | `inprocess` (default) or `service`. |
| `CONTENT_SERVICE_URL` | kernel app | Base URL of the leaf when the backend is `service`. |
| `INTERNAL_CONTENT_SECRET` | both | Shared secret in `x-internal-auth`. |
| `CONTENT_PG_URL` | leaf | PostgreSQL server of the module; required, no default. |
| `NATS_URL` | leaf | Enables the outbox relay. |
| `KERNEL_BASE_URL` | leaf | Kernel base URL for the portal-publish, mail-send and group-resolution callbacks. |
| `PUBLIC_BASE_URL` | leaf | Used to build public links and slide URLs. |
| `CONTENT_ALLOW_LOOPBACK_LINKS` | leaf | Permits loopback link bases (development). |
| `CONTENT_SCHEDULER_ENABLED`, `SCHEDULER_ENABLED` | leaf | Switch the publish scheduler; the per-module variable wins when non-empty. |
| `CONTENT_INSTAGRAM_IG_USER_ID`, `CONTENT_INSTAGRAM_TOKEN_REF` | kernel app | Instagram account id and a reference to the token. |
| `IG_PAGE_ACCESS_TOKEN`, `IG_INSTAGRAM_ACCOUNT_ID` | leaf | Instagram credentials read by `src/instagram/credentials.ts`; with `PUBLIC_BASE_URL` all three must be set, otherwise Instagram publish operations are marked failed without any network call. |
| `SHUTDOWN_TIMEOUT_MS`, `PORT`, `TRACE_EXPORTER` | leaf, app | Shutdown limit, listen port, tracing. |

The module's PostgreSQL server is `content-postgres` under the compose profile `content`
(`CONTENT_PG_USER`, `CONTENT_PG_PASSWORD`).

## External services

- NATS, for the outbox relay.
- SMTP, reached through the kernel's `/api/internal/newsletter/send-mail` callback.
- The Instagram (Meta Graph) API, only when the Instagram credentials are set.
- The module's PostgreSQL server.

## Enabling and disabling

- Build: **excluded** by `modules/disabled.json`. The overlay script refuses a disabled
  module in build mode, and the tenant-lifecycle runbook requires a module not to be in that
  file before it can be enabled for a customer.
- Instance setting: `config.modules.content = false` answers `/content` and `/api/content`
  with the module-disabled surface.
- Leaf: `docker build -f modules/content/Dockerfile .` from the repository root.

## Tests

- `pnpm --filter content-service test` (unit, `test/`), `typecheck`, `typecheck:tests`.
- `pnpm --filter content-service test:integration`: needs a throwaway PostgreSQL via
  `CONTENT_TEST_PG_URL`.
- `app/scripts/news-posts-public-grant-proof.test.mjs` covers the news-posts grant proof
  script.

## Not established from the code

- Two sets of Instagram variable names appear (`CONTENT_INSTAGRAM_*` in the app half,
  `IG_*` in the leaf). Which one an operator must set for a given backend mode was not
  resolved here.
- The capability `content.publish.instagram` has an empty grant list in the manifest; no
  other file was checked for a grant.
