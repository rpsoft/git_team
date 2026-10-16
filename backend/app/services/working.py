"""What each agent is busy with right now (for the "Working" indicators)."""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AgentTask, Project, Thread


async def running_projects(db: AsyncSession) -> dict[int, str | None]:
    """agent_id -> name of the project its running task belongs to (None if not project-specific)."""
    tasks = (await db.scalars(select(AgentTask).where(AgentTask.status == "running"))).all()
    if not tasks:
        return {}
    projects = (await db.scalars(select(Project))).unique().all()
    by_repo = {p.repo_name: p.name for p in projects}
    by_id = {p.id: p.name for p in projects}
    out: dict[int, str | None] = {}
    for t in tasks:
        out[t.agent_id] = await project_of(db, t, by_repo, by_id)
    return out


async def project_of(db: AsyncSession, task: AgentTask, by_repo: dict[str, str], by_id: dict[int, str]) -> str | None:
    ref = task.trigger_ref or {}
    if ref.get("repo") in by_repo:
        return by_repo[ref["repo"]]
    if ref.get("project_id") in by_id:
        return by_id[ref["project_id"]]
    if task.trigger == "next_work" and ref.get("queue"):
        repo = str(ref["queue"][0].get("ref", "")).split("#")[0]
        return by_repo.get(repo)
    if task.trigger == "mail" and ref.get("thread_id"):
        thread = await db.get(Thread, ref["thread_id"])
        if thread and thread.project_id in by_id:
            return by_id[thread.project_id]
    return None
