import hashlib
import os
import shutil
import sys
import time
import uuid
from pathlib import Path

# Add project root to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.config import settings
from app.db import sqlite
from app.services import chunker, embeddings, extractor, pinecone_service, vector_index

MIME_MAP = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".txt": "text/plain",
    ".csv": "text/csv"
}


def ingest_folder(folder_path: Path, family_entity_id: str = "default_family", allowed_role: str = "family_member"):
    print("=" * 70)
    print("STARTING FINANCIAL DOCUMENT INGESTION TO PINECONE & SQLITE")
    print(f"Source Folder: {folder_path}")
    print(f"Target Pinecone Index: {settings.PINECONE_INDEX_NAME}")
    print(f"Target SQLite DB: {settings.SQLITE_DB_PATH}")
    print("=" * 70)

    # Initialize SQLite database schema
    sqlite.init_db()

    if vector_index.is_local():
        print("PRIVACY_MODE=local: vectors are stored in the local database")
    else:
        pinecone_service.get_index()
        print(f"Connected to Pinecone Index: {settings.PINECONE_INDEX_NAME}")

    files = [f for f in sorted(folder_path.iterdir()) if f.is_file() and f.suffix.lower() in MIME_MAP]
    if not files:
        print(f"No valid financial documents found in {folder_path}")
        return

    uploads_dir = Path(settings.UPLOADS_DIR)
    uploads_dir.mkdir(parents=True, exist_ok=True)

    summary_results = []

    for idx, file_path in enumerate(files, 1):
        print(f"\n[{idx}/{len(files)}] Processing: {file_path.name} ({file_path.stat().st_size / 1024:.1f} KB)")
        t0 = time.time()

        # Calculate SHA256
        hasher = hashlib.sha256()
        with open(file_path, "rb") as f:
            while buf := f.read(65536):
                hasher.update(buf)
        file_hash = hasher.hexdigest()

        # Check existing document by hash
        with sqlite.get_db_connection() as conn:
            row = conn.execute("SELECT id FROM documents WHERE file_hash = ?", (file_hash,)).fetchone()
            if row:
                print(f"  -> Already indexed as doc ID: {row['id']} (Skipping duplicate)")
                summary_results.append({
                    "filename": file_path.name,
                    "status": "already_exists",
                    "doc_id": row["id"],
                    "chunks": 0,
                    "vectors": 0
                })
                continue

        doc_id = str(uuid.uuid4())
        ext = file_path.suffix.lower()
        mime_type = MIME_MAP[ext]
        stored_filename = f"{doc_id}{ext}"
        dest_path = uploads_dir / stored_filename
        shutil.copy2(file_path, dest_path)

        # 1. Extract text and tables
        pages = extractor.extract_document(dest_path, mime_type)
        print(f"  -> Extracted {len(pages)} page(s) / section(s)")

        # 2. Chunk document
        chunks = chunker.chunk_document(document_id=doc_id, pages=pages)
        print(f"  -> Generated {len(chunks)} bounded chunk(s)")

        # 3. Compute Embeddings in batches
        chunk_texts = [c["content"] for c in chunks]
        print(f"  -> Generating {len(chunk_texts)} dense embeddings via {settings.EMBEDDING_MODEL}...")
        chunk_embeddings = embeddings.embed_texts(chunk_texts)

        # 5. Save to SQLite
        doc_record = {
            "id": doc_id,
            "filename": stored_filename,
            "original_name": file_path.name,
            "mime_type": mime_type,
            "file_size": file_path.stat().st_size,
            "file_hash": file_hash,
            "total_pages": len(pages),
            "family_entity_id": family_entity_id,
            "status": "indexed"
        }
        sqlite.insert_document(doc_record)
        sqlite.insert_document_acl(document_id=doc_id, family_entity_id=family_entity_id, allowed_role=allowed_role)
        sqlite.insert_chunks(chunks)

        # 6. Store vectors (after the SQL rows they reference exist)
        roles = ["family_admin", "family_member"] if allowed_role == "family_member" else ["family_admin"]
        upserted_count = vector_index.upsert_vectors(
            chunks=chunks,
            embeddings=chunk_embeddings,
            family_entity_id=family_entity_id,
            allowed_roles=roles
        )
        print(f"  -> Indexed {upserted_count} vectors ({'local database' if vector_index.is_local() else 'Pinecone'})")

        sqlite.log_audit_event(
            action="DOCUMENT_UPLOAD",
            user_id="mcp_ingest_agent",
            resource_id=doc_id,
            details=f"Ingested '{file_path.name}' via Pinecone MCP pipeline ({upserted_count} vectors)"
        )

        elapsed = time.time() - t0
        print(f"  -> Finished in {elapsed:.2f}s")

        summary_results.append({
            "filename": file_path.name,
            "status": "indexed",
            "doc_id": doc_id,
            "pages": len(pages),
            "chunks": len(chunks),
            "vectors": upserted_count,
            "duration": f"{elapsed:.2f}s"
        })

    print("\n" + "=" * 70)
    print("INGESTION COMPLETE SUMMARY:")
    for res in summary_results:
        print(f" - {res['filename']}: {res.get('vectors', 0)} vectors, {res.get('chunks', 0)} chunks, Status: {res['status']}")
    print("=" * 70)

    # Describe final index stats
    stats = index.describe_index_stats()
    print(f"\nFinal Pinecone Index Stats: {stats}")


if __name__ == "__main__":
    folder = Path(r"C:\Users\LENOVO\Downloads\aapl")
    ingest_folder(folder)
