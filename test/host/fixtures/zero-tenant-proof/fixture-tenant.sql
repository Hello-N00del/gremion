-- TASK-042 (TDD 12): the zero-tenant proof's fixture customer, bound by SQL
-- AFTER the zero-tenant assertions, for the "wizard unreachable" probes.
-- Run against the proof's scratch control database only. Its data plane is the
-- app's own DATABASE_URL (env ref), which no unauthenticated probe reaches.
BEGIN;
INSERT INTO tenant (
  slug, status, db_conn_ref, realm_name, issuer, kc_internal, kc_client_id,
  kc_client_ref, auth_client_ref, nc_target, matrix_space, domain_profile,
  brand_ref, blueprint_ref, conn_profile, backup_key_ref, audiences
) VALUES (
  'proof', 'active', 'env:DATABASE_URL', 't042-proof',
  'http://proof.t042.test/auth/realms/t042-proof',
  'http://keycloak:8080/auth/realms/t042-proof', 'gremion-admin',
  'env:KEYCLOAK_ADMIN_CLIENT_SECRET', 'env:AUTH_KEYCLOAK_SECRET',
  '{}', '{}', '{}', 'config:proof', 'STURA_BLUEPRINT@1',
  '{"perTenantMax": 2, "prepare": true}', 'env:AUTH_KEYCLOAK_SECRET',
  ARRAY['gremion-ui']
) ON CONFLICT (slug) DO NOTHING;
INSERT INTO tenant_domain (tenant_id, host, is_primary)
  SELECT id, 'proof.t042.test', true FROM tenant WHERE slug = 'proof'
  ON CONFLICT (host) DO NOTHING;
COMMIT;
