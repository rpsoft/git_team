"""meetings (1:1 voice calls)

Revision ID: c3d2e1f00002
Revises: b2a1c0de0001
Create Date: 2026-10-06
"""
from alembic import op
import sqlalchemy as sa

revision = "c3d2e1f00002"
down_revision = "b2a1c0de0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "meetings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("agent_id", sa.Integer(), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=False),
        sa.Column("ended_at", sa.DateTime(), nullable=True),
        sa.Column("transcript", sa.JSON(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("action_items", sa.JSON(), nullable=False),
        sa.Column("cost_usd", sa.Float(), nullable=False),
        sa.ForeignKeyConstraint(["agent_id"], ["agents.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_meetings_agent_id", "meetings", ["agent_id"])


def downgrade() -> None:
    op.drop_index("ix_meetings_agent_id", table_name="meetings")
    op.drop_table("meetings")
