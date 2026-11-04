"""008_doc_abac_pgvector

Revision ID: 008_doc_abac_pgvector
Revises: 007_conversations_and_pgvector
Create Date: 2026-11-04 09:00:00.000000

1. ABAC attributes on documents: owner_user_id and classification (internal | confidential | restricted).
   Existing rows take their classification from the ACL: admin-only documents become "restricted".
2. pgvector storage for the retrieval index: chunk_vectors.embedding_vec vector(EMBEDDING_DIMENSION)
   with an HNSW cosine index. The dimension comes from settings, so it always matches the embedder
   that writes the index (all-MiniLM-L6-v2 = 384). Existing rows are backfilled from the float32
   bytes column, so no re-embedding is needed and no chunk is lost.

On PostgreSQL without the pgvector extension the vector column is skipped and retrieval keeps the
in-process scoring path; the extension must be created by a superuser (see docker/postgres).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "008_doc_abac_pgvector"
down_revision: Union[str, None] = "007_conversations_and_pgvector"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_vector_extension(bind) -> bool:
    try:
        bind.execute(sa.text("CREATE EXTENSION IF NOT EXISTS vector"))
    except Exception:
        pass  # the app role may not create extensions; check whether a superuser already did
    return bool(bind.execute(sa.text("SELECT 1 FROM pg_extension WHERE extname = 'vector'")).first())


def upgrade() -> None:
    bind = op.get_bind()
    is_pg = bind.dialect.name == "postgresql"
    if is_pg:
        # FORCE RLS applies to the table owner too; the backfills below must see every tenant's rows
        bind.execute(sa.text("SELECT set_config('app.rls_bypass', 'on', true)"))

    op.add_column("documents", sa.Column("owner_user_id", sa.String(36), nullable=True))
    op.add_column(
        "documents",
        sa.Column("classification", sa.String(20), nullable=False, server_default="confidential"),
    )
    op.execute(
        "UPDATE documents SET classification = 'restricted' "
        "WHERE id IN (SELECT document_id FROM document_acl WHERE allowed_role = 'family_admin')"
    )
    op.create_check_constraint(
        "ck_documents_classification", "documents",
        "classification IN ('internal', 'confidential', 'restricted')",
    )
    op.create_index("idx_documents_family_class", "documents", ["family_entity_id", "classification"])

    if not is_pg:
        return

    # The savepoint keeps a failed CREATE EXTENSION from aborting the whole migration transaction
    with bind.begin_nested():
        available = _has_vector_extension(bind)
    if not available:
        return

    from app.config import settings

    dim = int(settings.EMBEDDING_DIMENSION)
    op.execute(f"ALTER TABLE chunk_vectors ADD COLUMN IF NOT EXISTS embedding_vec vector({dim})")
    # Backfill from the float32 bytes already stored; rows from a different embedder are left NULL
    # (never mixed into this vector space) and are reported by scripts/migrate_vectors_to_pgvector.py
    import numpy as np

    rows = bind.execute(sa.text(
        "SELECT chunk_id, embedding FROM chunk_vectors WHERE embedding_dim = :d AND embedding_vec IS NULL"
    ), {"d": dim}).all()
    for chunk_id, raw in rows:
        vec = np.frombuffer(bytes(raw), dtype=np.float32)
        literal = "[" + ",".join(repr(float(v)) for v in vec) + "]"
        bind.execute(
            sa.text("UPDATE chunk_vectors SET embedding_vec = CAST(:v AS vector) WHERE chunk_id = :id"),
            {"v": literal, "id": chunk_id},
        )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_chunk_vectors_embedding_hnsw "
        "ON chunk_vectors USING hnsw (embedding_vec vector_cosine_ops)"
    )
    op.execute("CREATE INDEX IF NOT EXISTS idx_chunk_vectors_family_doc ON chunk_vectors (family_entity_id, document_id)")


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("DROP INDEX IF EXISTS idx_chunk_vectors_family_doc")
        op.execute("DROP INDEX IF EXISTS idx_chunk_vectors_embedding_hnsw")
        op.execute("ALTER TABLE chunk_vectors DROP COLUMN IF EXISTS embedding_vec")
    op.drop_index("idx_documents_family_class", table_name="documents")
    op.drop_constraint("ck_documents_classification", "documents", type_="check")
    op.drop_column("documents", "classification")
    op.drop_column("documents", "owner_user_id")
