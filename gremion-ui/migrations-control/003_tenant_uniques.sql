-- migrations-control/003_tenant_uniques.sql
-- P2.1c (T7) — registry-write hardening. Close the same-realm cache-collision
-- seam BEFORE any registry-WRITE surface (the provisioner) exists: a second
-- tenant must not be able to claim an already-registered realm_name or issuer
-- (KC realm cache + JWKS/issuer resolution are keyed on these). The 001 schema
-- gave `slug` a UNIQUE but neither `realm_name` nor `issuer` (001:13-14).
-- Inverse: ALTER TABLE tenant DROP CONSTRAINT tenant_issuer_key;
--          ALTER TABLE tenant DROP CONSTRAINT tenant_realm_name_key;

ALTER TABLE tenant ADD CONSTRAINT tenant_realm_name_key UNIQUE (realm_name);
ALTER TABLE tenant ADD CONSTRAINT tenant_issuer_key UNIQUE (issuer);
