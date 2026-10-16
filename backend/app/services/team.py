"""Hiring, firing and staffing — keeps the DB, Gitea and the mail system in sync."""

import base64
import logging
import re

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import utcnow
from app.models import Agent, Project, ProjectMember, Role
from app.services import infra, mail
from app.services.activity import record
from app.services.gitea import GiteaClient, admin_client, agent_client

log = logging.getLogger(__name__)


class TeamError(ValueError):
    pass


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:50] or "x"


async def hire(
    db: AsyncSession,
    *,
    name: str,
    handle: str,
    role_id: int,
    bio: str = "",
    responsibilities: list[str] | None = None,
    traits: list[str] | None = None,
    model: str | None = None,
    effort: str = "high",
    avatar_style: str = "notionists",
    avatar_seed: str = "",
    voice_type: str = "any",
    voice_name: str | None = None,
    max_turns: int = 60,
    daily_budget_usd: float = 10.0,
) -> Agent:
    handle = slugify(handle).replace("-", ".")
    if await db.scalar(select(Agent).where(Agent.handle == handle)):
        raise TeamError(f"handle @{handle} is already taken")
    role = await db.get(Role, role_id)
    if role is None:
        raise TeamError("unknown role")
    s = get_settings()
    agent = Agent(
        name=name, handle=handle, role_id=role.id, bio=bio,
        responsibilities=responsibilities if responsibilities is not None else list(role.responsibilities),
        traits=traits or [], model=model or s.default_model, effort=effort,
        avatar_style=avatar_style, avatar_seed=avatar_seed or handle,
        voice_type=voice_type, voice_name=voice_name,
        max_turns=max_turns, daily_budget_usd=daily_budget_usd,
    )

    # Gitea account: the agent commits, comments and reviews as itself.
    gitea_username = handle.replace(".", "-")
    async with await admin_client(db) as admin:
        password = await admin.create_user(gitea_username, f"{handle}@{s.mail_domain}", name)
    async with GiteaClient(basic=(gitea_username, password)) as as_agent:
        token = await as_agent.create_token(gitea_username, "studio")
    agent.gitea_username = gitea_username
    agent.gitea_password_enc = infra.encrypt(password)
    agent.gitea_token_enc = infra.encrypt(token)
    async with agent_client(agent.gitea_token_enc) as gc:
        try:
            await gc.update_profile(name, bio or role.description)
        except Exception:
            log.warning("could not update gitea profile for %s", handle, exc_info=True)

    db.add(agent)
    await db.commit()
    await db.refresh(agent)
    await record(db, "hired", agent_id=agent.id, summary=f"{name} joined as {role.name}",
                 data={"role": role.slug}, gamify=False)
    await infra.enqueue("run_agent", agent.id, "welcome", {}, job_id=f"welcome:{agent.id}")
    return agent


async def fire(db: AsyncSession, agent: Agent, reassign_to: Agent | None = None, reason: str = "") -> dict:
    """Off-board an agent: hand over open issues, revoke access, keep history."""
    if not agent.is_active:
        raise TeamError("agent is not active")
    s = get_settings()
    handed_over: list[str] = []
    async with await admin_client(db) as admin:
        for m in list(agent.memberships):
            repo = m.project.repo_name
            for issue in await admin.list_issues(s.gitea_org, repo, assignee=agent.gitea_username):
                assignees = [u["login"] for u in issue.get("assignees") or [] if u["login"] != agent.gitea_username]
                if reassign_to and reassign_to.gitea_username and reassign_to.gitea_username not in assignees:
                    assignees.append(reassign_to.gitea_username)
                await admin.edit_issue(s.gitea_org, repo, issue["number"], assignees=assignees)
                handed_over.append(f"{repo}#{issue['number']}")
            await admin.remove_collaborator(s.gitea_org, repo, agent.gitea_username)
        if agent.gitea_password_enc:
            async with GiteaClient(basic=(agent.gitea_username, infra.decrypt(agent.gitea_password_enc))) as as_agent:
                try:
                    await as_agent.delete_token(agent.gitea_username, "studio")
                except Exception:
                    log.warning("token revoke failed for %s", agent.handle, exc_info=True)
        await admin.set_user_active(agent.gitea_username, False)

    agent.memberships.clear()
    agent.status = "fired"
    agent.fired_at = utcnow()
    agent.gitea_token_enc = None
    await db.commit()
    await record(db, "fired", agent_id=agent.id, summary=f"{agent.name} left the team",
                 data={"reason": reason, "handed_over": handed_over,
                       "reassigned_to": reassign_to.id if reassign_to else None}, gamify=False)
    if reassign_to and handed_over:
        await mail.send(
            db, sender=s.manager_address, to=[mail.agent_address(reassign_to)],
            subject=f"Handover from {agent.name}",
            body=f"{agent.name} has left the team. These issues are now assigned to you:\n\n"
                 + "\n".join(f"- {h}" for h in handed_over)
                 + "\n\nPlease review them and pick up where they left off.",
        )
    return {"handed_over": handed_over}


NODE_CI_WORKFLOW = """name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest   # Node.js 22 container on the studio runner
    steps:
      - uses: actions/checkout@v4
      - name: Install
        run: |
          if [ ! -f package.json ]; then echo "No package.json yet - skipping"; exit 0; fi
          if [ -f package-lock.json ]; then npm ci; else npm install; fi
      - name: Lint
        run: if [ -f package.json ]; then npm run --if-present lint; fi
      - name: Test
        run: if [ -f package.json ]; then npm run --if-present test; fi
      - name: Build
        run: if [ -f package.json ]; then npm run --if-present build; fi
"""

CI_TEMPLATES = {"node": {".gitea/workflows/ci.yml": NODE_CI_WORKFLOW}}


async def create_project(db: AsyncSession, *, name: str, description: str = "", repo_name: str | None = None,
                         ci_template: str | None = None) -> Project:
    slug = slugify(repo_name or name)
    if await db.scalar(select(Project).where(Project.slug == slug)):
        raise TeamError(f"a project named {slug} already exists")
    s = get_settings()
    async with await admin_client(db) as admin:
        if await admin.get_repo(s.gitea_org, slug) is None:
            await admin.create_repo(s.gitea_org, slug, description)
            if ci_template in CI_TEMPLATES:
                await admin.create_files(s.gitea_org, slug, "Add CI workflow", CI_TEMPLATES[ci_template])
    project = Project(name=name, slug=slug, description=description, repo_name=slug)
    db.add(project)
    await db.commit()
    await db.refresh(project)
    await record(db, "project_created", project_id=project.id, summary=f"Project {name} created", gamify=False)
    return project


async def assign(db: AsyncSession, project: Project, agent: Agent, project_role: str = "", kickoff: bool = True) -> ProjectMember:
    if not agent.is_active:
        raise TeamError("cannot assign a fired agent")
    if any(m.agent_id == agent.id for m in project.members):
        raise TeamError(f"{agent.name} is already on {project.name}")
    s = get_settings()
    async with await admin_client(db) as admin:
        await admin.add_collaborator(s.gitea_org, project.repo_name, agent.gitea_username, "write")
    member = ProjectMember(project_id=project.id, agent_id=agent.id, project_role=project_role or agent.role.name)
    db.add(member)
    await db.commit()
    await db.refresh(project)
    await record(db, "assigned", agent_id=agent.id, project_id=project.id,
                 summary=f"{agent.name} joined project {project.name}", gamify=False)
    if kickoff:
        await infra.enqueue("run_agent", agent.id, "kickoff", {"project_id": project.id},
                            job_id=f"kickoff:{agent.id}:{project.id}")
    return member


async def unassign(db: AsyncSession, project: Project, agent: Agent) -> None:
    member = next((m for m in project.members if m.agent_id == agent.id), None)
    if member is None:
        raise TeamError(f"{agent.name} is not on {project.name}")
    s = get_settings()
    async with await admin_client(db) as admin:
        await admin.remove_collaborator(s.gitea_org, project.repo_name, agent.gitea_username)
    project.members.remove(member)
    await db.commit()
    await record(db, "unassigned", agent_id=agent.id, project_id=project.id,
                 summary=f"{agent.name} left project {project.name}", gamify=False)


async def push_avatar_to_gitea(agent: Agent, image: bytes) -> None:
    if not agent.gitea_token_enc:
        return
    try:
        async with agent_client(agent.gitea_token_enc) as gc:
            await gc.update_avatar(base64.b64encode(image).decode())
    except Exception:
        log.warning("could not upload avatar to gitea for %s", agent.handle, exc_info=True)
