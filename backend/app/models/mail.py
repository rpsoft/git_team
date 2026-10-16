from datetime import datetime

from sqlalchemy import ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base, utcnow


class Thread(Base):
    __tablename__ = "mail_threads"

    id: Mapped[int] = mapped_column(primary_key=True)
    subject: Mapped[str] = mapped_column(String(512))
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow)

    messages: Mapped[list["Message"]] = relationship(
        back_populates="thread", order_by="Message.id", lazy="selectin", cascade="all, delete-orphan"
    )


class Message(Base):
    __tablename__ = "mail_messages"

    id: Mapped[int] = mapped_column(primary_key=True)
    thread_id: Mapped[int] = mapped_column(ForeignKey("mail_threads.id", ondelete="CASCADE"))
    sender: Mapped[str] = mapped_column(String(256))
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)

    thread: Mapped[Thread] = relationship(back_populates="messages")
    recipients: Mapped[list["Recipient"]] = relationship(
        back_populates="message", lazy="selectin", cascade="all, delete-orphan"
    )
    attachments: Mapped[list["Attachment"]] = relationship(
        back_populates="message", lazy="selectin", order_by="Attachment.id"
    )


class Recipient(Base):
    """Per-recipient delivery state. Mailbox = all Recipient rows for an address (+ sent items)."""

    __tablename__ = "mail_recipients"

    id: Mapped[int] = mapped_column(primary_key=True)
    message_id: Mapped[int] = mapped_column(ForeignKey("mail_messages.id", ondelete="CASCADE"))
    address: Mapped[str] = mapped_column(String(256), index=True)
    kind: Mapped[str] = mapped_column(String(4), default="to")  # to | cc
    read_at: Mapped[datetime | None] = mapped_column(nullable=True)
    archived: Mapped[int] = mapped_column(Integer, default=0)

    message: Mapped[Message] = relationship(back_populates="recipients")


class Attachment(Base):
    """A file uploaded for a message. Uploaded first (message_id NULL), linked when the mail is sent."""

    __tablename__ = "mail_attachments"

    id: Mapped[int] = mapped_column(primary_key=True)
    message_id: Mapped[int | None] = mapped_column(
        ForeignKey("mail_messages.id", ondelete="CASCADE"), nullable=True, index=True
    )
    uploaded_by: Mapped[str] = mapped_column(String(256))
    filename: Mapped[str] = mapped_column(String(256))
    content_type: Mapped[str] = mapped_column(String(128))
    size: Mapped[int] = mapped_column(Integer)
    storage_name: Mapped[str] = mapped_column(String(128))
    created_at: Mapped[datetime] = mapped_column(default=utcnow)

    message: Mapped[Message | None] = relationship(back_populates="attachments")

    @property
    def is_image(self) -> bool:
        return self.content_type in ("image/png", "image/jpeg", "image/gif", "image/webp")
