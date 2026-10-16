"""mail attachments

Revision ID: b2a1c0de0001
Revises: df71982c98b2
Create Date: 2026-10-05
"""
from alembic import op
import sqlalchemy as sa

revision = "b2a1c0de0001"
down_revision = "df71982c98b2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "mail_attachments",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("message_id", sa.Integer(), nullable=True),
        sa.Column("uploaded_by", sa.String(length=256), nullable=False),
        sa.Column("filename", sa.String(length=256), nullable=False),
        sa.Column("content_type", sa.String(length=128), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("storage_name", sa.String(length=128), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["message_id"], ["mail_messages.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_mail_attachments_message_id", "mail_attachments", ["message_id"])


def downgrade() -> None:
    op.drop_index("ix_mail_attachments_message_id", table_name="mail_attachments")
    op.drop_table("mail_attachments")
