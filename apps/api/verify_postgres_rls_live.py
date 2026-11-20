"""Live PostgreSQL RLS and Tenant Isolation Verification.

Proves:
1. Role vrrag_app is NOT superuser and has NOBYPASSRLS.
2. Documents, document_chunks, conversations, and messages have RLS enabled and forced.
3. With no tenant context set (empty app.current_family_ids), SELECT returns 0 rows.
4. Family A cannot read Family B's documents, chunks, or conversations.
5. Family B cannot read Family A's documents, chunks, or conversations.
"""
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


DB_URL = _require_env("APP_DB_URL")

def main():
    print("=" * 60)
    print("STARTING LIVE POSTGRESQL RLS VERIFICATION")
    print("=" * 60)

    # 1. Connect as vrrag_app
    with psycopg.connect(DB_URL, autocommit=True) as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            # Check role attributes
            cur.execute("SELECT current_user, session_user;")
            u = cur.fetchone()
            print(f"[1] Connected as: {u['current_user']} (session: {u['session_user']})")

            cur.execute("""
                SELECT rolname, rolsuper, rolbypassrls, rolcanlogin 
                FROM pg_roles 
                WHERE rolname = current_user;
            """)
            role_info = cur.fetchone()
            print(f"    Superuser: {role_info['rolsuper']}")
            print(f"    Bypass RLS: {role_info['rolbypassrls']}")
            assert role_info['rolsuper'] is False, "CRITICAL: app user must not be superuser!"
            assert role_info['rolbypassrls'] is False, "CRITICAL: app user must have NOBYPASSRLS!"

            # 2. Check RLS enabled on all tenant tables
            print("\n[2] Checking RLS status on tenant tables:")
            cur.execute("""
                SELECT relname, relrowsecurity, relforcerowsecurity 
                FROM pg_class 
                WHERE relname IN ('documents', 'document_chunks', 'conversations', 'messages', 'llm_usage')
                ORDER BY relname;
            """)
            tables = cur.fetchall()
            for t in tables:
                print(f"    Table '{t['relname']}': RLS enabled={t['relrowsecurity']}, RLS forced={t['relforcerowsecurity']}")
                assert t['relrowsecurity'] is True, f"RLS not enabled on {t['relname']}"
                assert t['relforcerowsecurity'] is True, f"RLS not forced on {t['relname']}"

            # 3. Seed test tenants and data
            fam_a = f"tenant_a_{uuid.uuid4().hex[:8]}"
            fam_b = f"tenant_b_{uuid.uuid4().hex[:8]}"
            user_a = str(uuid.uuid4())
            user_b = str(uuid.uuid4())

            print(f"\n[3] Seeding test tenants: {fam_a} and {fam_b}")
            # Insert users and families using session bypass context
            cur.execute("SELECT set_config('app.rls_bypass', 'on', false);")
            cur.execute("""
                INSERT INTO users (id, email, hashed_password, full_name)
                VALUES (%s, %s, 'hash', 'User A'), (%s, %s, 'hash', 'User B');
            """, (user_a, f"{fam_a}@example.com", user_b, f"{fam_b}@example.com"))

            cur.execute("""
                INSERT INTO family_entities (id, name, entity_type)
                VALUES (%s, 'Alpha Office', 'Trust'), (%s, 'Beta Office', 'Trust');
            """, (fam_a, fam_b))

            # Insert Documents & Chunks for Family A
            doc_a_id = str(uuid.uuid4())
            cur.execute("""
                INSERT INTO documents (id, filename, original_name, mime_type, file_size, file_hash, total_pages, family_entity_id, status)
                VALUES (%s, 'doc_a.pdf', 'Alpha Document.pdf', 'application/pdf', 100, %s, 1, %s, 'indexed');
            """, (doc_a_id, f"hash_{doc_a_id}", fam_a))

            cur.execute("""
                INSERT INTO document_chunks (id, document_id, chunk_index, page_number, content)
                VALUES (%s, %s, 0, 1, 'Alpha confidential dividend statements.');
            """, (f"{doc_a_id}_c0", doc_a_id))

            # Insert Documents & Chunks for Family B
            doc_b_id = str(uuid.uuid4())
            cur.execute("""
                INSERT INTO documents (id, filename, original_name, mime_type, file_size, file_hash, total_pages, family_entity_id, status)
                VALUES (%s, 'doc_b.pdf', 'Beta Document.pdf', 'application/pdf', 200, %s, 1, %s, 'indexed');
            """, (doc_b_id, f"hash_{doc_b_id}", fam_b))

            cur.execute("""
                INSERT INTO document_chunks (id, document_id, chunk_index, page_number, content)
                VALUES (%s, %s, 0, 1, 'Beta confidential trust holdings.');
            """, (f"{doc_b_id}_c0", doc_b_id))

            # Insert Conversations and Messages for Family A
            conv_a_id = str(uuid.uuid4())
            cur.execute("""
                INSERT INTO conversations (id, tenant_id, user_id, title)
                VALUES (%s, %s, %s, 'Alpha Family Tax Inquiry');
            """, (conv_a_id, fam_a, user_a))

            cur.execute("""
                INSERT INTO messages (id, conversation_id, role, content)
                VALUES (%s, %s, 'user', 'What are our distribution dates for Family A?');
            """, (str(uuid.uuid4()), conv_a_id))

            # Insert Conversations and Messages for Family B
            conv_b_id = str(uuid.uuid4())
            cur.execute("""
                INSERT INTO conversations (id, tenant_id, user_id, title)
                VALUES (%s, %s, %s, 'Beta Family Asset Allocation');
            """, (conv_b_id, fam_b, user_b))

            cur.execute("""
                INSERT INTO messages (id, conversation_id, role, content)
                VALUES (%s, %s, 'user', 'List all Family B offshore holdings.');
            """, (str(uuid.uuid4()), conv_b_id))

            # Reset bypass
            cur.execute("SELECT set_config('app.rls_bypass', 'off', false);")

    # 4. TEST: WITH NO TENANT CONTEXT SET, SELECT MUST RETURN 0 ROWS
    print("\n[4] Testing connection with NO tenant context set (fail-closed check):")
    with psycopg.connect(DB_URL) as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            # Query documents without WHERE clause
            cur.execute("SELECT count(*) as count FROM documents;")
            doc_count = cur.fetchone()['count']
            print(f"    SELECT count(*) FROM documents: {doc_count}")
            assert doc_count == 0, f"FAIL-CLOSED VIOLATION: documents returned {doc_count} rows with no tenant context!"

            # Query document_chunks without WHERE clause
            cur.execute("SELECT count(*) as count FROM document_chunks;")
            chunk_count = cur.fetchone()['count']
            print(f"    SELECT count(*) FROM document_chunks: {chunk_count}")
            assert chunk_count == 0, f"FAIL-CLOSED VIOLATION: document_chunks returned {chunk_count} rows with no tenant context!"

            # Query conversations without WHERE clause
            cur.execute("SELECT count(*) as count FROM conversations;")
            conv_count = cur.fetchone()['count']
            print(f"    SELECT count(*) FROM conversations: {conv_count}")
            assert conv_count == 0, f"FAIL-CLOSED VIOLATION: conversations returned {conv_count} rows with no tenant context!"

            # Query messages without WHERE clause
            cur.execute("SELECT count(*) as count FROM messages;")
            msg_count = cur.fetchone()['count']
            print(f"    SELECT count(*) FROM messages: {msg_count}")
            assert msg_count == 0, f"FAIL-CLOSED VIOLATION: messages returned {msg_count} rows with no tenant context!"
            print("    --> PASS: All queries returned 0 rows when tenant context is unset.")

    # 5. TEST: FAMILY A TENANT CONTEXT ISOLATION
    print(f"\n[5] Testing connection scoped to Family A ({fam_a}):")
    with psycopg.connect(DB_URL) as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute("SELECT set_config('app.current_family_ids', %s, true);", (fam_a,))

            # Query documents without WHERE clause
            cur.execute("SELECT id, family_entity_id, filename FROM documents;")
            docs = cur.fetchall()
            doc_ids = {d['id'] for d in docs}
            print(f"    Documents retrieved: {[d['filename'] for d in docs]}")
            assert doc_a_id in doc_ids, "Family A document missing!"
            assert doc_b_id not in doc_ids, "CRITICAL LEAK: Family B document returned to Family A!"

            # Query document_chunks without WHERE clause
            cur.execute("SELECT id, content FROM document_chunks;")
            chunks = cur.fetchall()
            chunk_ids = {c['id'] for c in chunks}
            print(f"    Chunks retrieved: {[c['id'] for c in chunks]}")
            assert f"{doc_a_id}_c0" in chunk_ids
            assert f"{doc_b_id}_c0" not in chunk_ids, "CRITICAL LEAK: Family B chunk returned to Family A!"

            # Query conversations without WHERE clause
            cur.execute("SELECT id, tenant_id, title FROM conversations;")
            convs = cur.fetchall()
            conv_ids = {c['id'] for c in convs}
            print(f"    Conversations retrieved: {[c['title'] for c in convs]}")
            assert conv_a_id in conv_ids, "Family A conversation missing!"
            assert conv_b_id not in conv_ids, "CRITICAL LEAK: Family B conversation returned to Family A!"

            # Query messages without WHERE clause
            cur.execute("SELECT id, conversation_id, content FROM messages;")
            msgs = cur.fetchall()
            msg_conv_ids = {m['conversation_id'] for m in msgs}
            print(f"    Messages retrieved: {[m['content'] for m in msgs]}")
            assert conv_a_id in msg_conv_ids
            assert conv_b_id not in msg_conv_ids, "CRITICAL LEAK: Family B message returned to Family A!"
            print("    --> PASS: Family A sees ONLY Family A data. Family B is completely invisible.")

    # 6. TEST: FAMILY B TENANT CONTEXT ISOLATION
    print(f"\n[6] Testing connection scoped to Family B ({fam_b}):")
    with psycopg.connect(DB_URL) as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute("SELECT set_config('app.current_family_ids', %s, true);", (fam_b,))

            cur.execute("SELECT id, filename FROM documents;")
            docs = cur.fetchall()
            doc_ids = {d['id'] for d in docs}
            print(f"    Documents retrieved: {[d['filename'] for d in docs]}")
            assert doc_b_id in doc_ids, "Family B document missing!"
            assert doc_a_id not in doc_ids, "CRITICAL LEAK: Family A document returned to Family B!"

            cur.execute("SELECT id FROM document_chunks;")
            chunks = cur.fetchall()
            chunk_ids = {c['id'] for c in chunks}
            print(f"    Chunks retrieved: {[c['id'] for c in chunks]}")
            assert f"{doc_b_id}_c0" in chunk_ids
            assert f"{doc_a_id}_c0" not in chunk_ids, "CRITICAL LEAK: Family A chunk returned to Family B!"

            cur.execute("SELECT id, title FROM conversations;")
            convs = cur.fetchall()
            conv_ids = {c['id'] for c in convs}
            print(f"    Conversations retrieved: {[c['title'] for c in convs]}")
            assert conv_b_id in conv_ids, "Family B conversation missing!"
            assert conv_a_id not in conv_ids, "CRITICAL LEAK: Family A conversation returned to Family B!"
            print("    --> PASS: Family B sees ONLY Family B data. Family A is completely invisible.")

    print("\n" + "=" * 60)
    print("ALL LIVE POSTGRESQL RLS & TENANT ISOLATION TESTS PASSED (100%)")
    print("=" * 60)

if __name__ == "__main__":
    main()
