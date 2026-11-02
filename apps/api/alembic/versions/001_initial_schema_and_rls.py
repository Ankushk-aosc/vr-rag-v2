"""001_initial_schema_and_rls

Revision ID: 001_initial_schema_and_rls
Revises: 
Create Date: 2026-11-02 09:40:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '001_initial_schema_and_rls'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    is_pg = bind.dialect.name == "postgresql"

    # 1. users
    op.create_table(
        "users",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("email", sa.String(255), unique=True, nullable=False),
        sa.Column("hashed_password", sa.String(255), nullable=False),
        sa.Column("full_name", sa.String(255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
    )
    op.create_index("idx_users_email", "users", ["email"])

    # 2. family_entities
    op.create_table(
        "family_entities",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("entity_type", sa.String(50), server_default="Family Trust", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
    )

    # 3. memberships
    op.create_table(
        "memberships",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("family_entity_id", sa.String(36), sa.ForeignKey("family_entities.id", ondelete="CASCADE"), nullable=False),
        sa.Column("role", sa.String(50), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.UniqueConstraint("user_id", "family_entity_id", name="uq_user_family_membership"),
        sa.CheckConstraint("role IN ('family_admin', 'family_member', 'read_only_adviser')", name="ck_membership_role"),
    )
    op.create_index("idx_memberships_user", "memberships", ["user_id"])
    op.create_index("idx_memberships_family", "memberships", ["family_entity_id"])

    # 4. documents
    op.create_table(
        "documents",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("filename", sa.String(255), nullable=False),
        sa.Column("original_name", sa.String(255), nullable=False),
        sa.Column("mime_type", sa.String(100), nullable=False),
        sa.Column("file_size", sa.Integer(), nullable=False),
        sa.Column("file_hash", sa.String(64), nullable=False),
        sa.Column("total_pages", sa.Integer(), server_default="1", nullable=False),
        sa.Column("family_entity_id", sa.String(36), sa.ForeignKey("family_entities.id", ondelete="CASCADE"), nullable=False),
        sa.Column("status", sa.String(50), server_default="indexed", nullable=False),
        sa.Column("uploaded_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.UniqueConstraint("family_entity_id", "file_hash", name="uq_family_file_hash"),
    )
    op.create_index("idx_documents_family", "documents", ["family_entity_id"])
    op.create_index("idx_documents_file_hash", "documents", ["file_hash"])

    # 5. document_acl
    op.create_table(
        "document_acl",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("document_id", sa.String(36), sa.ForeignKey("documents.id", ondelete="CASCADE"), nullable=False),
        sa.Column("family_entity_id", sa.String(36), sa.ForeignKey("family_entities.id", ondelete="CASCADE"), nullable=False),
        sa.Column("allowed_role", sa.String(50), nullable=False),
    )
    op.create_index("idx_doc_acl", "document_acl", ["document_id", "family_entity_id"])

    # 6. document_chunks
    op.create_table(
        "document_chunks",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("document_id", sa.String(36), sa.ForeignKey("documents.id", ondelete="CASCADE"), nullable=False),
        sa.Column("chunk_index", sa.Integer(), nullable=False),
        sa.Column("page_number", sa.Integer(), nullable=False),
        sa.Column("section_title", sa.String(255), nullable=True),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("is_table", sa.Boolean(), server_default=sa.text("false" if is_pg else "0"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
    )
    op.create_index("idx_chunks_doc_id", "document_chunks", ["document_id"])
    op.create_index("idx_chunks_page", "document_chunks", ["page_number"])

    # 7. audit_events
    op.create_table(
        "audit_events",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), nullable=True),
        sa.Column("family_entity_id", sa.String(36), nullable=True),
        sa.Column("action", sa.String(100), nullable=False),
        sa.Column("resource_id", sa.String(255), nullable=True),
        sa.Column("details", sa.Text(), nullable=True),
        sa.Column("timestamp", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
    )
    op.create_index("idx_audit_family_timestamp", "audit_events", ["family_entity_id", "timestamp"])
    op.create_index("idx_audit_user", "audit_events", ["user_id"])

    # 8. revoked_tokens
    op.create_table(
        "revoked_tokens",
        sa.Column("jti", sa.String(255), primary_key=True),
        sa.Column("user_id", sa.String(36), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("idx_revoked_tokens_expires", "revoked_tokens", ["expires_at"])

    # 9. PostgreSQL RLS
    if is_pg:
        op.execute("ALTER TABLE documents ENABLE ROW LEVEL SECURITY;")
        op.execute("ALTER TABLE documents FORCE ROW LEVEL SECURITY;")
        op.execute("""
            CREATE POLICY documents_tenant_isolation ON documents
            FOR ALL
            USING (
                family_entity_id = ANY(string_to_array(nullif(current_setting('app.current_family_ids', true), ''), ','))
            );
        """)

        op.execute("ALTER TABLE document_acl ENABLE ROW LEVEL SECURITY;")
        op.execute("ALTER TABLE document_acl FORCE ROW LEVEL SECURITY;")
        op.execute("""
            CREATE POLICY document_acl_tenant_isolation ON document_acl
            FOR ALL
            USING (
                family_entity_id = ANY(string_to_array(nullif(current_setting('app.current_family_ids', true), ''), ','))
            );
        """)

        op.execute("ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;")
        op.execute("ALTER TABLE document_chunks FORCE ROW LEVEL SECURITY;")
        op.execute("""
            CREATE POLICY document_chunks_tenant_isolation ON document_chunks
            FOR ALL
            USING (
                EXISTS (
                    SELECT 1 FROM documents d
                    WHERE d.id = document_chunks.document_id
                      AND d.family_entity_id = ANY(string_to_array(nullif(current_setting('app.current_family_ids', true), ''), ','))
                )
            );
        """)

        op.execute("ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;")
        op.execute("ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;")
        op.execute("""
            CREATE POLICY audit_events_tenant_isolation ON audit_events
            FOR ALL
            USING (
                family_entity_id IS NULL OR
                family_entity_id = ANY(string_to_array(nullif(current_setting('app.current_family_ids', true), ''), ','))
            );
        """)


def downgrade() -> None:
    bind = op.get_bind()
    is_pg = bind.dialect.name == "postgresql"

    if is_pg:
        op.execute("DROP POLICY IF EXISTS audit_events_tenant_isolation ON audit_events;")
        op.execute("ALTER TABLE audit_events DISABLE ROW LEVEL SECURITY;")
        op.execute("DROP POLICY IF EXISTS document_chunks_tenant_isolation ON document_chunks;")
        op.execute("ALTER TABLE document_chunks DISABLE ROW LEVEL SECURITY;")
        op.execute("DROP POLICY IF EXISTS document_acl_tenant_isolation ON document_acl;")
        op.execute("ALTER TABLE document_acl DISABLE ROW LEVEL SECURITY;")
        op.execute("DROP POLICY IF EXISTS documents_tenant_isolation ON documents;")
        op.execute("ALTER TABLE documents DISABLE ROW LEVEL SECURITY;")

    op.drop_table("revoked_tokens")
    op.drop_table("audit_events")
    op.drop_table("document_chunks")
    op.drop_table("document_acl")
    op.drop_table("documents")
    op.drop_table("memberships")
    op.drop_table("family_entities")
    op.drop_table("users")
