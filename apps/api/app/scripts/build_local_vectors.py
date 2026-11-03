"""
Builds the local vector index from the SQL system of record (Audit I-09).

Documents ingested while PRIVACY_MODE=cloud have their chunk text in `document_chunks` but their
vectors only in Pinecone. This script embeds those chunks on this machine and stores the vectors in
`chunk_vectors`. Nothing is read from or sent to any cloud service. Safe to re-run: only chunks
without a local vector are embedded.

Usage:
    python -m app.scripts.build_local_vectors [--dry-run]
"""
import argparse
import logging
import sys
from typing import Dict, List

from app.db import sqlite
from app.services import embeddings, local_vector_index

logger = logging.getLogger(__name__)

BATCH_SIZE = 64


def _roles_for_acl(acl_role: str) -> List[str]:
    # Same tagging as ingestion: admin-only documents carry the admin tag only
    return ["family_admin"] if acl_role == "family_admin" else ["family_admin", "family_member"]


def build_local_vectors(dry_run: bool = False) -> Dict[str, int]:
    sqlite.init_db()
    families = sorted({d["family_entity_id"] for d in sqlite.get_all_documents()})
    summary = {"families": len(families), "chunks_missing": 0, "vectors_written": 0}

    for family in families:
        missing = sqlite.get_chunks_without_vectors(family)
        summary["chunks_missing"] += len(missing)
        if dry_run or not missing:
            continue
        # Group by ACL so each batch is written with the right role tags
        by_role: Dict[str, List[Dict]] = {}
        for c in missing:
            by_role.setdefault(c.get("allowed_role") or "family_member", []).append(c)
        for acl_role, chunks in by_role.items():
            for i in range(0, len(chunks), BATCH_SIZE):
                batch = chunks[i:i + BATCH_SIZE]
                vectors = embeddings.embed_texts([c["content"] for c in batch])
                summary["vectors_written"] += local_vector_index.upsert_vectors(
                    chunks=[{"id": c["id"], "document_id": c["document_id"]} for c in batch],
                    embeddings=vectors,
                    family_entity_id=family,
                    allowed_roles=_roles_for_acl(acl_role),
                )
        logger.info("Family %s: embedded %d chunks locally", family, len(missing))
    return summary


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    parser = argparse.ArgumentParser(description="Embed SQL chunks into the local vector index.")
    parser.add_argument("--dry-run", action="store_true", help="Only count chunks without local vectors.")
    args = parser.parse_args()
    summary = build_local_vectors(dry_run=args.dry_run)
    print(summary)
    sys.exit(0)


if __name__ == "__main__":
    main()
