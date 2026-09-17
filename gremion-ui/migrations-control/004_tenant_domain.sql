-- migrations-control/004_tenant_domain.sql
-- Tenancy D1 (design spec §1.2) — per-tenant CUSTOM DOMAIN registry.
--
-- Tenancy was subdomain-shaped end to end: resolve.ts:extractLeftmostLabel read
-- the edge-forwarded host, hard-required >=3 labels and used the LEFTMOST label
-- as the tenant slug. That model cannot carry a tenant-owned domain — an apex
-- (`rat-musterstadt.de`, 2 labels) 404s, and a 3-label foreign host
-- (`www.rat-musterstadt.de`) is worse: `www` parses as a SLUG, so any foreign
-- host whose leftmost label equals a real slug CROSS-SELECTS that tenant.
--
-- Host lookup needs an index and a uniqueness guarantee, so this is a TABLE and
-- not a `domain_profile` JSON key:
--   * `host` is the PRIMARY KEY, so a hostname belongs to exactly ONE tenant —
--     host takeover is structurally impossible rather than guarded in JS.
--   * `is_primary` is the host used to mint the issuer and every
--     self-referential URL; the partial unique index enforces exactly one per
--     tenant (see registry.setPrimaryDomain, which clears-then-sets in ONE
--     transaction so the index is never transiently violated).
--   * the CHECK mirrors host.ts:normaliseHost — an already-lowercased host with
--     no whitespace and no comma, so a multi-value `X-Forwarded-Host` list
--     ('client-value, edge-value') can never become a resolvable row.
-- Inverse: DROP TABLE tenant_domain;

CREATE TABLE tenant_domain (
  host        text PRIMARY KEY CHECK (host = lower(host) AND host !~ '[[:space:],]'),
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  is_primary  boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX tenant_domain_one_primary ON tenant_domain (tenant_id) WHERE is_primary;
CREATE INDEX tenant_domain_tenant ON tenant_domain (tenant_id);

-- ── Data migration (§1.2) — DERIVED, never hardcoded ────────────────────────
--
-- Same transaction as the DDL (applyMigrationFile wraps the whole file in ONE
-- sql.begin, G-078).
--
-- Seed each surviving tenant's primary host from THE HOST INSIDE ITS OWN
-- `tenant.issuer`. An earlier revision listed literal hostnames
-- ('sturaos.com', 'demo.sturaos.com', 'musterstadt.sturaos.com', …) joined on
-- `slug`. That was wrong twice over:
--
--   1. It only described sturaos.com. Because it joined on SLUG, another
--      deployment did not merely get zero rows — it got sturaos.com rows
--      attached to ITS tenants (every deployment has a `default` slug;
--      register-default.ts hardcodes it). Measured on a `gremion.example.org`
--      registry: the seed wrote `default -> sturaos.com (primary)` and
--      `default.sturaos.com`, while `gremion.example.org` — the host
--      docker-compose.yml's gremion-ui healthcheck probes as `${DOMAIN}` — got
--      no row at all. The probe 404s against the fail-closed resolver, three
--      failures mark the container UNHEALTHY, and Traefik v3 SILENTLY DROPS an
--      unhealthy container's routers: total edge blackout, empty Traefik log.
--   2. The literals could CONTRADICT `tenant.issuer`, and nothing reconciles the
--      two for a non-default tenant. `iss-match.ts:assertIssMatch` is
--      BYTE-STRICT, so a tenant whose primary host disagreed with its issuer
--      host would mint an issuer (realm-doc.ts:issuerForTenant,
--      `https://<primary-host>/auth/realms/<realm>`) that no longer equals the
--      `iss` Keycloak stamps — a silent, fail-closed 403 on every login. On the
--      live registry that was not hypothetical: `demo` and `musterstadt` both
--      carry `https://sturaos.com/auth/realms/<realm>`, NOT the
--      `<slug>.sturaos.com` the literals claimed, and neither subdomain has had
--      a public DNS record since the apex-only Cloudflare cutover.
--
-- Deriving from `issuer` fixes both: it is correct on ANY deployment, and it
-- makes `host == new URL(issuer).host` true BY CONSTRUCTION — exactly the
-- equality the byte-strict iss gate requires. `registerDefaultTenant` derives
-- the DEFAULT tenant's host from the same `AUTH_KEYCLOAK_ISSUER` it derives
-- that row's `issuer` from, so the two paths cannot drift apart either.
--
-- The extraction mirrors host.ts:normaliseHost, so no row is written that the
-- resolver could not match: authority of the URL, minus a numeric port suffix,
-- lowercased, and accepted only if it is an ASCII LDH hostname with 1..63-char
-- labels and <=253 chars total. An issuer that fails that (junk, IDN in raw
-- unicode, an IPv6 literal) yields NO row for that tenant rather than aborting
-- everyone's boot — fail closed for one tenant, not for the deployment.
--
-- Rules encoded below:
--   * `status = 'deleted'` tenants are EXCLUDED. `t2` is such a tombstone and
--     the §7.8 identifier-reuse defence requires its host to stay UNSERVABLE
--     forever. `suspended` IS seeded — a suspended tenant must still resolve so
--     it can be served the branded 503 instead of a 404.
--   * `host` is the PK, so when several tenants share one issuer host exactly
--     one can own it. DISTINCT ON + ORDER BY makes that winner DETERMINISTIC and
--     always `default`. This is load-bearing, not tidiness: `registerDefaultTenant`
--     re-derives the default tenant's host from env on EVERY boot and cannot
--     take a host another tenant owns (addTenantDomain refuses — one host, one
--     tenant), so a non-default winner would leave the DEFAULT tenant hostless
--     forever, which is the healthcheck blackout above.
--   * a tenant that loses the tie gets NO row and is therefore UNREACHABLE until
--     an operator registers a host for it (registry.addTenantDomain). Under D1
--     that is the honest state — it has no domain of its own, and this branch
--     deletes the wildcard `HostRegexp` legs it used to ride in on. Seeding a
--     fabricated `<slug>.<apex>` would instead record an unreachable name as
--     that tenant's canonical identity and mint issuers from it.
--   * ON CONFLICT DO NOTHING makes a re-run a no-op.
--
-- On a FRESH control DB this whole statement is a deliberate no-op: boot order
-- is runControlMigrations() -> registerDefaultTenant(), so there are no `tenant`
-- rows yet. registerDefaultTenant() closes that gap by upserting the default
-- tenant's primary host from `AUTH_KEYCLOAK_ISSUER` right after it upserts the
-- row itself — see register-default.ts.
--
-- PORT-BACK (B4, 2026-09-15): the statement this paragraph describes — the
-- issuer-derived back-fill INSERT at the StuRa source's :104-119 — is DROPPED
-- in the kernel copy per spec B §T.1. Under zero-tenant boot there is nothing
-- to back-fill, and keeping it would preserve the AUTH_KEYCLOAK_ISSUER ->
-- primary-host derivation that B12-zero-tenant-boot deletes.
