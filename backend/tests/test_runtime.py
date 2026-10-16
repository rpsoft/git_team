from pathlib import Path

from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny

from app.agents import prompts
from app.agents.runtime import make_permission_check
from app.agents.tools import ToolContext, build_server
from app.models import Agent
from tests.test_team_api import hire


async def test_file_tools_are_confined_to_workspace(tmp_path: Path):
    check = make_permission_check(tmp_path)
    assert isinstance(await check("Read", {"file_path": str(tmp_path / "repo/a.py")}, None), PermissionResultAllow)
    assert isinstance(await check("Edit", {"file_path": "repo/a.py"}, None), PermissionResultAllow)
    assert isinstance(await check("Read", {"file_path": "/etc/passwd"}, None), PermissionResultDeny)
    assert isinstance(await check("Glob", {"path": "../.."}, None), PermissionResultDeny)
    assert isinstance(await check("Bash", {"command": "ls"}, None), PermissionResultAllow)


def test_merge_tool_only_for_roles_that_can_merge():
    base = dict(agent_id=1, handle="a", gitea_username="a", token_enc="x", repos={"r"})
    _, names = build_server(ToolContext(can_merge=False, **base))
    assert "mcp__studio__merge_pull_request" not in names
    assert "mcp__studio__send_email" in names
    _, names = build_server(ToolContext(can_merge=True, **base))
    assert "mcp__studio__merge_pull_request" in names


async def test_system_prompt_reflects_profile(client, db):
    data = await hire(client, role_slug="code-reviewer")
    agent = await db.get(Agent, data["id"])
    text = prompts.system_prompt(agent, [], [agent], morale_on=True)
    assert "Code Reviewer" in text and "@ada" in text
    assert "meticulous" in text
    assert "Mood: motivated" in text
    assert "no shell" in text
    assert "Mood" not in prompts.system_prompt(agent, [], [agent], morale_on=False)


async def test_project_can_start_with_node_ci(client, fake_gitea):
    import base64

    r = await client.post("/api/projects", json={"name": "Shop", "ci_template": "node"})
    assert r.status_code == 201
    workflow = base64.b64decode(fake_gitea.files["shop"][".gitea/workflows/ci.yml"]).decode()
    assert "runs-on: ubuntu-latest" in workflow and "npm" in workflow
    await client.post("/api/projects", json={"name": "Plain"})
    assert "plain" not in fake_gitea.files


def test_ci_summary():
    from app.agents.tools import summarize_ci

    assert "No CI runs" in summarize_ci({"state": "", "statuses": []}, "abc123")
    text = summarize_ci({"state": "failure", "statuses": [
        {"context": "CI / test (pull_request)", "status": "failure", "description": "Failing after 20s",
         "target_url": "/studio/shop/actions/runs/3/jobs/0"}]}, "abc123def456789")
    assert "Overall: failure" in text and "/studio/shop/actions/runs/3/jobs/0" in text
    assert "npm ci && npm test" in text


async def test_leftover_workspace_processes_are_killed(tmp_path):
    import asyncio

    from app.agents.runtime import kill_workspace_processes

    ws = tmp_path / "task-1"
    ws.mkdir()
    proc = await asyncio.create_subprocess_exec("sleep", "60", cwd=ws)
    outside = await asyncio.create_subprocess_exec("sleep", "60", cwd=tmp_path)
    try:
        assert kill_workspace_processes(ws) == 1
        assert await asyncio.wait_for(proc.wait(), 5) == -9
        assert outside.returncode is None, "processes outside the workspace are untouched"
    finally:
        outside.kill()
        await outside.wait()


async def test_infra_failure_is_retryable_and_returns_mail(client, db, monkeypatch, bus):
    import pytest
    from claude_agent_sdk import CLIConnectionError
    from sqlalchemy import select

    from app.agents import runtime
    from app.models import AgentTask, Recipient

    ada = await hire(client)
    await client.post("/api/mail/send", json={"to": ["ada@team.local"], "subject": "Hi", "body": "Do X"})
    thread_id = (await client.get("/api/mail/threads?folder=sent")).json()[0]["id"]

    async def broken(*a, **k):
        raise CLIConnectionError("Failed to start Claude Code: [Errno 11] Resource temporarily unavailable")

    monkeypatch.setattr(runtime, "execute", broken)
    monkeypatch.setattr(runtime, "prepare_workspace", lambda *a, **k: _noop())
    with pytest.raises(runtime.InfraFailure):
        await runtime.run(ada["id"], "mail", {"thread_id": thread_id})
    task = (await db.scalars(select(AgentTask).where(AgentTask.agent_id == ada["id"]))).all()[-1]
    await db.refresh(task)
    assert task.status == "failed" and task.error.startswith("Infrastructure error")
    unread = (await db.scalars(select(Recipient).where(Recipient.address == "ada@team.local"))).all()
    assert all(r.read_at is None for r in unread), "mail handed back for the retry"
    agent = (await client.get(f"/api/agents/{ada['id']}")).json()
    assert agent["morale"] == 75, "infrastructure failures don't count against the agent"


async def test_claude_account_limit_is_not_the_agents_fault(client, db, monkeypatch, bus):
    from types import SimpleNamespace

    import pytest
    from sqlalchemy import select

    from app.agents import runtime
    from app.models import AgentTask

    ada = await hire(client)
    await client.post("/api/mail/send", json={"to": ["ada@team.local"], "subject": "Hi", "body": "Do X"})
    thread_id = (await client.get("/api/mail/threads?folder=sent")).json()[0]["id"]

    async def limited(*a, **k):
        return SimpleNamespace(is_error=True, subtype="success", errors=[], usage={}, total_cost_usd=0.0, num_turns=1,
                               result="You've hit your org's monthly spend limit · ask your admin to raise it")

    monkeypatch.setattr(runtime, "execute", limited)
    monkeypatch.setattr(runtime, "prepare_workspace", lambda *a, **k: _noop())
    with pytest.raises(runtime.InfraFailure):
        await runtime.run(ada["id"], "mail", {"thread_id": thread_id})
    task = (await db.scalars(select(AgentTask).where(AgentTask.agent_id == ada["id"]))).all()[-1]
    await db.refresh(task)
    assert task.error.startswith("Claude account limit")
    assert (await client.get(f"/api/agents/{ada['id']}")).json()["morale"] == 75

async def _noop():
    return None
