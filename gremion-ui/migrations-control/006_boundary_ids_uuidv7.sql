-- migrations-control/006_boundary_ids_uuidv7.sql
-- TASK-019 (L3-04, D14) — boundary ids are RFC 9562 version-7 UUIDs.
--
-- The two control-plane ids that cross a service boundary (the tenant id the
-- registry hands to every leaf and to the tenant-store API; the fleet-run id
-- the ledger returns) switch from gen_random_uuid() (version 4, random) to
-- uuidv7() (version 7, time-ordered: 48-bit Unix-ms timestamp + random), so
-- new keys append to the primary-key index instead of scattering across it,
-- and an id carries its creation instant.
--
-- uuidv7() is built in from PostgreSQL 18 on. That is deliberate: the pinned
-- major is 18 (scripts/check-postgres-major.mjs), and this migration fails
-- loudly — "function uuidv7() does not exist" — on anything older rather than
-- letting a control plane run on a major the product does not ship.
--
-- Only the DEFAULT changes: existing rows keep their ids (a fresh install has
-- none; D14 re-initialises, there is no data to migrate) and uuid columns hold
-- either version. Number 005 is reserved for 005_tenant_evict_ack.sql (spec B
-- §T.5, B19b); this is the next free control number.
-- Inverse: ALTER TABLE tenant ALTER COLUMN id SET DEFAULT gen_random_uuid();
--          ALTER TABLE tenant_migration_run ALTER COLUMN id SET DEFAULT gen_random_uuid();

ALTER TABLE tenant ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE tenant_migration_run ALTER COLUMN id SET DEFAULT uuidv7();
