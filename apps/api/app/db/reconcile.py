"""Storage Reconciler: cleans up orphan vectors and resolves pending documents.

Usage:
    python -m app.db.reconcile [--dry-run]
"""

import argparse
import logging
import sys
from typing import Any, Dict, List

from app.db import sqlite
from app.services import pinecone_service, vector_index

logger = logging.getLogger(__name__)


def reconcile_storage(dry_run: bool = False) -> Dict[str, Any]:
    """Reconciles pending documents in DB and purges orphan vectors in vector store."""
    all_docs = sqlite.get_all_documents()
    doc_map = {d["id"]: d for d in all_docs}

    pending_resolved_indexed = 0
    pending_resolved_failed = 0
    orphan_vectors_deleted = 0

    # 1. Resolve pending documents
    for doc in all_docs:
        if doc.get("status") == "pending":
            doc_id = doc["id"]
            family_id = doc.get("family_entity_id", "default_family")
            pinecone_doc = vector_index.get_document(doc_id)
            if pinecone_doc and pinecone_doc.get("status") == "indexed":
                logger.info(f"Reconciling pending doc {doc_id} -> indexed")
                if not dry_run:
                    sqlite.update_document_status(doc_id, "indexed")
                pending_resolved_indexed += 1
            else:
                logger.info(f"Reconciling stuck pending doc {doc_id} -> failed")
                if not dry_run:
                    try:
                        vector_index.delete_document(doc_id, family_id)
                    except Exception as e:
                        logger.debug(f"Pinecone delete failed during reconcile: {e}")
                    sqlite.update_document_status(doc_id, "failed")
                pending_resolved_failed += 1

    # 2. Check for orphan vectors in Pinecone default namespace
    try:
        index = pinecone_service.get_index()
        # Scan documents_registry namespace
        try:
            reg_docs = pinecone_service.list_documents_from_pinecone()
            for rdoc in reg_docs:
                rdoc_id = rdoc.get("id")
                if rdoc_id and (rdoc_id not in doc_map or doc_map[rdoc_id].get("status") == "failed"):
                    logger.info(f"Found orphan pinecone doc registry record {rdoc_id}")
                    if not dry_run:
                        pinecone_service.delete_document_from_pinecone(rdoc_id)
                    orphan_vectors_deleted += 1
        except Exception as e:
            logger.debug(f"Pinecone registry scan skipped: {e}")
    except Exception as e:
        logger.debug(f"Pinecone index unavailable for orphan cleanup: {e}")

    summary = {
        "pending_resolved_indexed": pending_resolved_indexed,
        "pending_resolved_failed": pending_resolved_failed,
        "orphan_vectors_deleted": orphan_vectors_deleted,
        "dry_run": dry_run,
    }
    return summary


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    parser = argparse.ArgumentParser(description="Reconcile orphan vectors and pending documents.")
    parser.add_argument("--dry-run", action="store_true", help="Simulate without mutating storage.")
    args = parser.parse_args()

    print(f"Starting reconciliation (dry_run={args.dry_run})...")
    res = reconcile_storage(dry_run=args.dry_run)
    print("Reconciliation complete:")
    print(f"  - Pending -> Indexed: {res['pending_resolved_indexed']}")
    print(f"  - Pending -> Failed:  {res['pending_resolved_failed']}")
    print(f"  - Orphan vectors removed: {res['orphan_vectors_deleted']}")


if __name__ == "__main__":
    main()
