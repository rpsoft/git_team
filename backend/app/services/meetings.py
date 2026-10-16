"""Live 1:1 voice meetings between the manager and an agent.

Speech-to-text and text-to-speech happen in the browser; here each meeting keeps one open
Claude session (so the agent remembers the conversation) and streams its replies back
sentence by sentence. After the call, Claude writes a summary with action items and the
agent gets a follow-up task to actually do them.
"""

import asyncio
import json
import logging
import tempfile
import time
from collections.abc import AsyncIterator
from typing import Any

from claude_agent_sdk import (
    ClaudeAgentOptions,
    ClaudeSDKClient,
    ResultMessage,
    StreamEvent,
    query,
)
from sqlalchemy import select

from app.agents import prompts
from app.agents.tools import READ_ONLY_TOOLS, ToolContext, build_server
from app.config import get_settings
from app.db import SessionLocal, utcnow
from app.models import Agent, Meeting
from app.services import infra
from app.services.activity import record
from app.services.settings_store import feature_enabled

log = logging.getLogger(__name__)

IDLE_TIMEOUT = 20 * 60  # hang up calls nobody has spoken in for this long
SUMMARY_MODEL = "claude-haiku-4-5"

CALL_RULES = """
## You are on a live 1:1 voice call with your manager
Everything you write is read aloud by text-to-speech, so talk like a person on a call:
- Keep each reply short: usually one to three sentences. Be warm and natural; it's fine to show personality.
- Plain spoken words only: no markdown, bullet points, code, file paths, URLs or emoji. Say numbers naturally
  ("pull request eighteen").
- You can quickly look things up with your read-only tools (issues, pull requests, CI, your inbox) when asked
  about status. Don't narrate tool use; just answer.
- Don't take actions during the call (no code, issues or emails). Instead, agree on action items out loud —
  after the call you'll get a follow-up task to do them.
- If the manager wraps up or says goodbye, say a brief goodbye.
"""

CONNECT_PROMPT = ("(The call just connected. Greet your manager in one short, natural sentence, the way you'd "
                  "answer a 1:1 call. Don't ask more than one question.)")

SUMMARY_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string", "description": "3-5 sentence recap of the call"},
        "action_items": {"type": "array", "items": {"type": "string"},
                         "description": "Concrete things the agent agreed to do. Empty if none."},
    },
    "required": ["summary", "action_items"],
    "additionalProperties": False,
}


class MeetingError(RuntimeError):
    pass


class LiveMeeting:
    def __init__(self, meeting_id: int, agent_id: int, client: ClaudeSDKClient, workdir: tempfile.TemporaryDirectory):
        self.meeting_id = meeting_id
        self.agent_id = agent_id
        self.client = client
        self.workdir = workdir
        self.lock = asyncio.Lock()
        self.last_activity = time.monotonic()
        self.cost_usd = 0.0

    async def say(self, text: str | None) -> AsyncIterator[dict[str, Any]]:
        """Send what the manager said (None = call just connected) and stream the agent's reply.

        The Claude session is driven by a separate task that always runs to the end of the reply,
        so a dropped HTTP stream (e.g. the manager talks over the agent) never leaves it half-read.
        """
        if self.lock.locked():
            await self.interrupt()  # manager talked over the agent: cut the current reply short
        await self.lock.acquire()
        events: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        task = asyncio.create_task(self._turn(text, events))
        task.add_done_callback(lambda _: self.lock.release())
        while (event := await events.get()) is not None:
            yield event

    async def _turn(self, text: str | None, events: asyncio.Queue) -> None:
        reply: list[str] = []
        try:
            self.last_activity = time.monotonic()
            if text:
                await self._append("manager", text)
            await self.client.query(text or CONNECT_PROMPT)
            async for message in self.client.receive_response():
                if isinstance(message, StreamEvent):
                    ev = message.event
                    if message.parent_tool_use_id:
                        continue
                    if ev.get("type") == "content_block_delta" and ev.get("delta", {}).get("type") == "text_delta":
                        chunk = ev["delta"]["text"]
                        reply.append(chunk)
                        events.put_nowait({"type": "delta", "text": chunk})
                    elif ev.get("type") == "content_block_start" and \
                            ev.get("content_block", {}).get("type") in ("tool_use", "mcp_tool_use"):
                        events.put_nowait({"type": "tool", "name": ev["content_block"].get("name", "").split("__")[-1]})
                        if reply and not reply[-1].endswith((" ", "\n")):
                            reply.append(" ")
                elif isinstance(message, ResultMessage):
                    self.cost_usd += message.total_cost_usd or 0.0
            spoken = "".join(reply).strip()
            if spoken:
                await self._append("agent", spoken)
            events.put_nowait({"type": "done", "text": spoken})
        except Exception as exc:
            log.exception("meeting %s turn failed", self.meeting_id)
            events.put_nowait({"type": "error", "message": str(exc)})
        finally:
            self.last_activity = time.monotonic()
            events.put_nowait(None)

    async def interrupt(self) -> None:
        try:
            await self.client.interrupt()
        except Exception:
            log.debug("interrupt failed", exc_info=True)

    async def _append(self, speaker: str, text: str) -> None:
        async with SessionLocal() as db:
            meeting = await db.get(Meeting, self.meeting_id)
            meeting.transcript = [*meeting.transcript, {"speaker": speaker, "text": text, "at": utcnow().isoformat()}]
            await db.commit()

    async def close(self) -> None:
        try:
            await self.client.disconnect()
        finally:
            self.workdir.cleanup()


_live: dict[int, LiveMeeting] = {}


def get_live(meeting_id: int) -> LiveMeeting:
    live = _live.get(meeting_id)
    if live is None:
        raise MeetingError("this call has ended")
    return live


async def start(db, agent: Agent) -> Meeting:
    if not agent.is_active:
        raise MeetingError(f"{agent.name} is no longer on the team")
    if any(m.agent_id == agent.id for m in _live.values()):
        raise MeetingError(f"you're already on a call with {agent.name}")
    s = get_settings()
    projects = [m.project for m in agent.memberships if m.project.status != "archived"]
    teammates = (await db.scalars(select(Agent).where(Agent.status == "active"))).unique().all()
    system = prompts.system_prompt(agent, projects, list(teammates), morale_on=await feature_enabled(db, "morale"))
    server, names = build_server(ToolContext(
        agent_id=agent.id, handle=agent.handle, gitea_username=agent.gitea_username or "",
        token_enc=agent.gitea_token_enc or "", can_merge=False, repos={p.repo_name for p in projects},
    ), only=READ_ONLY_TOOLS)
    workdir = tempfile.TemporaryDirectory(prefix=f"call-{agent.handle}-")
    options = ClaudeAgentOptions(
        model=agent.model,
        effort="low",  # snappy conversation
        system_prompt=system + "\n" + CALL_RULES,
        tools=[],
        allowed_tools=names,
        mcp_servers={"studio": server},
        strict_mcp_config=True,
        setting_sources=[],
        include_partial_messages=True,
        cwd=workdir.name,
        max_turns=8,
        env=s.claude_env(),
    )
    client = ClaudeSDKClient(options=options)
    await client.connect()
    meeting = Meeting(agent_id=agent.id)
    db.add(meeting)
    await db.commit()
    await db.refresh(meeting)
    _live[meeting.id] = LiveMeeting(meeting.id, agent.id, client, workdir)
    await infra.publish("meeting", {"meeting_id": meeting.id, "agent_id": agent.id, "status": "started"})
    return meeting


async def end(meeting_id: int) -> Meeting:
    live = _live.pop(meeting_id, None)
    if live is not None:
        await live.close()
    async with SessionLocal() as db:
        meeting = await db.get(Meeting, meeting_id)
        if meeting is None:
            raise MeetingError("meeting not found")
        if meeting.ended_at is not None:
            return meeting
        meeting.ended_at = utcnow()
        meeting.cost_usd = live.cost_usd if live else 0.0
        await db.commit()
        agent = await db.get(Agent, meeting.agent_id)
        said_anything = any(t["speaker"] == "manager" for t in meeting.transcript)
        if said_anything:
            try:
                written = await summarize(agent, meeting.transcript)
                meeting.summary, meeting.action_items = written["summary"], written["action_items"][:12]
            except Exception as exc:
                log.exception("meeting summary failed")
                meeting.summary = f"(Summary unavailable: {exc})"
            await db.commit()
            minutes = max(1, round((meeting.ended_at - meeting.started_at).total_seconds() / 60))
            await record(db, "one_on_one", agent_id=agent.id, summary=f"1:1 with {agent.name} ({minutes} min)",
                         data={"meeting_id": meeting.id, "action_items": len(meeting.action_items)})
            if meeting.action_items and agent.is_active:
                await infra.enqueue("run_agent", agent.id, "meeting_followup", {"meeting_id": meeting.id},
                                    job_id=f"meeting:{meeting.id}")
        await infra.publish("meeting", {"meeting_id": meeting.id, "agent_id": agent.id, "status": "ended"})
        await db.refresh(meeting)
        return meeting


def render_transcript(transcript: list[dict[str, Any]], agent_name: str) -> str:
    who = {"manager": get_settings().manager_name, "agent": agent_name}
    return "\n".join(f"{who.get(t['speaker'], t['speaker'])}: {t['text']}" for t in transcript)


async def summarize(agent: Agent, transcript: list[dict[str, Any]]) -> dict[str, Any]:
    prompt = (
        f"Summarize this 1:1 call between a manager and {agent.name} ({agent.role.name}, an AI team member).\n"
        "List only action items that the agent explicitly agreed to (phrase them as instructions to the agent).\n\n"
        + render_transcript(transcript, agent.name)
    )
    options = ClaudeAgentOptions(
        model=SUMMARY_MODEL, effort="low", tools=[], setting_sources=[], max_turns=3,
        output_format={"type": "json_schema", "schema": SUMMARY_SCHEMA}, env=get_settings().claude_env(),
    )
    result: ResultMessage | None = None
    async for message in query(prompt=prompt, options=options):
        if isinstance(message, ResultMessage):
            result = message
    if result is None or result.is_error:
        raise MeetingError("summary generation failed")
    data = result.structured_output if isinstance(result.structured_output, dict) else json.loads(result.result or "")
    return {"summary": data["summary"], "action_items": list(data.get("action_items") or [])}


async def reap_idle() -> None:
    """Background loop: end calls that were abandoned (e.g. the browser tab closed)."""
    while True:
        await asyncio.sleep(60)
        now = time.monotonic()
        for meeting_id, live in list(_live.items()):
            if now - live.last_activity > IDLE_TIMEOUT and not live.lock.locked():
                try:
                    await end(meeting_id)
                except Exception:
                    log.exception("failed to end idle meeting %s", meeting_id)


async def end_all() -> None:
    for meeting_id in list(_live):
        try:
            await end(meeting_id)
        except Exception:
            log.exception("failed to end meeting %s on shutdown", meeting_id)
