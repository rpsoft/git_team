"""agent voice settings for 1:1 calls

Revision ID: d4e3f2a10003
Revises: c3d2e1f00002
Create Date: 2026-10-06
"""
from alembic import op
import sqlalchemy as sa

revision = "d4e3f2a10003"
down_revision = "c3d2e1f00002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("agents", sa.Column("voice_type", sa.String(length=16), nullable=False, server_default="any"))
    op.add_column("agents", sa.Column("voice_name", sa.String(length=128), nullable=True))


def downgrade() -> None:
    op.drop_column("agents", "voice_name")
    op.drop_column("agents", "voice_type")
