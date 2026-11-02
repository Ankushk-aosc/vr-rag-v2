"""002_llm_usage_and_rls

Revision ID: 002_llm_usage_and_rls
Revises: 001_initial_schema_and_rls
Create Date: 2026-11-02 10:05:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '002_llm_usage_and_rls'
down_revision: Union[str, None] = '001_initial_schema_and_rls'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    is_pg = bind.dialect.name == "postgresql"

    # llm_usage table: NO prompt/completion text stored!
    op.create_table(
        "llm_usage",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("family_entity_id", sa.String(36), sa.ForeignKey("family_entities.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
        sa.Column("route", sa.String(255), nullable=False),
        sa.Column("provider", sa.String(100), nullable=False),
        sa.Column("model", sa.String(255), nullable=False),
        sa.Column("prompt_tokens", sa.Integer(), server_default="0", nullable=False),
        sa.Column("completion_tokens", sa.Integer(), server_default="0", nullable=False),
        sa.Column("total_tokens", sa.Integer(), server_default="0", nullable=False),
        sa.Column("cost_usd", sa.Numeric(12, 6), nullable=True),
        sa.Column("run_id", sa.String(255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
    )
    op.create_index("idx_llm_usage_family_created", "llm_usage", ["family_entity_id", "created_at"])
    op.create_index("idx_llm_usage_user_created", "llm_usage", ["user_id", "created_at"])

    # PostgreSQL RLS
    if is_pg:
        op.execute("ALTER TABLE llm_usage ENABLE ROW LEVEL SECURITY;")
        op.execute("ALTER TABLE llm_usage FORCE ROW LEVEL SECURITY;")
        op.execute("""
            CREATE POLICY llm_usage_tenant_isolation ON llm_usage
            FOR ALL
            USING (
                family_entity_id = ANY(string_to_array(nullif(current_setting('app.current_family_ids', true), ''), ','))
            );
        """)


def downgrade() -> None:
    bind = op.get_bind()
    is_pg = bind.dialect.name == "postgresql"

    if is_pg:
        op.execute("DROP POLICY IF EXISTS llm_usage_tenant_isolation ON llm_usage;")
        op.execute("ALTER TABLE llm_usage DISABLE ROW LEVEL SECURITY;")

    op.drop_table("llm_usage")

