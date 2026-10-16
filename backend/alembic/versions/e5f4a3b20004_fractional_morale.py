"""fractional morale, so small (scaled-down) morale drops accumulate

Revision ID: e5f4a3b20004
Revises: d4e3f2a10003
Create Date: 2026-10-06
"""
from alembic import op
import sqlalchemy as sa

revision = "e5f4a3b20004"
down_revision = "d4e3f2a10003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("agents", "morale", type_=sa.Float(), existing_type=sa.Integer(), existing_nullable=False)


def downgrade() -> None:
    op.alter_column("agents", "morale", type_=sa.Integer(), existing_type=sa.Float(), existing_nullable=False,
                    postgresql_using="round(morale)::integer")
