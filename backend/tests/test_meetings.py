import json

from claude_agent_sdk import ResultMessage, StreamEvent

from app.db import SessionLocal
from app.models import ActivityEvent, Meeting
from app.services import meetings
from tests.test_team_api import hire


class FakeClient:
    """Stands in for ClaudeSDKClient: replies 'Hi boss.' then echoes."""

    instances: list["FakeClient"] = []

    def __init__(self, options):
        self.options = options
        self.prompts: list[str] = []
        FakeClient.instances.append(self)

    async def connect(self):
        pass

    async def disconnect(self):
        pass

    async def interrupt(self):
        pass

    async def query(self, prompt):
        self.prompts.append(prompt)

    async def receive_response(self):
        text = "Hi boss." if len(self.prompts) == 1 else f"Sure, I'll {self.prompts[-1].lower()}"
        for word in text.split(" "):
            yield StreamEvent(uuid="u", session_id="s", event={
                "type": "content_block_delta", "delta": {"type": "text_delta", "text": word + " "}})
        yield ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False, num_turns=1,
                            session_id="s", total_cost_usd=0.01)


async def test_meeting_flow(client, monkeypatch, bus):
    monkeypatch.setattr(meetings, "ClaudeSDKClient", FakeClient)

    async def fake_summary(agent, transcript):
        return {"summary": "Talked about tests.", "action_items": ["Write the tests"]}

    monkeypatch.setattr(meetings, "summarize", fake_summary)
    ada = await hire(client)

    r = await client.post(f"/api/agents/{ada['id']}/meetings")
    assert r.status_code == 201, r.text
    meeting_id = r.json()["id"]
    assert r.json()["live"] is True
    opts = FakeClient.instances[-1].options
    assert "live 1:1 voice call" in opts.system_prompt and opts.tools == []
    assert "mcp__studio__send_email" not in opts.allowed_tools, "no side effects during a call"
    assert "mcp__studio__list_issues" in opts.allowed_tools

    # a second simultaneous call with the same agent is refused
    assert (await client.post(f"/api/agents/{ada['id']}/meetings")).status_code == 409

    async def say(text):
        r = await client.post(f"/api/meetings/{meeting_id}/say", json={"text": text})
        assert r.status_code == 200
        return [json.loads(line) for line in r.text.splitlines()]

    greeting = await say(None)
    assert greeting[-1] == {"type": "done", "text": "Hi boss."}
    reply = await say("Write the tests")
    assert reply[-1]["text"] == "Sure, I'll write the tests"
    assert all(e["type"] == "delta" for e in reply[:-1])

    ended = (await client.post(f"/api/meetings/{meeting_id}/end")).json()
    assert ended["live"] is False and ended["action_items"] == ["Write the tests"]
    assert [t["speaker"] for t in ended["transcript"]] == ["agent", "manager", "agent"]
    assert ended["cost_usd"] == 0.02
    assert ("run_agent", (ada["id"], "meeting_followup", {"meeting_id": meeting_id}),
            f"meeting:{meeting_id}") in bus["jobs"]
    assert (await client.post(f"/api/meetings/{meeting_id}/say", json={"text": "hello?"})).status_code == 410

    agent = (await client.get(f"/api/agents/{ada['id']}")).json()
    assert agent["morale"] == 75 + 3
    listed = (await client.get(f"/api/meetings?agent_id={ada['id']}")).json()
    assert listed[0]["summary"] == "Talked about tests."


async def test_hanging_up_without_talking_records_nothing(client, monkeypatch, bus):
    monkeypatch.setattr(meetings, "ClaudeSDKClient", FakeClient)
    ada = await hire(client)
    meeting_id = (await client.post(f"/api/agents/{ada['id']}/meetings")).json()["id"]
    await client.post(f"/api/meetings/{meeting_id}/end")
    async with SessionLocal() as db:
        m = await db.get(Meeting, meeting_id)
        assert m.ended_at is not None and m.summary == ""
        from sqlalchemy import select
        assert "one_on_one" not in (await db.scalars(select(ActivityEvent.kind))).all()
    assert not any(j[1][1] == "meeting_followup" for j in bus["jobs"] if j[0] == "run_agent")
