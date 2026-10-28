# Log Retention Policy

**Scope:** All services in the Gremion governance kernel
**Lawful basis (GDPR Art. 6):** Legitimate interest (security monitoring, incident response, abuse prevention)

> This is the operational policy for logs produced by the governance kernel. For
> the kernel's architecture, services, and design philosophy, see
> [about-gremion.md](./about-gremion.md). Carved-out feature modules (finance,
> files, messages, elections, content, etc.) live in their own repositories — one
> per module — and carry their own retention policies.

---

## Summary

Logs that may contain personal data (primarily client IP addresses, plus user
and tenant identifiers) are subject to the retention limits below. The kernel's
deployment model is Docker Compose; container stdout/stderr is captured by the
Docker `json-file` log driver and access-log retention is enforced by a dedicated
Vector pipeline. Personal data in access logs is pseudonymised before it is ever
persisted, and all retention windows are bounded by server-side hard caps.

**Operator ceiling [D R29-I6] (2026-09-30, R29-RETENTION-30):** no log class the
edge or the identity provider keeps is older than **30 days**, the pseudonymised
security and retained logs included. The edge files, Traefik's own log and the
Keycloak event store are held to it by configuration and proven by
`docker/vector/test-edge-retention-bound.sh`, the 60-day simulation
`docker/vector/test-edge-retention-sim.sh` and `test/edge-log-retention.bats`
(see "Upper bound"). The application-level tiers in "Retention Configuration"
carry the same ceiling (R29-RETENTION-30-K); none of them has a purge consumer in the
application, they are configuration and the windows of the log store.

---

## Architecture

```
 Traefik (edge, production)
   ├─ writes its own ERROR log ────────────────► traefik-logs volume
   │    (/logs/traefik.log, not stdout)               │ (rotated in place by the loop)
   └─ writes raw JSON access log ─────────────► traefik-logs volume
                                                       │
 vector container                                      │ tails
   ├─ process-logs.sh   ◄──────────────────────────────┘
   │     • keeps only security-relevant paths (/auth, /realms, /api, /admin)
   │     • pseudonymises ClientHost with ipcrypt-nd
   │     • redacts query strings (?<redacted>)
   │     └─ appends to /logs/processed/security.log
   ├─ vector.toml       (retention filter)
   │     • drops events older than LOG_RETENTION_SECONDS
   │     └─ writes date-partitioned /logs/processed/retained-YYYY-MM-DD.log
   └─ rotation loop     (hourly: logrotate rotates + compresses + ages out the
                          live logs, state file on the processed-logs volume;
                          prune-retained.sh deletes retained day files by the
                          date in their name)
```

Source: `docker/vector/` (`process-logs.sh`, `vector.toml`, `logrotate.conf`,
`prune-retained.sh`, `entrypoint.sh`). The Vector service runs in every deployment that runs Traefik
(the production profile); local dev exposes services on direct ports and has no
Traefik access log to process.

---

## Per-Service Retention

### Container logs (all services)

| Data | Retention | Deletion mechanism |
|------|-----------|-------------------|
| stdout/stderr application logs (postgres, gremion-ui, gremion-public, legal, vector, mailpit and the other services) | Bounded by **size**, not by time | Docker `json-file` driver with `max-size: 50m`, `max-file: 5` on every service in `docker-compose.yml` — old chunks are rotated out by size only, so a quiet service can keep a line for longer than 30 days. **Named residual [R29-RETENTION-30, Q17]:** these are application logs (TASK-033's classes), not edge or identity-provider logs; the durable time bound is the log shipper TASK-033 builds |
| Keycloak stdout | No event lines | `KC_SPI_EVENTS_LISTENER_JBOSS_LOGGING_ERROR_LEVEL: debug` on the keycloak service: the default `jboss-logging` listener would write every error event (`LOGIN_ERROR` with `ipAddress` and `username`) to stdout at WARN; at debug it stays off stdout at the default INFO root level. Events stay in the event store, see "Keycloak" |
| Traefik stdout | Start-up lines only | `docker/traefik/traefik.yml` `log:` writes Traefik's own ERROR-level JSON log to `/logs/traefik.log` on the `traefik-logs` volume, rotated by the vector loop (14 days, see "Traefik access logs"). Read it with `docker exec <vector container> cat /logs/traefik/traefik.log`; `docker logs` of Traefik no longer shows runtime errors |

Application logs are operational, not audit records. The two sources of client
addresses in the edge and identity-provider containers' stdout are closed:
Traefik's runtime log goes to a rotated file, and Keycloak's event lines are off
stdout (both above). Raising `KC_LOG_LEVEL` to debug would bring Keycloak's event
lines back.

---

### Traefik access logs (production)

| Data | Retention | Deletion mechanism |
|------|-----------|-------------------|
| Raw JSON access log (`/logs/traefik/access.log`, contains `ClientHost`) | 14 days on disk | `logrotate.conf` rule: `daily`, `maxage 14`, `rotate 14`, `compress`, `ifempty`, `copytruncate`. Vector only **tails** this file; it is rotated in place so the writing process keeps the same FD |
| Traefik's own log (`/logs/traefik/traefik.log`, ERROR level; may name a client address) | 14 days on disk | Same rule numbers as the access log. Written by Traefik itself (`docker/traefik/traefik.yml` `log.filePath`) instead of container stdout. `log.maxSize: 1000000` (MB) switches off Traefik's own size rotation: with `filePath` set Traefik writes through a size-rotating writer (0 means 100 MB, every backup kept for ever, and its size counter ignores `copytruncate`), and past the cap it would rename the live file to `traefik-<timestamp>.log.gz`, a name no rule here matches, so nothing would ever delete it. The bound model requires a cap no volume reaches, so logrotate is the only rotator |
| Pseudonymised security log (`/logs/processed/security.log`) | 27 days configured, at most 29 d 2 h 5 min on disk | `logrotate.conf` rule: `daily`, `maxage 27`, `rotate 27`, `compress`, `ifempty`, `copytruncate` |
| Date-partitioned retention sink (`/logs/processed/retained-YYYY-MM-DD.log`) | 27 days by the date in the file name (today − 27 … today, UTC) | Vector's `enforce_retention` transform drops events older than `LOG_RETENTION_SECONDS` on ingest; `prune-retained.sh`, run hourly by the loop in `entrypoint.sh`, deletes every form of a day file (base, `.log.N`, `.log.N.gz`) dated before today − 27 (`RETAINED_RETENTION_DAYS`, default 27). logrotate's `maxage` cannot do this: it is checked only on a rotation, and `notifempty` stops a day file's rotations after the first |
| logrotate state (`/logs/processed/.logrotate.status`) | Kept | `logrotate -s` in the loop: on the processed-logs volume, so a container re-create does not restart every live file's first-sighting day |

#### Upper bound

**B = 30 days** [D R29-I6]: no record any edge file keeps is older than
2592000 s. The arithmetic lives in one place, `docker/vector/test-edge-retention-bound.sh`
(static: it reads `logrotate.conf`, the prune default, the entrypoint's interval
clamp and `docker/traefik/traefik.yml`), and its printed table is:

```
Edge retention bound: B = 2592000 s (30d 0h 0m); I = 3600 s, R = 300 s, L = 90000 s
family           formula                          seconds  duration
access.log       (14+1) d + I + R                 1299900  15d 1h 5m  ok
traefik.log      (14+1) d + I + R                 1299900  15d 1h 5m  ok
security.log     (27+1) d + I + R + L             2513100  29d 2h 5m  ok
retained-*.log   (27+1) d + I + R + L (W=27)      2513100  29d 2h 5m  ok
```

`I` is the loop interval, clamped by the entrypoint to 60 … 3600 s (an operator
value outside that range, or a non-integer, is replaced by 3600 with one stderr
line). `R` = 300 s is the allowance for one loop run (logrotate + compress +
prune); the simulation fails if a run takes longer. `L` is the ingest lag of a
record replayed by `process-logs.sh`'s `tail -F` after a container restart (it
re-reads the last 10 raw lines, at most 1 d + `I` old) and applies to
`security.log` and the retained family only. That is why 27 days are configured,
not 28: with 28 the replay case reaches 30 d + 2 h 5 min, above B.

Every rule is `daily` and its `maxage` equals its `rotate`. **No live log carries
`notifempty`**: with it a day without traffic skipped the rotation, and `maxage`
is checked only on a rotation, so a quiet stretch (or a container stop) stretched
the live file past any bound. Each quiet day now adds one tiny empty `.gz`, which
`rotate` bounds. `docker/vector/test-edge-retention-sim.sh` runs the shipped
`logrotate.conf` and `prune-retained.sh` through the real logrotate in the built
image for 60 simulated days (20 with traffic, 20 without, 20 with) and checks
every surviving record on every day; `test/edge-log-retention.bats` runs the
static model and its mutation guards under `verify`.

Residuals, named: while the vector container is stopped nothing is rotated or
pruned and Traefik keeps appending, so the bound holds only while the container
runs (the first loop after a start deletes what has aged out). A stopped or
removed vector container raises `ContainerUnhealthy2m` with `component` naming it
(`gremion:cond:container_unhealthy` in `compose/observability/prometheus/rules.yml`,
TASK-039), so the operator learns of it within minutes. `tail -F` duplicates up to 10 records into `security.log`
on each restart (covered by `L`; the `tail -n 0 -F` fix belongs to TASK-033, which
owns `process-logs.sh`). A lost `vector-processed-logs` volume takes the security
and retained files with it and the Traefik files then span one extra day (still
under B).

**IP pseudonymisation:** `process-logs.sh` runs the client IP through `ipcrypt`
(`nd-encrypt`, format-preserving, keyed by the `ipcrypt_key` Docker secret) before
writing anything to the processed log. If pseudonymisation fails, the line is
**dropped** — a raw IP is never persisted. The key epoch (`IPCRYPT_KEY_EPOCH`) is
stamped on each record so a future key rotation is auditable.

**Query-string redaction:** Traefik logs the full request path including the query
string. `process-logs.sh` strips everything from the first `?` onward (replacing it
with `?<redacted>`) so OIDC authorization codes, Keycloak `session_code` values,
and similar secrets in query parameters are never persisted. The path itself is
retained.

**Path filtering:** only security-relevant paths (`/auth`, `/realms`, `/api`,
`/admin`) are written to the processed log at all. Every other request is dropped
and never persisted anywhere.

---

### Keycloak (identity & auth)

| Data | Retention | Deletion mechanism |
|------|-----------|-------------------|
| Application logs | No event lines; otherwise bounded by size | Ephemeral stdout, rotated by the Docker `json-file` driver (size only). Event lines (`LOGIN_ERROR` etc.) are kept off stdout by `KC_SPI_EVENTS_LISTENER_JBOSS_LOGGING_ERROR_LEVEL: debug` (compose, keycloak service); the old container log goes with the re-create at rollout |
| Login/auth events (`EVENT_ENTITY`, may store login IP) | 29 days (worst case 29 d + 15 min) | `eventsExpiration: 2505600` in `docker/keycloak/realm-export.base.json` — Keycloak's scheduler (900 s by default) purges expired events automatically |
| Admin/audit events (`ADMIN_EVENT_ENTITY`) | 29 days (worst case 29 d + 15 min) | The realm attribute `adminEventsExpiration: "2505600"` (top-level `attributes`, beside `acr.loa.map`, `adminEventsEnabled: true`). Since Keycloak 23 the admin-event purge reads this attribute, **not** `eventsExpiration`; both are set. Proven against the pinned 26.6.1 image: the attribute name is read by `JpaEventStoreProvider`, and events already stored (created before the expiry was lowered) are purged too |
| User sessions | `ssoSessionIdleTimeout: 7200s` / `ssoSessionMaxLifespan: 86400s` | Keycloak expires idle and over-age sessions automatically; Auth.js cookies in gremion-ui expire with the session |

The realm file applies when a tenant realm is created. Realms that already exist
keep the values they were created with; converging their `eventsExpiration` and
`adminEventsExpiration` (attributes merged, `acr.loa.map` untouched) is a
follow-up in gremion-ui's realm reconcile, owned by TASK-033's amendment.

---

### PostgreSQL

| Data | Retention | Deletion mechanism |
|------|-----------|-------------------|
| Query logs | Not enabled | `log_statement = 'none'` (PostgreSQL default) — statements are not logged |
| Governance domain data (committees, members, org-units, protocols, resolutions) | Until operator deletion | No automatic data expiry; operator-initiated deletion through the admin shell |
| INV-1 audit log (hash-chained governance audit trail) | No expiry by a timer: a governance record (RC-GOV-CHAIN, retention catalogue; operator decision 2026-10-28). It is not governed by `security_logs_days` | An integrity record, not a rotating log. Nothing purges it: gremion-ui schedules no purge, the host job `gremion-purge.timer` has no `audit_log` rule, and the application role (and the owner role it is a member of) holds no DELETE, UPDATE or TRUNCATE on it (`ensureKernelAuditAppendOnly`, at provisioning and on `reconcile`). A person's erasure request is answered by redaction, not by deleting the chain. The aged-prefix function `audit_log_purge_before` of migration 0059 stays defined and has no caller |

The INV-1 audit log records governance actions (who decided what, under which
quorum/decision rule). It is append-only: no row is updated or deleted, by the
application or by any timer. It is a governance record (retention catalogue gap G6 is
closed by the operator decision of 2026-10-28), so the edge-log rules above and the
four log windows below do not apply to it.

---

## Retention Configuration

Retention windows are set in `.env` (see `.env.example`, "Hardening" section).
Values are in seconds (days × 86400) and are bounded by server-side hard caps:

| Variable | Default | Hard cap |
|----------|---------|----------|
| `LOG_ACCESS_RETENTION_SECONDS` | 14 days (1209600) | 29 days (2505600) |
| `LOG_APP_RETENTION_SECONDS` | 28 days (2419200) | 29 days (2505600) |
| `LOG_SECURITY_RETENTION_SECONDS` | 27 days (2332800) | 29 days (2505600) |
| `LOG_SECURITY_NOPII_RETENTION_SECONDS` | 27 days (2332800) | 30 days (2592000) |

Operator ceiling 30 d [D R29-I6], R29-RETENTION-30-K: no figure in this table exceeds
it. The defaults and caps are those of the gremion-ui retention tiers
(`gremion-ui/src/lib/retention-tiers.ts`, one registry that the config clamp, the
settings API and the Settings tab all read): 29 d where the daily purge tick enforces
the window (29 d + 24 h = 30 d), 30 d for the tier without a purge consumer. A config
stored with a higher value (the former 90 / 180 / 365 days) is clamped when it is read,
and the clamp logs one warning per field. Only `LOG_ACCESS_RETENTION_SECONDS` is read
by `docker-compose.yml`; the other three document the tier defaults.

**TASK-033-a (Q6):** the four tiers are no longer a setting an admin can change: the
Settings API refuses the whole `retention` key (400) and the tab is read-only. The windows
are fixed by the retention registry (`packages/retention`, one source with
`docs/compliance/retention-catalogue.md`) and the Loki configuration is rendered from it
(`docker/loki/loki.yaml`). **Nothing in gremion-ui purges by any of the four fields, and
none of them is read by anything that deletes**: the in-process `audit_log` tick is gone
(`audit_log` is a governance record, see "PostgreSQL" above). The daily host purge
(`gremion-purge.timer`, `purge-run`) applies the database windows of
`PURGE_RULES`: the plumbing tables `event_consumption` and `scheduled_notifications` (7 d) and `plt.job_run` (29 d) and records one outcome row in
`plt.job_run`. The values are configuration and Löschkonzept text; the Settings tab and the
generated Löschkonzept say so. The edge files are bounded independently of these
values (see "Upper bound"); container stdout stays size-bounded only (see "Container
logs").

The Vector container receives `LOG_RETENTION_SECONDS` (derived from
`LOG_ACCESS_RETENTION_SECONDS`) and enforces it in the `enforce_retention`
transform. The `IPCRYPT_KEY_FILE` / `IPCRYPT_KEY_EPOCH` and `RAW_LOG_PATH` /
`PROCESSED_LOG_PATH` paths are configured on the `vector` service in
`docker-compose.yml`.

---

## GDPR Compliance Notes

- **Data minimisation (Art. 5(1)(c)):** client IPs are pseudonymised with
  ipcrypt-nd before any access-log record is persisted; raw IPs are never written.
  Query strings (which may carry codes/tokens) are redacted. Non-security request
  paths are dropped entirely.
- **Storage limitation (Art. 5(1)(e)):** access-log retention defaults to 14 days
  and is hard-capped at 29 days; the pseudonymised security and retained logs are
  held to at most 29 d 2 h 5 min and Keycloak login and admin events to 29 days
  (operator ceiling 30 d [D R29-I6]). Every window has a server-enforced upper
  bound. The application-level tiers carry the same ceiling (defaults 14 / 28 / 27 /
  27 d, caps 29 / 29 / 29 / 30 d); none of them is a purge in the application (see
  "Retention Configuration"; the `audit_log` table is a governance record, not one
  of the four tiers).
- **Integrity (Art. 5(1)(f) / hash chain):** the INV-1 governance audit log is
  append-only and is deleted by no timer (RC-GOV-CHAIN; see "PostgreSQL"; retention
  catalogue gap G6 is closed by the operator decision of 2026-10-28).
- **Breach notification:** in the event of a personal-data breach, the operator
  must notify the competent supervisory authority within 72 hours (GDPR Art. 33).

---

## Centralised Logging

The kernel's default deployment keeps logs on the host (Docker log driver + the
Vector pipeline volumes). Operators who ship logs to a central backend (e.g. Loki,
Elasticsearch) must configure retention at that backend to match — or be stricter
than — the windows above. Pseudonymisation happens before the processed log is
written, so a downstream collector receives already-pseudonymised access records.

**The operator's own log store (TASK-039).** The ops project
(`compose/observability/`) runs Loki with compactor retention ON (Loki's default
keeps every line for ever) and one stream per class of the retention catalogue
(section 4.1), each held under the 30-day ceiling [D R29-I6] in the worst case
(window + 24 h index period + 2 h delete delay + 10 min compaction interval):

| Loki stream | Window | Worst case | Fed by |
|---|---|---|---|
| `class="access"` | 14 days | 15 d 2 h 10 min | (reserved for TASK-033's access classes) |
| `class="security"` | 27 days | 28 d 2 h 10 min | Vector's `security.log`, read-only by Alloy |
| `class="finance"` | 27 days | 28 d 2 h 10 min | (reserved for the finance log, TASK-033) |
| `class="audit"` | 27 days | 28 d 2 h 10 min | Grafana's own request log (the operator-access record) |
| `class="application"` | 28 days [A] | 29 d 2 h 10 min | OTLP logs pushed to the ops ingest (TASK-116) |
| no class | 14 days | 15 d 2 h 10 min | anything else |

Traces (Tempo) are kept 7 days (RC-LOG-TRC), metrics (Prometheus) 27 days:
Prometheus deletes whole blocks only, a block spans up to 10 % of the window and
the deletion follows the 2-hourly compaction, so the oldest sample is at most
29 d 19 h old. `compose/observability/retention.test.mjs` fails on any window whose worst
case passes 30 days. Container stdout of the council services is not shipped
(no ops service may read the Docker data root), so the `json-file` residual above
is unchanged.

---

For the kernel's compliance posture more broadly, see
[compliance.md](./compliance.md) and [about-gremion.md](./about-gremion.md).
