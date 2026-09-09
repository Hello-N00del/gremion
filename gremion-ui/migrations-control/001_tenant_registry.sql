-- migrations-control/001_tenant_registry.sql
-- P2.1a — Tenant Registry (control plane, spec §3.1). Lives in the dedicated
-- `control` database, NOT in any tenant data-plane. The CHECK + UNIQUE enforce
-- ^[a-z0-9-]{1,30}$ at the store (mirrored in slug.ts).
-- Inverse: DROP TABLE tenant_provisioning_resource; DROP TABLE tenant;

CREATE TABLE tenant (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{1,30}$'),
  status         text NOT NULL
                   CHECK (status IN ('provisioning','active','suspended','deleting','deleted')),
  db_conn_ref    text NOT NULL,
  realm_name     text NOT NULL,
  issuer         text NOT NULL,
  kc_internal    text NOT NULL,
  kc_client_id   text NOT NULL,            -- the ADMIN client id (gremion-admin)
  kc_client_ref  text NOT NULL,            -- the ADMIN client secret ref (KeycloakAdminClient)
  auth_client_ref text NOT NULL,           -- the UI client secret ref (Auth.js provider; MJ-secret). UI client id is fixed 'gremion-ui'.
  nc_target      jsonb NOT NULL,
  matrix_space   jsonb NOT NULL,
  domain_profile jsonb NOT NULL,
  brand_ref      text NOT NULL,
  blueprint_ref  text NOT NULL,
  conn_profile   jsonb NOT NULL,
  backup_key_ref text NOT NULL,
  audiences      text[] NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_provisioning_resource (
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  subsystem   text NOT NULL CHECK (subsystem IN ('db','realm','nextcloud','matrix')),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ok','failed')),
  external_id text,
  attempts    int NOT NULL DEFAULT 0,
  last_error  text,
  synced_at   timestamptz,
  PRIMARY KEY (tenant_id, subsystem)
);
