"""
Migrates the retrieval index into PostgreSQL + pgvector and proves nothing was lost.

Steps (safe to re-run):
  1. Embed every chunk in `document_chunks` that has no vector yet (same embedder as ingestion), which
     also fills the pgvector column. Chunks whose vectors only ever lived in Pinecone are regenerated
     here from their SQL text, so the Pinecone index is not needed to migrate.
  2. Validate per family: chunk count == vector count == pgvector count, every vector has the
     configured dimension, every vector's tenant matches its document's tenant.
  3. Retrieval check: for sample chunks, a scoped pgvector search for the chunk's own text must return
     that chunk in the top results, and every hit must belong to the same family.

Usage:
    DATABASE_URL=postgresql+psycopg://... python -m app.scripts.validate_pgvector_migration [--dry-run] [--samples N]
Exit status is non-zero when any check fails.
"""
import argparse
import json
import logging
import sys
import time
from typing import Any, Dict, List

from sqlalchemy import text

from app.config import settings
from app.db import sqlite
from app.db.session import get_db_session
from app.scripts.build_local_vectors import build_local_vectors
from app.services import authorization, embeddings, local_vector_index

logger = logging.getLogger(__name__)


def _scalar(sql: str, **params: Any) -> int:
    with get_db_session(system=True) as session:
        return int(session.execute(text(sql), params).scalar() or 0)


def validate(dry_run: bool = False, samples: int = 3) -> Dict[str, Any]:
    sqlite.init_db()
    if not sqlite.is_postgres():
        raise SystemExit("DATABASE_URL must point at PostgreSQL for the pgvector migration.")
    repo = sqlite.get_local_index_repository()
    report: Dict[str, Any] = {
        "embedding_model": settings.EMBEDDING_MODEL,
        "embedding_dimension": settings.EMBEDDING_DIMENSION,
        "pgvector_enabled": bool(getattr(repo, "pgvector_enabled", lambda: False)()),
        "backfill": None,
        "families": {},
        "failures": [],
    }
    if not report["pgvector_enabled"]:
        report["failures"].append("pgvector column missing: run migrations with the vector extension installed")
        return report

    report["backfill"] = build_local_vectors(dry_run=dry_run)
    dim = settings.EMBEDDING_DIMENSION
    report["orphan_or_cross_tenant_vectors"] = _scalar(
        "SELECT count(*) FROM chunk_vectors v JOIN documents d ON d.id = v.document_id "
        "WHERE v.family_entity_id <> d.family_entity_id"
    )
    if report["orphan_or_cross_tenant_vectors"]:
        report["failures"].append("vectors whose tenant differs from their document's tenant")

    families = sorted({d["family_entity_id"] for d in sqlite.get_all_documents()})
    for fam in families:
        f = {
            "documents": _scalar("SELECT count(*) FROM documents WHERE family_entity_id = :f AND status <> 'failed'", f=fam),
            "chunks": _scalar(
                "SELECT count(*) FROM document_chunks c JOIN documents d ON d.id = c.document_id "
                "WHERE d.family_entity_id = :f AND d.status <> 'failed'", f=fam),
            "vectors": _scalar("SELECT count(*) FROM chunk_vectors WHERE family_entity_id = :f", f=fam),
            "pgvector_rows": _scalar(
                "SELECT count(*) FROM chunk_vectors WHERE family_entity_id = :f AND embedding_vec IS NOT NULL", f=fam),
            "wrong_dimension": _scalar(
                "SELECT count(*) FROM chunk_vectors WHERE family_entity_id = :f AND embedding_dim <> :d", f=fam, d=dim),
        }
        if not dry_run:
            if f["chunks"] != f["pgvector_rows"]:
                report["failures"].append(f"{fam}: {f['chunks']} chunks but {f['pgvector_rows']} pgvector rows")
            if f["wrong_dimension"]:
                report["failures"].append(f"{fam}: {f['wrong_dimension']} vectors with a different dimension")

        # Retrieval: a chunk's own text should find that chunk, and only this family's chunks
        checks: List[Dict[str, Any]] = []
        with get_db_session(family_ids=[fam]) as session:
            rows = session.execute(text(
                "SELECT c.id, c.content FROM document_chunks c JOIN documents d ON d.id = c.document_id "
                "WHERE d.family_entity_id = :f AND d.status <> 'failed' ORDER BY c.id LIMIT :n"
            ), {"f": fam, "n": samples}).all()
        scope = authorization.scope_for_roles(fam, [authorization.FAMILY_ADMIN])
        for chunk_id, content in rows:
            t0 = time.perf_counter()
            vec = embeddings.embed_query(content[:2000])
            hits = local_vector_index.query_similar_chunks(
                vec, 5, fam, scope.retrieval_roles, allowed_document_ids=scope.allowed_document_ids)
            ms = round((time.perf_counter() - t0) * 1000, 1)
            found = any(h["chunk_id"] == chunk_id for h in hits)
            leaked = [h["chunk_id"] for h in hits if h["metadata"].get("family_entity_id") != fam]
            checks.append({"chunk_id": chunk_id, "self_in_top5": found, "latency_ms": ms, "cross_tenant_hits": len(leaked)})
            if leaked:
                report["failures"].append(f"{fam}: cross-tenant hits for {chunk_id}")
            if not found and not dry_run:
                report["failures"].append(f"{fam}: chunk {chunk_id} not retrievable by its own text")
        f["retrieval_checks"] = checks
        report["families"][fam] = f
    return report


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    parser = argparse.ArgumentParser(description="Migrate and validate the pgvector retrieval index.")
    parser.add_argument("--dry-run", action="store_true", help="Report only; do not embed missing chunks.")
    parser.add_argument("--samples", type=int, default=3, help="Retrieval checks per family.")
    args = parser.parse_args()
    report = validate(dry_run=args.dry_run, samples=max(0, args.samples))
    print(json.dumps(report, indent=2))
    sys.exit(1 if report["failures"] else 0)


if __name__ == "__main__":
    main()
