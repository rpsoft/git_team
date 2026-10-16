from datetime import timedelta

from app.db import utcnow
from app.models import AgentTask
from app.services import standup
from tests.test_team_api import hire


async def staff(client, fake_gitea):
    ada = await hire(client)  # backend dev: ada
    lead = await hire(client, "Lin", "lead", role_slug="tech-lead")
    project = (await client.post("/api/projects", json={"name": "Web Shop"})).json()
    for a in (ada, lead):
        await client.post(f"/api/projects/{project['id']}/members", json={"agent_id": a["id"]})
    return ada, lead


async def test_idle_agents_get_their_queue(client, db, fake_gitea, bus):
    ada, lead = await staff(client, fake_gitea)
    fake_gitea.issues["web-shop"] = [
        {"number": 3, "title": "Cart", "state": "open", "assignees": [{"login": "ada"}], "labels": []}]
    fake_gitea.pulls["web-shop"] = [
        {"number": 7, "title": "Checkout", "user": {"login": "ada"}, "head": {"sha": "s7", "ref": "b7"},
         "requested_reviewers": [{"login": "lead"}]},
        {"number": 8, "title": "Search", "user": {"login": "ada"}, "head": {"sha": "s8", "ref": "b8"},
         "requested_reviewers": []},
    ]
    fake_gitea.statuses["s8"] = {"state": "failure", "statuses": []}
    fake_gitea.statuses["s7"] = {"state": "success", "statuses": []}
    fake_gitea.reviews[7] = [{"user": {"login": "lead"}, "state": "APPROVED"}]

    bus["jobs"].clear()
    woken = await standup.run(db)
    assert sorted(woken) == sorted([ada["id"], lead["id"]])
    queues = {j[1][0]: j[1][2]["queue"] for j in bus["jobs"] if j[0] == "run_agent" and j[1][1] == "next_work"}
    assert [(i["kind"], i["ref"]) for i in queues[ada["id"]]] == [("fix_pr", "web-shop#8"), ("issue", "web-shop#3")]
    assert [(i["kind"], i["ref"]) for i in queues[lead["id"]]] == [("review", "web-shop#7")]
    assert "Your PR needs work" in standup.render_queue(queues[ada["id"]])


async def test_busy_broke_or_paused_agents_are_left_alone(client, db, fake_gitea, bus):
    ada, lead = await staff(client, fake_gitea)
    fake_gitea.issues["web-shop"] = [
        {"number": 3, "title": "Cart", "state": "open", "assignees": [{"login": "ada"}, {"login": "lead"}], "labels": []}]
    db.add(AgentTask(agent_id=ada["id"], trigger="mail", status="succeeded", cost_usd=9.9,
                     finished_at=utcnow() - timedelta(hours=1)))  # out of budget
    db.add(AgentTask(agent_id=lead["id"], trigger="mail", status="succeeded",
                     finished_at=utcnow() - timedelta(minutes=2)))  # just finished something
    await db.commit()
    assert await standup.run(db) == []

    await client.patch("/api/settings", json={"agents_paused": True})
    assert await standup.run(db) == []


async def test_backs_off_when_no_progress(client, db, fake_gitea, bus):
    ada, _ = await staff(client, fake_gitea)
    fake_gitea.issues["web-shop"] = [
        {"number": 3, "title": "Cart", "state": "open", "assignees": [{"login": "ada"}], "labels": []}]
    for minutes in (40, 20):
        db.add(AgentTask(agent_id=ada["id"], trigger="next_work", status="succeeded",
                         started_at=utcnow() - timedelta(minutes=minutes),
                         finished_at=utcnow() - timedelta(minutes=minutes - 5)))
    await db.commit()
    assert ada["id"] not in await standup.run(db), "two fruitless standups -> back off"


async def test_budget_exhaustion_emails_manager_once(client, db, bus):
    from app.agents import runtime
    from app.models import Agent

    ada = await hire(client)
    agent = await db.get(Agent, ada["id"])
    await runtime.notify_budget_exhausted(db, agent, 10.03)
    await runtime.notify_budget_exhausted(db, agent, 10.50)
    inbox = (await client.get("/api/mail/threads")).json()
    budget_mails = [t for t in inbox if "out of budget" in t["subject"]]
    assert len(budget_mails) == 1 and budget_mails[0]["last_sender"] == "hr@team.local"
