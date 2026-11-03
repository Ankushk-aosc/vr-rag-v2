"""003_local_vector_index

Local vector index and document display metadata for PRIVACY_MODE=local (Audit I-09).
Chunk text is not duplicated here: it stays in document_chunks.

Revision ID: 003_local_vector_index
Revises: 002_llm_usage_and_rls
Create Date: 2026-11-02 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '003_local_vector_index'
down_revision: Union[str, None] = '002_llm_usage_and_rls'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TENANT_TABLES = ("chunk_vectors", "document_meta")


def upgrade() -> None:
    bind = op.get_bind()
    is_pg = bind.dialect.name == "postgresql"

    op.create_table(
        "chunk_vectors",
        sa.Column("chunk_id", sa.String(255), primary_key=True),
        sa.Column("document_id", sa.String(36), sa.ForeignKey("documents.id", ondelete="CASCADE"), nullable=False),
        sa.Column("family_entity_id", sa.String(36), sa.ForeignKey("family_entities.id", ondelete="CASCADE"), nullable=False),
        sa.Column("allowed_roles", sa.Text(), nullable=False),
        sa.Column("embedder_model", sa.String(255), nullable=True),
        sa.Column("embedding_dim", sa.Integer(), nullable=False),
        sa.Column("embedding", sa.LargeBinary(), nullable=False),
    )
    op.create_index("idx_chunk_vectors_family", "chunk_vectors", ["family_entity_id"])
    op.create_index("ix_chunk_vectors_document_id", "chunk_vectors", ["document_id"])

    op.create_table(
        "document_meta",
        sa.Column("document_id", sa.String(36), sa.ForeignKey("documents.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("family_entity_id", sa.String(36), sa.ForeignKey("family_entities.id", ondelete="CASCADE"), nullable=False),
        sa.Column("meta_json", sa.Text(), nullable=False),
    )
    op.create_index("ix_document_meta_family_entity_id", "document_meta", ["family_entity_id"])

    if is_pg:
        for table in TENANT_TABLES:
            op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;")
            op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY;")
            op.execute(f"""
                CREATE POLICY {table}_tenant_isolation ON {table}
                FOR ALL
                USING (
                    family_entity_id = ANY(string_to_array(nullif(current_setting('app.current_family_ids', true), ''), ','))
                );
            """)


def downgrade() -> None:
    bind = op.get_bind()
    is_pg = bind.dialect.name == "postgresql"

    if is_pg:
        for table in TENANT_TABLES:
            op.execute(f"DROP POLICY IF EXISTS {table}_tenant_isolation ON {table};")
            op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY;")

    op.drop_table("document_meta")
    op.drop_table("chunk_vectors")
