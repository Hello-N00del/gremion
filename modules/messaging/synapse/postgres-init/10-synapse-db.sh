#!/bin/bash
# messaging-postgres, first initialisation only (docker-entrypoint-initdb.d):
# the Synapse role and database (TASK-198; Q4 default).
#
# Synapse requires a database whose collation and ctype are C ("Using
# Postgres" in its docs): anything else sorts room and event ids differently
# and IncorrectDatabaseSetup stops it -- but only once it has started. So the
# database is created here, per database, with LOCALE 'C' from template0 (the
# cluster's own locale is left alone), and db-preflight.py re-checks it on
# every boot. The owner is a plain role (BSI APP.4.3): LOGIN, never superuser,
# never CREATEDB or CREATEROLE.
#
# The password travels as a psql variable into format(... %L) -- never
# spliced into SQL text by the shell (the same idiom as the kernel's
# init-databases.sh). An unset or empty SYNAPSE_DB_PASSWORD aborts the
# initialisation, and the image then refuses to finish initdb, loudly.
set -euo pipefail

: "${SYNAPSE_DB_PASSWORD:?SYNAPSE_DB_PASSWORD is required to create the synapse role}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"

echo "[10-synapse-db] Creating role 'synapse' and database 'synapse' (LOCALE C, template0)..."

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
     -v _password="$SYNAPSE_DB_PASSWORD" <<-'SQL'
	SELECT format('CREATE ROLE synapse LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'_password') \gexec
	CREATE DATABASE synapse OWNER synapse TEMPLATE template0 ENCODING 'UTF8' LOCALE 'C';
SQL

echo "[10-synapse-db] Done: 'synapse' owned by 'synapse', datcollate/datctype C."
