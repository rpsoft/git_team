from app.agents.runtime import build_context
from app.config import get_settings
from app.models import Agent
from tests.test_team_api import hire


async def test_manager_mail_wakes_agent_and_threads(client, bus):
    ada = await hire(client)
    bus["jobs"].clear()
    r = await client.post("/api/mail/send", json={"to": ["ada@team.local"], "subject": "Hello", "body": "Hi Ada"})
    assert r.status_code == 201, r.text
    thread_id = (await client.get("/api/mail/threads?folder=sent")).json()[0]["id"]
    assert bus["jobs"] == [("run_agent", (ada["id"], "mail", {"thread_id": thread_id}),
                            f"mail:{ada['id']}:{thread_id}:{r.json()['id']}")]

    # agent's mailbox (peek) shows the unread thread
    peek = (await client.get("/api/mail/threads?address=ada@team.local")).json()
    assert peek[0]["unread"] == 1 and peek[0]["subject"] == "Hello"

    # reply in thread keeps the subject; unknown recipients are rejected
    r = await client.post("/api/mail/send", json={"to": ["ada@team.local"], "body": "PS", "thread_id": thread_id})
    assert r.status_code == 201
    thread = (await client.get(f"/api/mail/threads/{thread_id}")).json()
    assert thread["subject"] == "Hello" and len(thread["messages"]) == 2
    bad = await client.post("/api/mail/send", json={"to": ["nobody@team.local"], "subject": "x", "body": "y"})
    assert bad.status_code == 400


async def test_mail_run_skips_when_already_read(client, db):
    ada = await hire(client)
    await client.post("/api/mail/send", json={"to": ["ada@team.local"], "subject": "Task", "body": "Do X"})
    thread_id = (await client.get("/api/mail/threads?folder=sent")).json()[0]["id"]
    agent = await db.get(Agent, ada["id"])

    first = await build_context(db, agent, "mail", {"thread_id": thread_id})
    assert first is not None and "Do X" in first[1]
    # A second job for the same (already consumed) message does nothing.
    assert await build_context(db, agent, "mail", {"thread_id": thread_id}) is None


async def test_agent_ping_pong_is_capped(client, db, bus):
    from app.services import mail

    await hire(client)
    await hire(client, "Bob", "bob")
    limit = get_settings().mail_agent_hop_limit
    msg = await mail.send(db, sender="ada@team.local", to=["bob@team.local"], subject="loop", body="0")
    for i in range(limit + 3):
        sender, to = ("bob", "ada") if i % 2 == 0 else ("ada", "bob")
        bus["jobs"].clear()
        await mail.send(db, sender=f"{sender}@team.local", to=[f"{to}@team.local"], body=str(i),
                        thread_id=msg.thread_id)
    assert bus["jobs"] == [], "agents stop waking each other after the hop limit"

    # A human message resets the counter.
    await mail.send(db, sender="manager@team.local", to=["ada@team.local"], body="stop", thread_id=msg.thread_id)
    assert len(bus["jobs"]) == 1
