import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select

from app.api.deps import DB, AgentDep
from app.models import Meeting
from app.schemas import MeetingOut
from app.services import meetings

router = APIRouter()


class SayIn(BaseModel):
    text: str | None = None  # None = the call just connected (agent greets you)


@router.post("/agents/{agent_id}/meetings", response_model=MeetingOut, status_code=201)
async def start_meeting(agent: AgentDep, db: DB):
    try:
        return await meetings.start(db, agent)
    except meetings.MeetingError as e:
        raise HTTPException(409, str(e))


@router.post("/meetings/{meeting_id}/say")
async def say(meeting_id: int, body: SayIn):
    """Streams the agent's reply as NDJSON: {"type": "delta"|"tool"|"done"|"error", ...} per line."""
    try:
        live = meetings.get_live(meeting_id)
    except meetings.MeetingError as e:
        raise HTTPException(410, str(e))
    text = (body.text or "").strip() or None

    async def stream():
        async for event in live.say(text):
            yield json.dumps(event) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/meetings/{meeting_id}/interrupt")
async def interrupt(meeting_id: int):
    try:
        await meetings.get_live(meeting_id).interrupt()
    except meetings.MeetingError:
        pass
    return {"ok": True}


@router.post("/meetings/{meeting_id}/end", response_model=MeetingOut)
async def end_meeting(meeting_id: int):
    try:
        return await meetings.end(meeting_id)
    except meetings.MeetingError as e:
        raise HTTPException(404, str(e))


@router.get("/meetings", response_model=list[MeetingOut])
async def list_meetings(db: DB, agent_id: int | None = None, limit: int = 50):
    q = select(Meeting).order_by(Meeting.id.desc()).limit(limit)
    if agent_id:
        q = q.where(Meeting.agent_id == agent_id)
    return (await db.scalars(q)).all()


@router.get("/meetings/{meeting_id}", response_model=MeetingOut)
async def get_meeting(meeting_id: int, db: DB):
    m = await db.get(Meeting, meeting_id)
    if m is None:
        raise HTTPException(404, "meeting not found")
    return m
