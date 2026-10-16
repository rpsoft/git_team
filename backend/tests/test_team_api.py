from sqlalchemy import select

from app.db import SessionLocal
from app.models import ActivityEvent


async def hire(client, name="Ada Lovelace", handle="ada", role_slug="backend-developer"):
    roles = (await client.get("/api/roles")).json()
    role = next(r for r in roles if r["slug"] == role_slug)
    r = await client.post("/api/agents", json={"name": name, "handle": handle, "role_id": role["id"],
                                               "traits": ["meticulous"]})
    assert r.status_code == 201, r.text
    return r.json()


async def test_requires_login(db_setup, fake_gitea, bus):
    from httpx import ASGITransport, AsyncClient

    from app.main import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        assert (await c.get("/api/agents")).status_code == 401
        assert (await c.post("/api/auth/login", json={"username": "manager", "password": "nope"})).status_code == 401


async def test_hire_provisions_gitea_and_sends_welcome(client, fake_gitea, bus):
    agent = await hire(client)
    assert agent["handle"] == "ada"
    assert agent["email"] == "ada@team.local"
    assert agent["gitea_username"] == "ada"
    assert agent["level"] == 1 and agent["xp"] == 0
    assert agent["responsibilities"], "defaults to the role's responsibilities"
    assert fake_gitea.users["ada"]["active"] is True
    assert ("run_agent", (agent["id"], "welcome", {}), f"welcome:{agent['id']}") in bus["jobs"]

    dup = await client.post("/api/agents", json={"name": "Other", "handle": "ada", "role_id": agent["role"]["id"]})
    assert dup.status_code == 400


async def test_project_staffing_and_firing_with_handover(client, fake_gitea, bus):
    ada = await hire(client)
    bob = await hire(client, "Bob", "bob")
    project = (await client.post("/api/projects", json={"name": "Web Shop", "description": "Sell things"})).json()
    assert project["repo_name"] == "web-shop"
    assert "web-shop" in fake_gitea.repos

    for agent in (ada, bob):
        r = await client.post(f"/api/projects/{project['id']}/members", json={"agent_id": agent["id"]})
        assert r.status_code == 200, r.text
    assert fake_gitea.collaborators["web-shop"] == {"ada", "bob"}
    assert any(j[0] == "run_agent" and j[1][1] == "kickoff" for j in bus["jobs"])

    again = await client.post(f"/api/projects/{project['id']}/members", json={"agent_id": ada["id"]})
    assert again.status_code == 400

    fake_gitea.issues["web-shop"] = [{"number": 3, "title": "Cart", "state": "open", "assignees": [{"login": "ada"}]}]
    r = await client.post(f"/api/agents/{ada['id']}/fire", json={"reassign_to": bob["id"], "reason": "budget"})
    assert r.status_code == 200, r.text
    assert r.json()["handed_over"] == ["web-shop#3"]
    assert fake_gitea.issues["web-shop"][0]["assignees"] == [{"login": "bob"}]
    assert fake_gitea.users["ada"]["active"] is False
    assert "ada" not in fake_gitea.collaborators["web-shop"]

    fired = (await client.get(f"/api/agents/{ada['id']}")).json()
    assert fired["status"] == "fired" and fired["projects"] == []
    active = (await client.get("/api/agents")).json()
    assert [a["handle"] for a in active] == ["bob"]

    # Bob got a handover email, which wakes him up.
    assert any(j[0] == "run_agent" and j[1][0] == bob["id"] and j[1][1] == "mail" for j in bus["jobs"])

    async with SessionLocal() as db:
        kinds = (await db.scalars(select(ActivityEvent.kind))).all()
    assert {"hired", "project_created", "assigned", "fired"} <= set(kinds)


async def test_settings_toggle(client):
    s = (await client.get("/api/settings")).json()
    assert s["feature_xp"] is True
    s = (await client.patch("/api/settings", json={"feature_xp": False})).json()
    assert s["feature_xp"] is False
    assert (await client.patch("/api/settings", json={"gitea_admin_token": "x"})).status_code == 400


async def test_leaderboard_disabled_returns_404(client):
    await client.patch("/api/settings", json={"feature_leaderboard": False})
    assert (await client.get("/api/leaderboard")).status_code == 404


async def test_generate_profile(client, monkeypatch):
    from app.services import profiles

    seen = {}

    async def fake_generate(role, traits, taken):
        seen.update(role=role.slug, traits=traits, taken=taken)
        return {"name": "Mei Tanaka", "bio": "Ex-game developer."}

    monkeypatch.setattr(profiles, "generate", fake_generate)
    await hire(client)
    roles = (await client.get("/api/roles")).json()
    r = await client.post("/api/agents/generate-profile", json={"role_id": roles[0]["id"], "traits": ["fast"]})
    assert r.status_code == 200 and r.json()["name"] == "Mei Tanaka"
    assert seen == {"role": roles[0]["slug"], "traits": ["fast"], "taken": ["Ada Lovelace"]}
    assert (await client.post("/api/agents/generate-profile", json={"role_id": 999})).status_code == 404


async def test_voice_settings(client):
    ada = await hire(client)
    assert ada["voice_type"] == "any" and ada["voice_name"] is None
    r = await client.patch(f"/api/agents/{ada['id']}", json={"voice_type": "feminine", "voice_name": "Google UK English Female"})
    assert r.json()["voice_type"] == "feminine" and r.json()["voice_name"] == "Google UK English Female"
    assert (await client.patch(f"/api/agents/{ada['id']}", json={"voice_type": "robot"})).status_code == 422


async def test_voice_speed_setting(client):
    assert (await client.get("/api/settings")).json()["voice_speed"] == 1.15
    assert (await client.patch("/api/settings", json={"voice_speed": 1.3})).json()["voice_speed"] == 1.3
    assert (await client.patch("/api/settings", json={"voice_speed": 3})).status_code == 400


async def test_working_indicator_names_the_project(client, db):
    from app.models import AgentTask, Thread

    ada = await hire(client)
    bob = await hire(client, "Bob", "bob")
    cleo = await hire(client, "Cleo", "cleo")
    project = (await client.post("/api/projects", json={"name": "Web Shop"})).json()
    thread = Thread(subject="Plan", project_id=project["id"])
    db.add(thread)
    await db.flush()
    db.add_all([
        AgentTask(agent_id=ada["id"], trigger="issue_assigned", trigger_ref={"repo": "web-shop", "number": 1}),
        AgentTask(agent_id=bob["id"], trigger="mail", trigger_ref={"thread_id": thread.id}),
        AgentTask(agent_id=cleo["id"], trigger="nudge", trigger_ref={"instruction": "hi"}),
    ])
    await db.commit()
    agents = {a["handle"]: a for a in (await client.get("/api/agents")).json()}
    assert agents["ada"]["working"] and agents["ada"]["working_project"] == "Web Shop"
    assert agents["bob"]["working_project"] == "Web Shop"
    assert agents["cleo"]["working"] and agents["cleo"]["working_project"] is None
    overview = (await client.get("/api/overview")).json()
    assert {w["project"] for w in overview["working_now"]} == {"Web Shop", None}
