"""
Create the non-superuser application role and database on an existing PostgreSQL server, install
pgvector, and print the role's security properties. Credentials come only from the environment.

    POSTGRES_ADMIN_URL=postgresql://postgres:<admin-password>@localhost:5432/postgres \
    APP_DB_PASSWORD=<app-password> python setup_pg.py [--reset]

--reset drops an existing database/role of the same name first (destroys its data).
"""
import argparse
import os
import sys

import psycopg
from psycopg import sql


def setup(reset: bool) -> None:
    admin_url = os.environ.get("POSTGRES_ADMIN_URL")
    app_password = os.environ.get("APP_DB_PASSWORD")
    app_user = os.environ.get("APP_DB_USER", "vrrag_app")
    app_db = os.environ.get("APP_DB_NAME", "vr_rag")
    if not admin_url or not app_password:
        sys.exit("Set POSTGRES_ADMIN_URL and APP_DB_PASSWORD in the environment.")

    with psycopg.connect(admin_url, autocommit=True) as conn:
        cur = conn.cursor()
        if reset:
            cur.execute(sql.SQL("DROP DATABASE IF EXISTS {}").format(sql.Identifier(app_db)))
            cur.execute(sql.SQL("DROP ROLE IF EXISTS {}").format(sql.Identifier(app_user)))
        cur.execute(
            sql.SQL("CREATE ROLE {} LOGIN PASSWORD {} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE").format(
                sql.Identifier(app_user), sql.Literal(app_password)
            )
        )
        cur.execute(sql.SQL("CREATE DATABASE {} OWNER {}").format(sql.Identifier(app_db), sql.Identifier(app_user)))
        cur.execute(
            "SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = %s", (app_user,)
        )
        name, is_super, bypass_rls, can_login = cur.fetchone()
        print(f"Created role {name} and database {app_db}.")
        print(f"  superuser={is_super} bypassrls={bypass_rls} login={can_login}")

    # pgvector must be installed by a superuser, inside the application database
    db_url = admin_url.rsplit("/", 1)[0] + "/" + app_db
    with psycopg.connect(db_url, autocommit=True) as conn:
        conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
        version = conn.execute("SELECT extversion FROM pg_extension WHERE extname = 'vector'").fetchone()[0]
        print(f"  pgvector {version} installed in {app_db}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--reset", action="store_true", help="Drop an existing database and role first")
    setup(parser.parse_args().reset)
