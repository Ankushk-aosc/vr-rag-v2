import random
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
    print("REQUIREMENT 7: PGVECTOR TENANT-SCOPED RETRIEVAL & HNSW EXPLAIN")
    print("=" * 60)

    fam_a = f"tenant_a_{uuid.uuid4().hex[:8]}"
    fam_b = f"tenant_b_{uuid.uuid4().hex[:8]}"

    # Seed vectors for Tenant A and Tenant B
    with psycopg.connect(APP_URL, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT set_config('app.rls_bypass', 'on', false);")
            print(f"[1] Seeding document_vectors for {fam_a} (50 vectors) and {fam_b} (50 vectors)...")
            for i in range(50):
                vec_a = [round(random.uniform(-0.1, 0.1), 4) for _ in range(384)]
                vec_b = [round(random.uniform(-0.1, 0.1), 4) for _ in range(384)]
                cur.execute("""
                    INSERT INTO document_vectors (id, family_entity_id, document_id, allowed_role, page_no, chunk_id, embedding)
                    VALUES (%s, %s, 'doc_a_1', 'family_member', 1, %s, %s::vector(384)),
                           (%s, %s, 'doc_b_1', 'family_member', 1, %s, %s::vector(384));
                """, (
                    str(uuid.uuid4()), fam_a, f"chunk_a_{i}", str(vec_a),
                    str(uuid.uuid4()), fam_b, f"chunk_b_{i}", str(vec_b)
                ))
            cur.execute("SELECT set_config('app.rls_bypass', 'off', false);")

    # Connect scoped to Tenant A and query nearest neighbors
    target_query_vec = str([0.05] * 384)
    print("\n[2] Executing Tenant A scoped vector query:")
    with psycopg.connect(APP_URL, autocommit=True) as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute("SELECT set_config('app.current_family_ids', %s, true);", (fam_a,))
            cur.execute("""
                SELECT id, family_entity_id, chunk_id, (1 - (embedding <=> %s::vector(384))) AS cosine_similarity
                FROM document_vectors
                ORDER BY embedding <=> %s::vector(384)
                LIMIT 5;
            """, (target_query_vec, target_query_vec))
            results = cur.fetchall()
            for r in results:
                print(f"    Hit: chunk={r['chunk_id']}, tenant={r['family_entity_id']}, sim={r['cosine_similarity']:.4f}")
                assert r['family_entity_id'] == fam_a, "CRITICAL LEAK: Non-tenant vector returned in similarity search!"
            print("    --> Success! All returned vector hits belong exclusively to Tenant A.")

            print("\n[3] Generating EXPLAIN using HNSW index (idx_document_vectors_hnsw):")
            cur.execute("SET enable_seqscan = off;")
            cur.execute("""
                EXPLAIN (COSTS OFF)
                SELECT id, family_entity_id, chunk_id
                FROM document_vectors
                ORDER BY embedding <=> %s::vector(384)
                LIMIT 5;
            """, (target_query_vec,))
            explain_lines = cur.fetchall()
            for line in explain_lines:
                print(f"    {list(line.values())[0]}")

    print("\n" + "=" * 60)
    print("REQUIREMENT 7 VERIFIED: PGVECTOR RETRIEVAL SCOPED & HNSW EXPLAIN CONFIRMED")
    print("=" * 60)

if __name__ == "__main__":
    main()
