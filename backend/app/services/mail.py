"""Built-in email: threads, delivery, attachments, mailboxes, and agent wake-ups on new mail."""

import mimetypes
import re
import secrets
import shutil
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import utcnow
from app.models import Agent, Attachment, Message, Recipient, Thread
from app.services import infra


class MailError(ValueError):
    pass


MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
MAX_ATTACHMENTS_PER_MESSAGE = 10
WORKSPACE_ATTACHMENTS_DIR = "attachments"


def attachments_dir() -> Path:
    path = Path(get_settings().data_dir) / "attachments"
    path.mkdir(parents=True, exist_ok=True)
    return path


def safe_filename(name: str) -> str:
    name = Path(name or "file").name
    name = re.sub(r"[^A-Za-z0-9._ -]+", "_", name).strip(" .") or "file"
    return name[-120:]


async def store_attachment(db: AsyncSession, *, uploaded_by: str, filename: str, data: bytes,
                           content_type: str | None = None) -> Attachment:
    """Save an uploaded file. It stays unlinked until a message referencing it is sent."""
    if len(data) > MAX_ATTACHMENT_BYTES:
        raise MailError(f"attachments must be under {MAX_ATTACHMENT_BYTES // (1024 * 1024)} MB")
    filename = safe_filename(filename)
    content_type = (content_type or "").split(";")[0].strip() or mimetypes.guess_type(filename)[0] \
        or "application/octet-stream"
    storage_name = f"{secrets.token_hex(16)}{Path(filename).suffix[:16]}"
    (attachments_dir() / storage_name).write_bytes(data)
    att = Attachment(uploaded_by=uploaded_by, filename=filename, content_type=content_type, size=len(data),
                     storage_name=storage_name)
    db.add(att)
    await db.commit()
    await db.refresh(att)
    return att


def attachment_path(att: Attachment) -> Path:
    return attachments_dir() / att.storage_name


def workspace_name(att: Attachment) -> str:
    """Where an attachment appears inside an agent's workspace."""
    return f"{WORKSPACE_ATTACHMENTS_DIR}/{att.id}-{att.filename}"


def materialize(thread: Thread, workspace: Path) -> int:
    """Copy a thread's attachments into an agent workspace so its file tools can open them."""
    count = 0
    for m in thread.messages:
        for att in m.attachments:
            target = workspace / workspace_name(att)
            if not target.exists() and attachment_path(att).exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(attachment_path(att), target)
                count += 1
    return count


def agent_address(agent: Agent) -> str:
    return f"{agent.handle}@{get_settings().mail_domain}"


def system_addresses() -> set[str]:
    s = get_settings()
    return {s.manager_address, s.hr_address}


async def directory(db: AsyncSession, include_fired: bool = False) -> dict[str, dict]:
    """Address book: address -> {name, kind, agent_id}."""
    s = get_settings()
    book: dict[str, dict] = {
        s.manager_address: {"name": s.manager_name, "kind": "manager", "agent_id": None},
        s.hr_address: {"name": "HR (Performance)", "kind": "system", "agent_id": None},
    }
    q = select(Agent)
    if not include_fired:
        q = q.where(Agent.status == "active")
    for agent in (await db.scalars(q)).all():
        book[agent_address(agent)] = {"name": agent.name, "kind": "agent", "agent_id": agent.id}
    return book


async def _agent_by_address(db: AsyncSession, address: str) -> Agent | None:
    local, _, domain = address.partition("@")
    if domain != get_settings().mail_domain:
        return None
    return await db.scalar(select(Agent).where(Agent.handle == local))


async def send(
    db: AsyncSession,
    *,
    sender: str,
    to: list[str],
    subject: str | None = None,
    body: str,
    cc: list[str] | None = None,
    thread_id: int | None = None,
    project_id: int | None = None,
    attachment_ids: list[int] | None = None,
    wake_agents: bool = True,
) -> Message:
    """Create (or reply in) a thread and deliver to every recipient.

    Delivering to an active agent schedules a `respond_to_mail` run for that agent.
    """
    cc = cc or []
    book = await directory(db)
    recipients = [(a.strip().lower(), "to") for a in to] + [(a.strip().lower(), "cc") for a in cc]
    recipients = [(a, k) for a, k in dict(recipients).items() if a and a != sender]
    if not recipients:
        raise MailError("at least one recipient is required")
    attachments: list[Attachment] = []
    if attachment_ids:
        if len(attachment_ids) > MAX_ATTACHMENTS_PER_MESSAGE:
            raise MailError(f"at most {MAX_ATTACHMENTS_PER_MESSAGE} attachments per message")
        attachments = list((await db.scalars(select(Attachment).where(
            Attachment.id.in_(attachment_ids), Attachment.message_id.is_(None), Attachment.uploaded_by == sender,
        ))).all())
        if len(attachments) != len(set(attachment_ids)):
            raise MailError("unknown or already-sent attachment")
    if not body.strip() and not attachments:
        raise MailError("message is empty")
    unknown = [a for a, _ in recipients if a not in book]
    if unknown:
        raise MailError(f"unknown address(es): {', '.join(unknown)}")

    if thread_id is not None:
        thread = await db.get(Thread, thread_id)
        if thread is None:
            raise MailError(f"thread {thread_id} not found")
    else:
        if not subject:
            raise MailError("subject is required for a new thread")
        thread = Thread(subject=subject, project_id=project_id)
        db.add(thread)
        await db.flush()

    msg = Message(thread_id=thread.id, sender=sender, body=body)
    msg.recipients = [Recipient(address=a, kind=k) for a, k in recipients]
    msg.attachments = attachments
    db.add(msg)
    thread.updated_at = utcnow()
    await db.commit()
    await db.refresh(msg)

    await infra.publish(
        "mail",
        {"thread_id": thread.id, "message_id": msg.id, "sender": sender, "subject": thread.subject,
         "recipients": [a for a, _ in recipients]},
    )

    if wake_agents:
        hop_ok = await _within_hop_limit(db, thread.id)
        for address, _ in recipients:
            agent = await _agent_by_address(db, address)
            if agent and agent.is_active and hop_ok:
                await infra.enqueue(
                    "run_agent",
                    agent.id,
                    "mail",
                    {"thread_id": thread.id},
                    # One job per delivered message; the runtime skips it if an earlier run
                    # already read this message (see agents/runtime.py).
                    job_id=f"mail:{agent.id}:{thread.id}:{msg.id}",
                    defer_by=3,
                )
    return msg


async def _within_hop_limit(db: AsyncSession, thread_id: int) -> bool:
    """Guard against agents emailing each other forever: count agent-sent messages since the
    last message from a human/system address."""
    msgs = (await db.scalars(select(Message).where(Message.thread_id == thread_id).order_by(Message.id))).all()
    humans = system_addresses()
    streak = 0
    for m in msgs:
        streak = 0 if m.sender in humans else streak + 1
    return streak < get_settings().mail_agent_hop_limit


async def mailbox(db: AsyncSession, address: str, folder: str = "inbox") -> list[dict]:
    """Thread summaries for an address. folder: inbox | sent | archived."""
    if folder == "sent":
        thread_ids = select(Message.thread_id).where(Message.sender == address)
    else:
        thread_ids = (
            select(Message.thread_id)
            .join(Recipient)
            .where(Recipient.address == address, Recipient.archived == (1 if folder == "archived" else 0))
        )
    threads = (
        await db.scalars(select(Thread).where(Thread.id.in_(thread_ids)).order_by(Thread.updated_at.desc()).limit(200))
    ).all()
    book = await directory(db, include_fired=True)
    out = []
    for t in threads:
        last = t.messages[-1] if t.messages else None
        unread = sum(1 for m in t.messages for r in m.recipients if r.address == address and r.read_at is None)
        participants = {m.sender for m in t.messages} | {r.address for m in t.messages for r in m.recipients}
        out.append(
            {
                "id": t.id,
                "subject": t.subject,
                "project_id": t.project_id,
                "updated_at": t.updated_at,
                "message_count": len(t.messages),
                "unread": unread,
                "last_sender": last.sender if last else None,
                "last_sender_name": book.get(last.sender, {}).get("name") if last else None,
                "snippet": (last.body[:160] if last else ""),
                "attachment_count": sum(len(m.attachments) for m in t.messages),
                "participants": sorted(participants),
            }
        )
    return out


async def unread_count(db: AsyncSession, address: str) -> int:
    return await db.scalar(
        select(func.count(Recipient.id)).where(
            Recipient.address == address, Recipient.read_at.is_(None), Recipient.archived == 0
        )
    ) or 0


async def mark_read(db: AsyncSession, thread_id: int, address: str) -> None:
    rows = await db.scalars(
        select(Recipient).join(Message).where(
            Message.thread_id == thread_id, Recipient.address == address, Recipient.read_at.is_(None)
        )
    )
    now = utcnow()
    for r in rows:
        r.read_at = now
    await db.commit()


async def set_archived(db: AsyncSession, thread_id: int, address: str, archived: bool) -> None:
    rows = await db.scalars(
        select(Recipient).join(Message).where(Message.thread_id == thread_id, Recipient.address == address)
    )
    for r in rows:
        r.archived = 1 if archived else 0
    await db.commit()


def render_thread(thread: Thread, book: dict[str, dict]) -> str:
    """Plain-text rendering of a thread, used in agent prompts."""
    lines = [f"Thread #{thread.id}: {thread.subject}", ""]
    for m in thread.messages:
        to = ", ".join(r.address for r in m.recipients if r.kind == "to")
        cc = ", ".join(r.address for r in m.recipients if r.kind == "cc")
        name = book.get(m.sender, {}).get("name", m.sender)
        lines.append(f"--- Message #{m.id} | {m.created_at:%Y-%m-%d %H:%M} UTC")
        lines.append(f"From: {name} <{m.sender}>")
        lines.append(f"To: {to}" + (f"\nCc: {cc}" if cc else ""))
        lines.append("")
        lines.append(m.body)
        if m.attachments:
            lines.append("")
            lines.append("Attachments (open them with your Read tool — it can view images and PDFs):")
            for att in m.attachments:
                lines.append(f"- ./{workspace_name(att)} ({att.content_type}, {att.size // 1024 or 1} KB)")
        lines.append("")
    return "\n".join(lines)
