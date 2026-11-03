"""005_rls_system_lookups

Recreates every tenant-isolation policy so that (a) all seven tenant tables are covered and (b) a
transaction explicitly marked as a system lookup (`SET LOCAL app.rls_bypass = 'on'`, see
app.db.session.set_system_context) can read rows by id. Those lookups are authorized in application
code, as in SQLite mode. Without this, id lookups (get_document_by_id, get_chunks_by_ids, ...) returned
nothing under FORCE ROW LEVEL SECURITY and writes such as insert_chunks were rejected (Audit I-16).

Revision ID: 005_rls_system_lookups
Revises: 004_user_token_version
Create Date: 2026-11-02 22:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


revision: str = '005_rls_system_lookups'
down_revision: Union[str, None] = '004_user_token_version'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TENANT_SET = "string_to_array(nullif(current_setting('app.current_family_ids', true), ''), ',')"
BYPASS = "coalesce(current_setting('app.rls_bypass', true), '') = 'on'"

# table -> tenant condition (without the bypass)
TENANT_POLICIES = {
    "documents": f"family_entity_id = ANY({TENANT_SET})",
    "document_acl": f"family_entity_id = ANY({TENANT_SET})",
    "document_chunks": (
        "EXISTS (SELECT 1 FROM documents d WHERE d.id = document_chunks.document_id "
        f"AND d.family_entity_id = ANY({TENANT_SET}))"
    ),
    "audit_events": f"family_entity_id IS NULL OR family_entity_id = ANY({TENANT_SET})",
    "llm_usage": f"family_entity_id = ANY({TENANT_SET})",
    "chunk_vectors": f"family_entity_id = ANY({TENANT_SET})",
    "document_meta": f"family_entity_id = ANY({TENANT_SET})",
}


def policy_sql(table: str, condition: str) -> str:
    return (
        f"CREATE POLICY {table}_tenant_isolation ON {table} FOR ALL "
        f"USING ({BYPASS} OR ({condition})) WITH CHECK ({BYPASS} OR ({condition}));"
    )


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    for table, condition in TENANT_POLICIES.items():
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY;")
        op.execute(f"DROP POLICY IF EXISTS {table}_tenant_isolation ON {table};")
        op.execute(policy_sql(table, condition))


def downgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    for table, condition in TENANT_POLICIES.items():
        op.execute(f"DROP POLICY IF EXISTS {table}_tenant_isolation ON {table};")
        op.execute(f"CREATE POLICY {table}_tenant_isolation ON {table} FOR ALL USING ({condition});")
