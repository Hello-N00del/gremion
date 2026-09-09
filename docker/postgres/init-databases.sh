#!/bin/bash
# Runs once on first PostgreSQL initialization (docker-entrypoint-initdb.d).
# Creates databases and users for Keycloak, the governance kernel (gremion),
# the control-plane registry, and the read-only public portal reader.
# Environment variables are injected by docker-compose.
#
# IMPORTANT: An equivalent copy of this logic exists inline in
# k8s/base/postgres/configmap.yaml (used by the K8s StatefulSet init
# container). Both implementations are intentionally separate because
# they run in different contexts (Docker vs Kubernetes). Any change to
# the SQL logic here must be mirrored in the ConfigMap, and vice versa.

set -eu

create_db_and_user() {
    local db="$1"
    local user="$2"
    local password="$3"

    echo "[init-databases] Creating user '${user}' and database '${db}'..."

    # Use psql variable substitution (-v) with format() %I/%L to prevent SQL injection.
    # Single-quoted heredoc (<<-'SQL') stops the shell from expanding psql variables.
    # :'_user' = psql string literal substitution; :"_user" = identifier substitution.
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" \
         -v _user="$user" -v _password="$password" -v _db="$db" <<-'SQL'
        -- Create user only if it does not already exist
        SELECT CASE
            WHEN NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'_user')
            THEN format('CREATE USER %I WITH PASSWORD %L', :'_user', :'_password')
            ELSE 'SELECT 1'
        END \gexec

        -- Create database only if it does not already exist
        SELECT format('CREATE DATABASE %I OWNER %I', :'_db', :'_user')
        WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'_db') \gexec

        SELECT format('GRANT ALL PRIVILEGES ON DATABASE %I TO %I', :'_db', :'_user') \gexec
SQL

    # PostgreSQL 15+ requires explicit schema grant
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" \
         -v _user="$user" <<-'SQL'
        SELECT format('GRANT ALL ON SCHEMA public TO %I', :'_user') \gexec
SQL

    echo "[init-databases] Done: '${db}' owned by '${user}'."
}

create_db_and_user \
    "${KEYCLOAK_DB_NAME:-keycloak}" \
    "${KEYCLOAK_DB_USER:-keycloak}" \
    "${KEYCLOAK_DB_PASSWORD}"

create_db_and_user \
    "${GREMION_DB_NAME:-gremion}" \
    "${GREMION_DB_USER:-gremion}" \
    "${GREMION_DB_PASSWORD}"

# P2.1c T1 (#202): control-plane registry database — tenant registry +
# fleet-migration ledger (gremion-ui/migrations-control/). Deliberately a
# separate database AND role from the per-tenant data plane (Pillar-2
# silo model); gremion-ui reaches it via CONTROL_DATABASE_URL, always
# DIRECTLY at postgres:5432 (D-CONTROLDIRECT — never through the
# production PgBouncer overlay).
create_db_and_user \
    "${CONTROL_DB_NAME:-control}" \
    "${CONTROL_DB_USER:-control}" \
    "${CONTROL_DB_PASSWORD}"

# Create the gremion_public_reader read-only role for gremion-public (b5).
# Owned by postgres superuser; migration 008 later grants SELECTs on
# app tables once they exist. Done here because the gremion user that
# runs migrations lacks CREATEROLE.
if [ -n "${PUBLIC_DB_PASSWORD:-}" ]; then
    echo "[init-databases] Creating gremion_public_reader role..."
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" \
         -v _password="$PUBLIC_DB_PASSWORD" <<-'SQL'
        SELECT CASE
            WHEN NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gremion_public_reader')
            THEN format('CREATE ROLE gremion_public_reader LOGIN PASSWORD %L', :'_password')
            ELSE format('ALTER ROLE gremion_public_reader WITH PASSWORD %L', :'_password')
        END \gexec
SQL
    echo "[init-databases] Done: gremion_public_reader."
else
    echo "[init-databases] PUBLIC_DB_PASSWORD not set — skipping gremion_public_reader role."
fi

echo "[init-databases] All databases initialized."
