import os
import subprocess
import psycopg

import os as _os


def _require_env(name: str) -> str:
    """Connection strings come from the environment only; nothing secret lives in this file."""
    value = _os.environ.get(name)
    if not value:
        raise SystemExit(f"Set {name} (a PostgreSQL connection URL) in the environment.")
    return value


ADMIN_CONN_STR = _require_env("POSTGRES_ADMIN_URL")
OWNER_URL = _require_env("MIGRATION_DB_URL").replace("postgresql://", "postgresql+psycopg://", 1)
OWNER_CONN_STR = _require_env("MIGRATION_DB_URL")

def main():
    print("=== STEP 1: DROPPING AND RECREATING SCHEMA PUBLIC ===")
    with psycopg.connect(ADMIN_CONN_STR, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute("DROP SCHEMA IF EXISTS public CASCADE;")
            cur.execute("CREATE SCHEMA public;")
            cur.execute("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;")
            cur.execute("GRANT ALL ON SCHEMA public TO vrrag_owner;")
            cur.execute("GRANT USAGE ON SCHEMA public TO vrrag_app;")
            cur.execute("ALTER DEFAULT PRIVILEGES FOR ROLE vrrag_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vrrag_app;")
            cur.execute("ALTER DEFAULT PRIVILEGES FOR ROLE vrrag_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO vrrag_app;")
            print("Schema public dropped and recreated cleanly with vector extension enabled.")

    env = os.environ.copy()
    env["DATABASE_URL"] = OWNER_URL

    print("\n=== STEP 2: RUNNING ALEMBIC UPGRADE HEAD FROM EMPTY ===")
    res_up1 = subprocess.run(["python", "-m", "alembic", "upgrade", "head"], cwd="apps/api", env=env, capture_output=True, text=True)
    print("STDOUT:\n" + res_up1.stdout)
    print("STDERR:\n" + res_up1.stderr)
    print("RETURNCODE:", res_up1.returncode)
    assert res_up1.returncode == 0, "Upgrade head failed!"

    print("\n=== STEP 3: RUNNING ALEMBIC DOWNGRADE -1 ===")
    res_down = subprocess.run(["python", "-m", "alembic", "downgrade", "-1"], cwd="apps/api", env=env, capture_output=True, text=True)
    print("STDOUT:\n" + res_down.stdout)
    print("STDERR:\n" + res_down.stderr)
    print("RETURNCODE:", res_down.returncode)
    assert res_down.returncode == 0, "Downgrade -1 failed!"

    print("\n=== STEP 4: RUNNING ALEMBIC UPGRADE HEAD (RE-APPLY 007) ===")
    res_up2 = subprocess.run(["python", "-m", "alembic", "upgrade", "head"], cwd="apps/api", env=env, capture_output=True, text=True)
    print("STDOUT:\n" + res_up2.stdout)
    print("STDERR:\n" + res_up2.stderr)
    print("RETURNCODE:", res_up2.returncode)
    assert res_up2.returncode == 0, "Final upgrade head failed!"

if __name__ == "__main__":
    main()
