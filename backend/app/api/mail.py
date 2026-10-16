from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.api.deps import DB
from app.config import get_settings
from app.models import Attachment, Thread
from app.schemas import AttachmentOut, MessageOut, SendMailIn, ThreadOut
from app.services import mail

router = APIRouter(prefix="/mail")


def me() -> str:
    return get_settings().manager_address


@router.get("/directory")
async def directory(db: DB):
    return [{"address": a, **info} for a, info in (await mail.directory(db)).items() if a != me()]


@router.get("/threads")
async def threads(db: DB, folder: str = "inbox", address: str | None = None):
    """The manager's mailbox, or (read-only) any agent's mailbox via `address`."""
    return await mail.mailbox(db, address or me(), folder)


@router.get("/unread")
async def unread(db: DB):
    return {"count": await mail.unread_count(db, me())}


@router.get("/threads/{thread_id}", response_model=ThreadOut)
async def thread(thread_id: int, db: DB):
    t = await db.get(Thread, thread_id)
    if t is None:
        raise HTTPException(404, "thread not found")
    await mail.mark_read(db, thread_id, me())
    await db.refresh(t)
    return ThreadOut(id=t.id, subject=t.subject, project_id=t.project_id,
                     messages=[MessageOut.model_validate(m) for m in t.messages])


@router.post("/send", response_model=MessageOut, status_code=201)
async def send(body: SendMailIn, db: DB):
    try:
        return await mail.send(db, sender=me(), **body.model_dump())
    except mail.MailError as e:
        raise HTTPException(400, str(e))


class ArchiveIn(BaseModel):
    archived: bool = True


@router.post("/threads/{thread_id}/archive")
async def archive(thread_id: int, body: ArchiveIn, db: DB):
    await mail.set_archived(db, thread_id, me(), body.archived)
    return {"ok": True}


# Served inline only for types that can't run script in the browser; everything else downloads.
INLINE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"}


@router.post("/attachments", response_model=AttachmentOut, status_code=201)
async def upload_attachment(file: UploadFile, db: DB):
    data = await file.read(mail.MAX_ATTACHMENT_BYTES + 1)
    try:
        return await mail.store_attachment(db, uploaded_by=me(), filename=file.filename or "file", data=data,
                                           content_type=file.content_type)
    except mail.MailError as e:
        raise HTTPException(413, str(e))


@router.get("/attachments/{attachment_id}/{filename}")
async def download_attachment(attachment_id: int, filename: str, db: DB):
    att = await db.get(Attachment, attachment_id)
    if att is None or not mail.attachment_path(att).exists():
        raise HTTPException(404, "attachment not found")
    inline = att.content_type in INLINE_TYPES
    return FileResponse(
        mail.attachment_path(att), media_type=att.content_type, filename=att.filename,
        content_disposition_type="inline" if inline else "attachment",
        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=86400",
                 # Browsers' PDF viewers don't work in a sandbox; every other type gets one.
                 **({} if att.content_type == "application/pdf"
                    else {"Content-Security-Policy": "default-src 'none'; img-src 'self'; sandbox"})},
    )
