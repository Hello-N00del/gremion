-- migrations-control/002_tenant_migration_runs.sql
-- P2.1b — fleet-run ledger (plan T1, D-FLEET). The boot data-plane migration
-- step becomes a FLEET run over ACTIVE registry tenants; the runner (T2)
-- records each tenant's per-run outcome here so one tenant's failure never
-- blocks the fleet (per-tenant readiness instead, D-READY).
-- Inverse: DROP TABLE tenant_migration_run;

CREATE TABLE tenant_migration_run (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  ok           boolean,
  error        text,
  last_applied text
);

CREATE INDEX tenant_migration_run_tenant_started_idx
  ON tenant_migration_run (tenant_id, started_at DESC);
