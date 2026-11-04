#!/bin/sh
# Runs once, when the postgres volume is first initialised (Audit I-17).
# Requirement 5: Separate migration/owner role from the runtime role.
# The runtime role (APP_DB_USER) does not own tables and cannot ALTER or DISABLE RLS.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner_user="${MIGRATION_DB_USER:-vrrag_owner}" \
  -v owner_password="${MIGRATION_DB_PASSWORD:?set MIGRATION_DB_PASSWORD}" \
  -v app_user="$APP_DB_USER" \
  -v app_password="$APP_DB_PASSWORD" \
  -v app_db="$APP_DB_NAME" <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
CREATE ROLE :"owner_user" LOGIN PASSWORD :'owner_password' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE :"app_user" LOGIN PASSWORD :'app_password' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE DATABASE :"app_db" OWNER :"owner_user";
\c :"app_db"
CREATE EXTENSION IF NOT EXISTS vector;
GRANT CONNECT ON DATABASE :"app_db" TO :"app_user";
GRANT USAGE ON SCHEMA public TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_user" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_user" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"app_user";
SQL
