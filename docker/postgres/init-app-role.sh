#!/bin/sh
# Runs once, when the postgres volume is first initialised (Audit I-17).
# The API must not connect as POSTGRES_USER: superusers and BYPASSRLS roles ignore row-level security,
# and the API refuses to start against such a role outside development (Audit I-16).
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v app_user="$APP_DB_USER" -v app_password="$APP_DB_PASSWORD" -v app_db="$APP_DB_NAME" <<'SQL'
CREATE ROLE :"app_user" LOGIN PASSWORD :'app_password' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE DATABASE :"app_db" OWNER :"app_user";
SQL
