"""Keeps idle agents busy.

Agents are event-driven: they run when mail or a Gitea event arrives. Once a task is done they
wait, even if they still have assigned issues or reviews to do. Every few minutes this "standup"
looks for active agents that are idle, have budget left and have open work, and wakes them with
their personal queue in priority order.
"""

import logging
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import utcnow
from app.models import ActivityEvent, Agent, AgentTask
from app.services import infra
from app.services.gitea import GiteaClient, GiteaError, admin_client
from app.services.settings_store import get_setting

log = logging.getLogger(__name__)

IDLE_AFTER = timedelta(minutes=10)  # quiet this long before we nudge
MIN_BUDGET_LEFT = 0.5  # USD (API-equivalent)
BACKOFF = timedelta(hours=2)  # after two standups in a row that changed nothing
PROGRESS_KINDS = {"issue_opened", "issue_closed", "pr_opened", "pr_merged", "review_submitted", "commits_pushed",
                  "pr_approved"}


# Claude account problems (spend/usage limits, billing): the run never really started, so not the agent's fault.
ACCOUNT_ERRORS = ("spend limit", "usage limit", "rate limit", "credit balance", "billing")


def account_error(text: str) -> bool:
    return any(k in text.lower() for k in ACCOUNT_ERRORS)


async def spent_today(db: AsyncSession, agent_id: int) -> float:
    day = utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    return float(await db.scalar(select(func.coalesce(func.sum(AgentTask.cost_usd), 0.0)).where(
        AgentTask.agent_id == agent_id, AgentTask.started_at >= day)) or 0.0)


async def is_idle(db: AsyncSession, agent: Agent) -> bool:
    if await db.scalar(select(func.count(AgentTask.id)).where(AgentTask.agent_id == agent.id,
                                                              AgentTask.status == "running")):
        return False
    if await infra.get_redis().exists(f"gitteam:lock:agent:{agent.id}"):
        return False
    last = await db.scalar(select(func.max(AgentTask.finished_at)).where(AgentTask.agent_id == agent.id))
    return last is None or utcnow() - last >= IDLE_AFTER


async def stuck(db: AsyncSession, agent: Agent) -> bool:
    """Two standups in a row without any Gitea progress -> back off for a while."""
    rows = (await db.scalars(select(AgentTask).where(
        AgentTask.agent_id == agent.id, AgentTask.trigger == "next_work").order_by(AgentTask.id.desc()).limit(20))).all()
    # Runs that never really started (infrastructure / Claude account limits) say nothing about the agent.
    recent = [t for t in rows if not (t.error.startswith("Infrastructure error") or account_error(t.error))][:2]
    if len(recent) < 2 or utcnow() - recent[0].started_at > BACKOFF:
        return False
    progress = await db.scalar(select(func.count(ActivityEvent.id)).where(
        ActivityEvent.agent_id == agent.id, ActivityEvent.kind.in_(PROGRESS_KINDS),
        ActivityEvent.created_at >= recent[1].started_at))
    return not progress


async def work_queue(gc: GiteaClient, agent: Agent) -> list[dict]:
    """Open work for an agent across its active projects, most urgent first."""
    org = get_settings().gitea_org
    me = agent.gitea_username
    items: list[dict] = []
    for m in agent.memberships:
        project = m.project
        if project.status != "active":
            continue
        repo = project.repo_name
        for pr in await gc.list_pulls(org, repo, "open"):
            n, author = pr["number"], pr["user"]["login"]
            reviewers = {r["login"] for r in pr.get("requested_reviewers") or []}
            ref = f"{repo}#{n}"
            if me in reviewers and author != me:
                items.append({"rank": 1, "kind": "review", "ref": ref, "title": pr["title"],
                              "note": f"review requested by {author}"})
                continue
            if author != me and not agent.role.can_merge:
                continue
            ci = (await gc.combined_status(org, repo, pr["head"]["sha"])).get("state") or "none"
            reviews = await gc.request("GET", f"/repos/{org}/{repo}/pulls/{n}/reviews") or []
            latest: dict[str, str] = {}
            for r in reviews:
                if r.get("state") in ("APPROVED", "REQUEST_CHANGES"):
                    latest[(r.get("user") or {}).get("login", "?")] = r["state"]
            changes = [u for u, s in latest.items() if s == "REQUEST_CHANGES"]
            approved = any(s == "APPROVED" for s in latest.values())
            if author == me and (ci in ("failure", "error") or changes):
                why = "CI failing" if ci in ("failure", "error") else f"changes requested by {', '.join(changes)}"
                items.append({"rank": 2, "kind": "fix_pr", "ref": ref, "title": pr["title"], "note": why})
            elif agent.role.can_merge and approved and not changes and ci == "success":
                items.append({"rank": 3, "kind": "merge", "ref": ref, "title": pr["title"],
                              "note": "approved and CI green — ready to merge"})
        for issue in await gc.list_issues(org, repo, state="open", assignee=me):
            if me in [a["login"] for a in issue.get("assignees") or []]:
                items.append({"rank": 4, "kind": "issue", "ref": f"{repo}#{issue['number']}", "title": issue["title"],
                              "note": ", ".join(lbl["name"] for lbl in issue.get("labels") or [])})
    items.sort(key=lambda i: i["rank"])
    return items


def render_queue(items: list[dict]) -> str:
    labels = {"review": "Review requested", "fix_pr": "Your PR needs work", "merge": "Ready to merge",
              "issue": "Assigned issue"}
    return "\n".join(f"- [{labels[i['kind']]}] {i['ref']} — {i['title']}" + (f" ({i['note']})" if i["note"] else "")
                     for i in items)


async def run(db: AsyncSession) -> list[int]:
    """Wake idle agents that have work. Returns the ids of agents woken."""
    if await get_setting(db, "agents_paused"):
        return []
    woken: list[int] = []
    agents = (await db.scalars(select(Agent).where(Agent.status == "active"))).unique().all()
    async with await admin_client(db) as gc:
        for agent in agents:
            if not agent.gitea_username or not agent.memberships:
                continue
            try:
                if agent.daily_budget_usd - await spent_today(db, agent.id) < MIN_BUDGET_LEFT:
                    continue
                if not await is_idle(db, agent) or await stuck(db, agent):
                    continue
                items = await work_queue(gc, agent)
            except GiteaError:
                log.warning("standup: gitea lookup failed for %s", agent.handle, exc_info=True)
                continue
            if not items:
                continue
            bucket = utcnow().strftime("%Y%m%d%H%M")[:-1]  # one per agent per 10 minutes
            await infra.enqueue("run_agent", agent.id, "next_work", {"queue": items[:15]},
                                job_id=f"next:{agent.id}:{bucket}")
            woken.append(agent.id)
    if woken:
        log.info("standup woke agents %s", woken)
    return woken
