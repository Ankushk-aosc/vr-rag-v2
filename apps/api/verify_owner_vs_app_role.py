import psycopg

import os as _os


def _require_env(name: str) -> str:
    """Connection strings come from the environment only; nothing secret lives in this file."""
    value = _os.environ.get(name)
    if not value:
        raise SystemExit(f"Set {name} (a PostgreSQL connection URL) in the environment.")
    return value


APP_URL = _require_env("APP_DB_URL")

def main():
    print("=" * 60)
    print("REQUIREMENT 5: VERIFY OWNER VS RUNTIME ROLE SEPARATION")
    print("=" * 60)

    with psycopg.connect(APP_URL, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT current_user, session_user;")
            u = cur.fetchone()
            print(f"[1] Connected as runtime user: {u[0]} (session: {u[1]})")

            cur.execute("SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = current_user;")
            role = cur.fetchone()
            print(f"    rolname: {role[0]}")
            print(f"    rolsuper: {role[1]}")
            print(f"    rolbypassrls: {role[2]}")
            assert role[1] is False, "Runtime role must not be superuser!"
            assert role[2] is False, "Runtime role must have NOBYPASSRLS!"

            print("\n[2] Checking table ownership in schema public:")
            cur.execute("""
                SELECT tablename, tableowner 
                FROM pg_tables 
                WHERE schemaname = 'public' AND tablename NOT IN ('spatial_ref_sys')
                ORDER BY tablename;
            """)
            tables = cur.fetchall()
            for t, owner in tables:
                print(f"    Table '{t}': owner = {owner}")
                assert owner == "vrrag_owner", f"Table {t} should be owned by vrrag_owner, but owned by {owner}!"
                assert owner != "vrrag_app", f"Table {t} must not be owned by runtime role vrrag_app!"

            print("\n[3] Testing ALTER / DISABLE RLS permission denial for runtime role:")
            # Test disabling RLS on documents
            try:
                cur.execute("ALTER TABLE documents DISABLE ROW LEVEL SECURITY;")
                raise AssertionError("CRITICAL SECURITY FLAW: Runtime role was able to DISABLE RLS on documents!")
            except psycopg.errors.InsufficientPrivilege as e:
                print("    --> Success! Attempt to disable RLS on documents rejected:")
                print(f"        {type(e).__name__}: {str(e).strip()}")

            # Test disabling RLS on conversations
            try:
                cur.execute("ALTER TABLE conversations DISABLE ROW LEVEL SECURITY;")
                raise AssertionError("CRITICAL SECURITY FLAW: Runtime role was able to DISABLE RLS on conversations!")
            except psycopg.errors.InsufficientPrivilege as e:
                print("    --> Success! Attempt to disable RLS on conversations rejected:")
                print(f"        {type(e).__name__}: {str(e).strip()}")

    print("\n" + "=" * 60)
    print("REQUIREMENT 5 VERIFIED: RUNTIME ROLE DOES NOT OWN TABLES AND CANNOT ALTER/DISABLE RLS")
    print("=" * 60)

if __name__ == "__main__":
    main()
