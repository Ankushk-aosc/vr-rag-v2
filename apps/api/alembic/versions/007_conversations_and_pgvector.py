"""007_conversations_and_pgvector

Revision ID: 007_conversations_and_pgvector
Revises: 006_widen_chunk_ids
Create Date: 2026-11-03 12:00:00.000000

Adds conversations and messages tables with tenant-isolation RLS,
and standardizes pgvector document_vectors table with HNSW index.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '007_conversations_and_pgvector'
down_revision: Union[str, None] = '006_widen_chunk_ids'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    is_pg = bind.dialect.name == "postgresql"

    # 1. conversations
    op.create_table(
        "conversations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("tenant_id", sa.String(36), sa.ForeignKey("family_entities.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(255), server_default="Financial Inquiry", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
    )
    op.create_index("idx_conversations_tenant_user", "conversations", ["tenant_id", "user_id"])

    # 2. messages
    op.create_table(
        "messages",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("conversation_id", sa.String(36), sa.ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("role", sa.String(50), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("citations_json", sa.Text(), nullable=True),
        sa.Column("metadata_json", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
    )
    op.create_index("idx_messages_conversation", "messages", ["conversation_id"])

    # 3. PostgreSQL RLS & pgvector
    if is_pg:
        op.execute("""
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
                    CREATE EXTENSION IF NOT EXISTS vector;
                END IF;
            EXCEPTION WHEN OTHERS THEN
                NULL;
            END $$;
        """)

        op.execute("ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;")
        op.execute("ALTER TABLE conversations FORCE ROW LEVEL SECURITY;")
        op.execute("""
            CREATE POLICY conversations_tenant_isolation ON conversations
            FOR ALL
            USING (
                coalesce(current_setting('app.rls_bypass', true), '') = 'on'
                OR tenant_id = ANY(string_to_array(nullif(current_setting('app.current_family_ids', true), ''), ','))
            )
            WITH CHECK (
                coalesce(current_setting('app.rls_bypass', true), '') = 'on'
                OR tenant_id = ANY(string_to_array(nullif(current_setting('app.current_family_ids', true), ''), ','))
            );
        """)

        op.execute("ALTER TABLE messages ENABLE ROW LEVEL SECURITY;")
        op.execute("ALTER TABLE messages FORCE ROW LEVEL SECURITY;")
        op.execute("""
            CREATE POLICY messages_tenant_isolation ON messages
            FOR ALL
            USING (
                coalesce(current_setting('app.rls_bypass', true), '') = 'on'
                OR conversation_id IN (
                    SELECT id FROM conversations
                    WHERE tenant_id = ANY(string_to_array(nullif(current_setting('app.current_family_ids', true), ''), ','))
                )
            )
            WITH CHECK (
                coalesce(current_setting('app.rls_bypass', true), '') = 'on'
                OR conversation_id IN (
                    SELECT id FROM conversations
                    WHERE tenant_id = ANY(string_to_array(nullif(current_setting('app.current_family_ids', true), ''), ','))
                )
            );
        """)

        op.execute("""
            CREATE TABLE IF NOT EXISTS document_vectors (
                id VARCHAR(255) PRIMARY KEY,
                family_entity_id VARCHAR(36) NOT NULL,
                document_id VARCHAR(36) NOT NULL,
                allowed_role VARCHAR(50) NOT NULL,
                page_no INT,
                chunk_id VARCHAR(255),
                metadata_json TEXT,
                embedding vector(384)
            );
        """)
        op.execute("""
            CREATE INDEX IF NOT EXISTS idx_document_vectors_hnsw
            ON document_vectors USING hnsw (embedding vector_cosine_ops);
        """)
        op.execute("""
            CREATE INDEX IF NOT EXISTS idx_doc_vectors_family
            ON document_vectors (family_entity_id);
        """)
        op.execute("""
            CREATE INDEX IF NOT EXISTS idx_doc_vectors_doc
            ON document_vectors (document_id);
        """)

        op.execute("ALTER TABLE document_vectors ENABLE ROW LEVEL SECURITY;")
        op.execute("ALTER TABLE document_vectors FORCE ROW LEVEL SECURITY;")
        op.execute("""
            CREATE POLICY document_vectors_tenant_isolation ON document_vectors
            FOR ALL
            USING (
                coalesce(current_setting('app.rls_bypass', true), '') = 'on'
                OR family_entity_id = ANY(string_to_array(nullif(current_setting('app.current_family_ids', true), ''), ','))
            )
            WITH CHECK (
                coalesce(current_setting('app.rls_bypass', true), '') = 'on'
                OR family_entity_id = ANY(string_to_array(nullif(current_setting('app.current_family_ids', true), ''), ','))
            );
        """)


def downgrade() -> None:
    bind = op.get_bind()
    is_pg = bind.dialect.name == "postgresql"

    if is_pg:
        op.execute("DROP TABLE IF EXISTS document_vectors;")
    op.drop_table("messages")
    op.drop_table("conversations")

