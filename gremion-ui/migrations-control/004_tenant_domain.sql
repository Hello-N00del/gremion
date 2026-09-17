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

-- ── Data migration (§1.2) — NOT PORTED ─────────────────────────────────
--
-- The extraction source paired this DDL with an issuer-derived back-fill: one
-- INSERT ... SELECT that seeded each surviving tenant's primary host from the
-- authority inside its own `tenant.issuer`. Spec B §T.1 DROPS it on port, so
-- the kernel copy is DDL only.
--
-- Why: under zero-tenant boot there is nothing to back-fill —
-- runControlMigrations() runs before any `tenant` row exists — and keeping the
-- statement would preserve the AUTH_KEYCLOAK_ISSUER -> primary-host derivation
-- that B12-zero-tenant-boot deletes. A kernel-sourced fresh install therefore
-- gets the table, both indexes and NO rows; a host becomes resolvable only
-- when it is registered explicitly (registry.addTenantDomain, and
-- registerDefaultTenant for the default tenant — see register-default.ts).
--
-- The dropped statement's own rationale is not reproduced here: it argued
-- against an even earlier revision that hardcoded one deployment's literal
-- hostnames, and those literals are retired names that must not ship in the
-- kernel. Per-file provenance: docs/ops/migration-portback-2026-09-15.md.
