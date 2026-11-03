"""006_widen_chunk_ids

document_chunks.id was VARCHAR(36), but chunk ids are "{document_id}_p{page}_c{n}" (a UUID plus a
suffix), so every upload failed on PostgreSQL with StringDataRightTruncation (Audit I-16).

Revision ID: 006_widen_chunk_ids
Revises: 005_rls_system_lookups
Create Date: 2026-11-02 22:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '006_widen_chunk_ids'
down_revision: Union[str, None] = '005_rls_system_lookups'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("document_chunks") as batch:
        batch.alter_column("id", existing_type=sa.String(36), type_=sa.String(255), existing_nullable=False)


def downgrade() -> None:
    with op.batch_alter_table("document_chunks") as batch:
        batch.alter_column("id", existing_type=sa.String(255), type_=sa.String(36), existing_nullable=False)
