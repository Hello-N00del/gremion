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

---

## Architecture

```
 Traefik (edge, production)
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
   └─ logrotate loop    (rotates + compresses + ages out the files)
```

Source: `docker/vector/` (`process-logs.sh`, `vector.toml`, `logrotate.conf`,
`entrypoint.sh`). The Vector service runs in every deployment that runs Traefik
(the production profile); local dev exposes services on direct ports and has no
Traefik access log to process.

---

## Per-Service Retention

### Container logs (all services)

| Data | Retention | Deletion mechanism |
|------|-----------|-------------------|
| stdout/stderr application logs (postgres, keycloak, gremion-ui, gremion-public, legal, vector, mailpit, traefik) | Bounded by the log driver | Docker `json-file` driver with `max-size: 50m`, `max-file: 5` on every service in `docker-compose.yml` — old chunks are rotated out automatically |

Application logs are operational, not audit records. The kernel does not log full
client IP addresses in application stdout; auth-related errors log user/tenant
identifiers only.

---

### Traefik access logs (production)

| Data | Retention | Deletion mechanism |
|------|-----------|-------------------|
| Raw JSON access log (`/logs/traefik/access.log`, contains `ClientHost`) | 14 days on disk | `logrotate.conf` rule: `daily`, `maxage 14`, `rotate 14`, `compress`, `copytruncate`. Vector only **tails** this file; it is rotated in place so the writing process keeps the same FD |
| Pseudonymised security log (`/logs/processed/security.log`) | 31 days on disk | `logrotate.conf` rule: `daily`, `maxage 31`, `rotate 31`, `compress`, `copytruncate` |
| Date-partitioned retention sink (`/logs/processed/retained-YYYY-MM-DD.log`) | `LOG_RETENTION_SECONDS` (Vector filter) + 31-day disk cap | Vector's `enforce_retention` transform drops events older than `LOG_RETENTION_SECONDS`; logrotate ages out the per-day files (`maxage 31`) |

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
| Application logs | Bounded by the log driver | Ephemeral stdout, rotated by the Docker `json-file` driver |
| Login/auth events (`EVENT_ENTITY`, may store login IP) | 90 days | `eventsExpiration: 7776000` in `docker/keycloak/realm-export.json` — Keycloak purges expired events automatically |
| Admin/audit events (`ADMIN_EVENT_ENTITY`) | 90 days | Same `eventsExpiration` setting (`adminEventsEnabled: true`) |
| User sessions | `ssoSessionIdleTimeout: 7200s` / `ssoSessionMaxLifespan: 86400s` | Keycloak expires idle and over-age sessions automatically; Auth.js cookies in gremion-ui expire with the session |

---

### PostgreSQL

| Data | Retention | Deletion mechanism |
|------|-----------|-------------------|
| Query logs | Not enabled | `log_statement = 'none'` (PostgreSQL default) — statements are not logged |
| Governance domain data (committees, members, org-units, protocols, resolutions) | Until operator deletion | No automatic data expiry; operator-initiated deletion through the admin shell |
| INV-1 audit log (hash-chained governance audit trail) | Retained by design | The hash-chained audit log is an integrity record, not a rotating log; it is **not** auto-expired. Deleting entries would break the chain |

The INV-1 audit log records governance actions (who decided what, under which
quorum/decision rule). It is intentionally append-only and is excluded from the
time-based deletion policy above; treat its retention as governed by the operator's
records-management obligations, not by this security-logging policy.

---

## Retention Configuration

Retention windows are set in `.env` (see `.env.example`, "Hardening" section).
Values are in seconds (days × 86400) and are bounded by server-side hard caps:

| Variable | Default | Hard cap |
|----------|---------|----------|
| `LOG_ACCESS_RETENTION_SECONDS` | 14 days (1209600) | 30 days (2592000) |
| `LOG_APP_RETENTION_SECONDS` | 30 days (2592000) | 90 days (7776000) |
| `LOG_SECURITY_RETENTION_SECONDS` | 90 days (7776000) | 180 days (15552000) |
| `LOG_SECURITY_NOPII_RETENTION_SECONDS` | 90 days (7776000) | 365 days (31536000) |

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
  and is hard-capped at 30 days; Keycloak event retention is 90 days. Every window
  has a server-enforced upper bound.
- **Integrity (Art. 5(1)(f) / hash chain):** the INV-1 governance audit log is
  append-only and excluded from automated deletion by design.
- **Breach notification:** in the event of a personal-data breach, the operator
  must notify the competent supervisory authority within 72 hours (GDPR Art. 33).

---

## Centralised Logging

The kernel's default deployment keeps logs on the host (Docker log driver + the
Vector pipeline volumes). Operators who ship logs to a central backend (e.g. Loki,
Elasticsearch) must configure retention at that backend to match — or be stricter
than — the windows above. Pseudonymisation happens before the processed log is
written, so a downstream collector receives already-pseudonymised access records.

---

For the kernel's compliance posture more broadly, see
[compliance.md](./compliance.md) and [about-gremion.md](./about-gremion.md).
