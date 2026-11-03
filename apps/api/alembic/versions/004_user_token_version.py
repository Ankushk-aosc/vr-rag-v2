"""004_user_token_version

Session version per user (Audit I-15). Access tokens carry it as the `ver` claim; a password change
increments it, which invalidates every token issued before the change.

Revision ID: 004_user_token_version
Revises: 003_local_vector_index
Create Date: 2026-11-02 21:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '004_user_token_version'
down_revision: Union[str, None] = '003_local_vector_index'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("token_version", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("users", "token_version")
