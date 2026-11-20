import uuid
import psycopg
from psycopg.rows import dict_row

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
    print("REQUIREMENT 4: POSTGRESQL WRITE-ISOLATION TESTS (WITH CHECK)")
    print("=" * 60)

    fam_a = f"tenant_a_{uuid.uuid4().hex[:8]}"
    fam_b = f"tenant_b_{uuid.uuid4().hex[:8]}"
    user_a = str(uuid.uuid4())
    user_b = str(uuid.uuid4())
    doc_b_id = str(uuid.uuid4())
    conv_b_id = str(uuid.uuid4())

    # Pre-seed tenants and Tenant B baseline rows using bypass context
    with psycopg.connect(APP_URL, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT set_config('app.rls_bypass', 'on', false);")
            cur.execute("""
                INSERT INTO users (id, email, hashed_password, full_name)
                VALUES (%s, %s, 'hash', 'User A'), (%s, %s, 'hash', 'User B');
            """, (user_a, f"{fam_a}@example.com", user_b, f"{fam_b}@example.com"))

            cur.execute("""
                INSERT INTO family_entities (id, name, entity_type)
                VALUES (%s, 'Alpha Office', 'Trust'), (%s, 'Beta Office', 'Trust');
            """, (fam_a, fam_b))

            cur.execute("""
                INSERT INTO documents (id, filename, original_name, mime_type, file_size, file_hash, total_pages, family_entity_id, status)
                VALUES (%s, 'b_original.pdf', 'B Original.pdf', 'application/pdf', 500, %s, 1, %s, 'indexed');
            """, (doc_b_id, f"hash_{doc_b_id}", fam_b))

            cur.execute("""
                INSERT INTO conversations (id, tenant_id, user_id, title)
                VALUES (%s, %s, %s, 'Tenant B Secret Portfolio');
            """, (conv_b_id, fam_b, user_b))
            cur.execute("SELECT set_config('app.rls_bypass', 'off', false);")

    # Open connection scoped strictly to Tenant A
    with psycopg.connect(APP_URL, autocommit=False) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT set_config('app.current_family_ids', %s, true);", (fam_a,))

            # 1. Test INSERT cross-tenant into documents
            print("\n[1] Testing Tenant A INSERT into documents with family_entity_id = Tenant B:")
            try:
                cur.execute("""
                    INSERT INTO documents (id, filename, original_name, mime_type, file_size, file_hash, total_pages, family_entity_id, status)
                    VALUES (%s, 'malicious.pdf', 'malicious.pdf', 'application/pdf', 10, %s, 1, %s, 'indexed');
                """, (str(uuid.uuid4()), f"hash_{uuid.uuid4().hex}", fam_b))
                conn.commit()
                raise AssertionError("CRITICAL LEAK: Tenant A was able to INSERT into Tenant B documents!")
            except psycopg.errors.InsufficientPrivilege as e:
                conn.rollback()
                print("    --> Success! INSERT rejected by RLS WITH CHECK:")
                print(f"        {type(e).__name__}: {str(e).strip()}")

            # 2. Test INSERT cross-tenant into conversations
            print("\n[2] Testing Tenant A INSERT into conversations with tenant_id = Tenant B:")
            try:
                cur.execute("SELECT set_config('app.current_family_ids', %s, true);", (fam_a,))
                cur.execute("""
                    INSERT INTO conversations (id, tenant_id, user_id, title)
                    VALUES (%s, %s, %s, 'Injected Conversation');
                """, (str(uuid.uuid4()), fam_b, user_a))
                conn.commit()
                raise AssertionError("CRITICAL LEAK: Tenant A was able to INSERT into Tenant B conversations!")
            except psycopg.errors.InsufficientPrivilege as e:
                conn.rollback()
                print("    --> Success! INSERT rejected by RLS WITH CHECK:")
                print(f"        {type(e).__name__}: {str(e).strip()}")

            # 3. Test INSERT cross-tenant into messages referencing Tenant B conversation
            print("\n[3] Testing Tenant A INSERT into messages referencing Tenant B conversation:")
            try:
                cur.execute("SELECT set_config('app.current_family_ids', %s, true);", (fam_a,))
                cur.execute("""
                    INSERT INTO messages (id, conversation_id, role, content)
                    VALUES (%s, %s, 'user', 'Injected into B message history');
                """, (str(uuid.uuid4()), conv_b_id))
                conn.commit()
                raise AssertionError("CRITICAL LEAK: Tenant A was able to INSERT message into Tenant B conversation!")
            except psycopg.errors.InsufficientPrivilege as e:
                conn.rollback()
                print("    --> Success! INSERT rejected by RLS WITH CHECK:")
                print(f"        {type(e).__name__}: {str(e).strip()}")

            # 4. Test UPDATE cross-tenant on documents
            print("\n[4] Testing Tenant A UPDATE on Tenant B document:")
            cur.execute("SELECT set_config('app.current_family_ids', %s, true);", (fam_a,))
            cur.execute("UPDATE documents SET filename = 'tampered.pdf' WHERE id = %s;", (doc_b_id,))
            updated_count = cur.rowcount
            conn.commit()
            print(f"    Rows updated by Tenant A on Tenant B document: {updated_count}")
            assert updated_count == 0, f"CRITICAL LEAK: Tenant A was able to UPDATE {updated_count} rows of Tenant B!"
            print("    --> Success! 0 rows updated (Tenant B document completely invisible and protected).")

            # 5. Test DELETE cross-tenant on documents
            print("\n[5] Testing Tenant A DELETE on Tenant B document:")
            cur.execute("SELECT set_config('app.current_family_ids', %s, true);", (fam_a,))
            cur.execute("DELETE FROM documents WHERE id = %s;", (doc_b_id,))
            deleted_count = cur.rowcount
            conn.commit()
            print(f"    Rows deleted by Tenant A on Tenant B document: {deleted_count}")
            assert deleted_count == 0, f"CRITICAL LEAK: Tenant A was able to DELETE {deleted_count} rows of Tenant B!"
            print("    --> Success! 0 rows deleted (Tenant B document completely invisible and protected).")

    print("\n" + "=" * 60)
    print("REQUIREMENT 4 VERIFIED: WRITE-ISOLATION ENFORCED (WITH CHECK)")
    print("=" * 60)

if __name__ == "__main__":
    main()
