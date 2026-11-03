"""
Migration Utility: SQLite to Cloud-Native Pinecone Metadata
Transfers existing document records and chunk content text from local SQLite (app.db)
directly into Pinecone vector metadata, completely eliminating local database dependency.
"""
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from app.config import settings
from app.services.pinecone_service import (
    get_index,
    save_document_to_pinecone,
    list_documents_from_pinecone
)


def run_migration():
    if settings.is_local_mode:
        # Copying documents to Pinecone is exactly what local privacy mode forbids (Audit I-09)
        raise SystemExit("Refusing to upload to Pinecone: PRIVACY_MODE=local. Set PRIVACY_MODE=cloud to opt in.")
    print("=" * 60)
    print("STARTING SQLITE -> PINECONE CLOUD STORAGE MIGRATION")
    print(f"Source Database: {settings.SQLITE_DB_PATH}")
    print(f"Target Pinecone Index: {settings.PINECONE_INDEX_NAME}")
    print("=" * 60)

    conn = sqlite3.connect(settings.SQLITE_DB_PATH)
    cur = conn.cursor()

    # 1. Migrate Document Records into Pinecone documents_registry namespace
    print("\n[Step 1/2] Migrating Documents to Pinecone Document Registry...")
    cur.execute("SELECT id, filename, original_name, mime_type, file_size, file_hash, total_pages, family_entity_id, status, uploaded_at FROM documents")
    docs = cur.fetchall()
    print(f"Found {len(docs)} documents in SQLite.")

    for row in docs:
        doc_dict = {
            "id": row[0],
            "filename": row[1],
            "original_name": row[2],
            "mime_type": row[3],
            "file_size": row[4],
            "file_hash": row[5],
            "total_pages": row[6],
            "family_entity_id": row[7],
            "status": row[8],
            "uploaded_at": str(row[9])
        }
        save_document_to_pinecone(doc_dict)
        print(f"  [OK] Saved document '{doc_dict['original_name']}' ({doc_dict['id']}) to Pinecone registry.")

    # Verify documents in Pinecone
    cloud_docs = list_documents_from_pinecone("default_family")
    print(f"Verification: {len(cloud_docs)} documents verified in Pinecone cloud registry.")

    # 2. Migrate Chunks Content Text into Pinecone Vector Metadata
    print("\n[Step 2/2] Updating Pinecone Vectors with Chunk Text Content...")
    cur.execute("SELECT id, content FROM document_chunks")
    chunks = cur.fetchall()
    total_chunks = len(chunks)
    print(f"Found {total_chunks} chunks to update in Pinecone.")

    index = get_index()
    start_time = time.time()
    completed = 0
    errors = 0

    def update_vector_text(chunk_row):
        cid, content = chunk_row
        try:
            index.update(id=cid, set_metadata={"text": content})
            return True
        except Exception:
            return False

    with ThreadPoolExecutor(max_workers=25) as executor:
        futures = [executor.submit(update_vector_text, row) for row in chunks]
        for f in as_completed(futures):
            res = f.result()
            if res:
                completed += 1
            else:
                errors += 1
            if completed % 500 == 0 or completed == total_chunks:
                elapsed = time.time() - start_time
                rate = completed / elapsed if elapsed > 0 else 0
                print(f"  Progress: {completed}/{total_chunks} vectors updated ({rate:.1f} chunks/sec)...")

    print(f"\nMigration Complete! Updated {completed} vectors ({errors} errors) in {time.time() - start_time:.1f}s.")
    conn.close()


if __name__ == "__main__":
    run_migration()
