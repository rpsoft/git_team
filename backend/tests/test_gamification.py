import hashlib
import hmac
import json

from app.config import get_settings
from app.services.gamification import rules
from tests.test_team_api import hire


def test_level_curve():
    assert rules.level_for_xp(0) == 1
    assert rules.level_for_xp(99) == 1
    assert rules.level_for_xp(100) == 2
    assert rules.level_for_xp(rules.xp_threshold(5)) == 5
    assert rules.morale_band(90) == "thriving" and rules.morale_band(10) == "burned out"


def sign(body: bytes) -> str:
    return hmac.new(get_settings().gitea_webhook_secret.encode(), body, hashlib.sha256).hexdigest()


async def webhook(client, event: str, payload: dict):
    body = json.dumps(payload).encode()
    return await client.post("/api/webhooks/gitea", content=body,
                             headers={"X-Gitea-Event-Type": event, "X-Gitea-Signature": sign(body),
                                      "Content-Type": "application/json"})


def pr_payload(action, author="ada", sender="lead", merged=False, **extra):
    return {"action": action, "repository": {"name": "web-shop"}, "sender": {"login": sender},
            "pull_request": {"number": 7, "title": "Cart", "user": {"login": author}, "merged": merged,
                             "head": {"sha": "abc"}}, **extra}


async def test_webhook_rejects_bad_signature(client):
    r = await client.post("/api/webhooks/gitea", content=b"{}", headers={"X-Gitea-Signature": "nope"})
    assert r.status_code == 401


async def test_merge_awards_xp_and_achievement(client, bus):
    ada = await hire(client)
    r = await webhook(client, "pull_request", pr_payload("closed", merged=True))
    assert r.status_code == 200
    agent = (await client.get(f"/api/agents/{ada['id']}")).json()
    assert agent["xp"] == rules.XP_RULES["pr_merged"]
    assert [a["key"] for a in agent["achievements"]] == ["first_merge"]
    assert agent["morale"] == 75 + rules.MORALE_RULES["pr_merged"]
    assert any(e[0] == "toast" for e in bus["events"])

    board = (await client.get("/api/leaderboard?metric=pr_merged")).json()
    assert board[0]["handle"] == "ada" and board[0]["score"] == 1


async def test_features_off_means_no_xp_or_morale(client):
    ada = await hire(client)
    await client.patch("/api/settings", json={"feature_xp": False, "feature_morale": False})
    await webhook(client, "pull_request", pr_payload("closed", merged=True))
    agent = (await client.get(f"/api/agents/{ada['id']}")).json()
    assert agent["xp"] == 0 and agent["achievements"] == [] and agent["morale"] == 75


async def test_changes_requested_hurts_morale_and_wakes_author(client, bus):
    ada = await hire(client)
    lead = await hire(client, "Lin", "lead", role_slug="tech-lead")
    project = (await client.post("/api/projects", json={"name": "Web Shop"})).json()
    await client.post(f"/api/projects/{project['id']}/members", json={"agent_id": ada["id"]})
    bus["jobs"].clear()

    await webhook(client, "pull_request_review_rejected", pr_payload("reviewed", review={"content": "Add tests"}))
    ada_now = (await client.get(f"/api/agents/{ada['id']}")).json()
    lead_now = (await client.get(f"/api/agents/{lead['id']}")).json()
    assert ada_now["morale"] == round(75 + rules.MORALE_RULES["pr_changes_requested"] * rules.MORALE_DROP_SCALE)
    assert lead_now["xp"] == rules.XP_RULES["review_submitted"]
    wake = [j for j in bus["jobs"] if j[0] == "run_agent"]
    assert len(wake) == 1 and wake[0][1][0] == ada["id"] and wake[0][1][1] == "review_feedback"
    assert wake[0][1][2]["review"] == "Add tests"


async def test_review_request_and_mentions_wake_agents_but_not_self(client, bus):
    ada = await hire(client)
    lead = await hire(client, "Lin", "lead", role_slug="tech-lead")
    bus["jobs"].clear()
    await webhook(client, "pull_request_review_request",
                  pr_payload("review_requested", sender="ada", requested_reviewer={"login": "lead"}))
    await webhook(client, "issue_comment", {
        "action": "created", "repository": {"name": "web-shop"}, "sender": {"login": "lead"},
        "issue": {"number": 2, "assignees": [{"login": "lead"}], "user": {"login": "lead"}},
        "comment": {"id": 99, "body": "@ada can you look?"},
    })
    woken = [(j[1][0], j[1][1]) for j in bus["jobs"] if j[0] == "run_agent"]
    assert (lead["id"], "review_requested") in woken
    assert (ada["id"], "comment") in woken
    assert (lead["id"], "comment") not in woken, "the commenter isn't woken by their own comment"


async def test_kudos(client):
    ada = await hire(client)
    r = await client.post(f"/api/agents/{ada['id']}/kudos", json={"message": "Great work!"})
    assert r.status_code == 200
    assert r.json()["xp"] == rules.XP_RULES["kudos"]


async def test_performance_reviews_are_mailed_to_manager(client, db, monkeypatch):
    from app.services.gamification import reviews

    ada = await hire(client)
    await webhook(client, "pull_request", pr_payload("closed", merged=True))
    seen = {}

    async def fake_write(agent, metrics, highlights, morale_on):
        seen.update(metrics=metrics, highlights=highlights)
        return {"rating": 4, "recommendation": "promote", "summary": "Shipped the cart."}

    monkeypatch.setattr(reviews, "_write_review", fake_write)
    created = await reviews.run_reviews(db)
    assert len(created) == 1 and created[0].recommendation == "promote"
    assert seen["metrics"]["prs_merged"] == 1
    assert any("merged" in h for h in seen["highlights"])

    listed = (await client.get(f"/api/reviews?agent_id={ada['id']}")).json()
    assert listed[0]["rating"] == 4
    inbox = (await client.get("/api/mail/threads")).json()
    assert inbox[0]["subject"].startswith("Performance reviews") and inbox[0]["last_sender"] == "hr@team.local"

    await client.patch("/api/settings", json={"feature_leaderboard": False})
    assert await reviews.run_reviews(db) == []


async def test_ci_completion_wakes_author_and_watchers(client, fake_gitea, bus):
    from app.services import infra

    dev = await hire(client)                                   # backend dev, can't merge
    lead = await hire(client, "Lin", "lead", role_slug="tech-lead")
    pr = {"number": 18, "title": "Align nvmrc", "user": {"login": "ada"}, "head": {"sha": "abc", "ref": "b"}}
    fake_gitea.pulls["web-shop"] = [pr]
    status_evt = {"repository": {"name": "web-shop"}, "sender": {"login": "gitea-actions"}, "sha": "abc",
                  "state": "success", "context": "CI / check"}

    # Other jobs still running -> nothing happens yet.
    fake_gitea.statuses["abc"] = {"state": "pending", "statuses": []}
    await infra.add_ci_watcher("web-shop", "abc", lead["id"])  # lead said "I'll merge once green"
    bus["jobs"].clear()
    await webhook(client, "status", status_evt)
    assert bus["jobs"] == []

    # All green: the waiting lead is woken; the author can't merge, so isn't.
    fake_gitea.statuses["abc"] = {"state": "success", "statuses": [{"context": "CI / check", "status": "success"}]}
    await webhook(client, "status", status_evt)
    woken = [(j[1][0], j[1][1], j[1][2]["state"]) for j in bus["jobs"] if j[0] == "run_agent"]
    assert woken == [(lead["id"], "ci_finished", "success")]

    # A failure always goes back to the author.
    bus["jobs"].clear()
    fake_gitea.statuses["abc"] = {"state": "failure", "statuses": [{"context": "CI / check", "status": "failure"}]}
    await webhook(client, "status", {**status_evt, "state": "failure"})
    woken = [(j[1][0], j[1][2]["state"]) for j in bus["jobs"] if j[0] == "run_agent"]
    assert woken == [(dev["id"], "failure")]


async def test_restore_morale_lifts_low_agents_only(client, db):
    from app.models import Agent

    low, high = await hire(client), await hire(client, "Lin", "lin")
    for agent_id, value in ((low["id"], 9), (high["id"], 90)):
        (await db.get(Agent, agent_id)).morale = value
    await db.commit()

    r = (await client.post("/api/agents/restore-morale")).json()
    assert r == {"restored": 1, "morale": 75}
    assert (await client.get(f"/api/agents/{low['id']}")).json()["morale"] == 75
    assert (await client.get(f"/api/agents/{high['id']}")).json()["morale"] == 90
