from collections import defaultdict
from datetime import timedelta

from fastapi import APIRouter, HTTPException
from sqlalchemy import func, select

from app.api.deps import DB, ProjectDep
from app.config import get_settings
from app.db import utcnow
from app.models import ActivityEvent, Agent, AgentTask, Project
from app.schemas import AssignIn, MemberOut, ProjectIn, ProjectOut, ProjectStats, ProjectUpdate
from app.services import team
from app.services.gitea import GiteaError, admin_client, web_url

router = APIRouter()


def serialize(p: Project) -> ProjectOut:
    return ProjectOut(
        id=p.id, name=p.name, slug=p.slug, description=p.description, status=p.status, repo_name=p.repo_name,
        repo_url=web_url(p.repo_name), created_at=p.created_at,
        members=[
            MemberOut(agent_id=m.agent_id, name=m.agent.name, handle=m.agent.handle,
                      avatar_style=m.agent.avatar_style, avatar_seed=m.agent.avatar_seed,
                      avatar_url=f"/api/avatars/{m.agent.avatar_file}" if m.agent.avatar_file else None,
                      role_name=m.agent.role.name, project_role=m.project_role)
            for m in p.members
        ],
    )


@router.get("/projects", response_model=list[ProjectOut])
async def list_projects(db: DB):
    return [serialize(p) for p in (await db.scalars(select(Project).order_by(Project.id))).unique().all()]


@router.post("/projects", response_model=ProjectOut, status_code=201)
async def create_project(body: ProjectIn, db: DB):
    try:
        project = await team.create_project(db, **body.model_dump())
    except team.TeamError as e:
        raise HTTPException(400, str(e))
    except GiteaError as e:
        raise HTTPException(502, f"Gitea: {e}")
    return serialize(project)


@router.get("/projects/{project_id}", response_model=ProjectOut)
async def get_project(project: ProjectDep):
    return serialize(project)


@router.patch("/projects/{project_id}", response_model=ProjectOut)
async def update_project(project: ProjectDep, body: ProjectUpdate, db: DB):
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(project, k, v)
    await db.commit()
    return serialize(project)


@router.post("/projects/{project_id}/members", response_model=ProjectOut)
async def add_member(project: ProjectDep, body: AssignIn, db: DB):
    agent = await db.get(Agent, body.agent_id)
    if agent is None:
        raise HTTPException(404, "agent not found")
    try:
        await team.assign(db, project, agent, body.project_role)
    except team.TeamError as e:
        raise HTTPException(400, str(e))
    except GiteaError as e:
        raise HTTPException(502, f"Gitea: {e}")
    await db.refresh(project)
    return serialize(project)


@router.delete("/projects/{project_id}/members/{agent_id}", response_model=ProjectOut)
async def remove_member(project: ProjectDep, agent_id: int, db: DB):
    agent = await db.get(Agent, agent_id)
    if agent is None:
        raise HTTPException(404, "agent not found")
    try:
        await team.unassign(db, project, agent)
    except team.TeamError as e:
        raise HTTPException(400, str(e))
    except GiteaError as e:
        raise HTTPException(502, f"Gitea: {e}")
    await db.refresh(project)
    return serialize(project)


@router.get("/projects/{project_id}/stats", response_model=ProjectStats)
async def project_stats(project: ProjectDep, db: DB, days: int = 30):
    s = get_settings()
    open_issues = closed_issues = open_prs = merged_prs = 0
    try:
        async with await admin_client(db) as gc:
            repo = await gc.get_repo(s.gitea_org, project.repo_name) or {}
            open_issues = repo.get("open_issues_count", 0)
            open_prs = repo.get("open_pr_counter", 0)
            closed_issues = len(await gc.list_issues(s.gitea_org, project.repo_name, state="closed", limit=50))
            merged_prs = sum(1 for p in await gc.list_pulls(s.gitea_org, project.repo_name, state="closed")
                             if p.get("merged"))
    except GiteaError:
        pass
    since = utcnow() - timedelta(days=days)
    events = (await db.scalars(
        select(ActivityEvent).where(ActivityEvent.project_id == project.id, ActivityEvent.created_at >= since)
    )).all()
    by_day: dict[str, dict[str, int]] = defaultdict(lambda: {"issues_closed": 0, "prs_merged": 0, "commits": 0})
    for e in events:
        day = e.created_at.strftime("%Y-%m-%d")
        if e.kind == "issue_closed":
            by_day[day]["issues_closed"] += 1
        elif e.kind == "pr_merged":
            by_day[day]["prs_merged"] += 1
        elif e.kind == "commits_pushed":
            by_day[day]["commits"] += int(e.data.get("count", 1))
    throughput = []
    for i in range(days, -1, -1):
        day = (utcnow() - timedelta(days=i)).strftime("%Y-%m-%d")
        throughput.append({"date": day, **by_day[day]})
    member_ids = [m.agent_id for m in project.members]
    cost = await db.scalar(
        select(func.coalesce(func.sum(AgentTask.cost_usd), 0.0)).where(
            AgentTask.started_at >= since, AgentTask.agent_id.in_(member_ids or [0])
        )
    ) or 0.0
    return ProjectStats(
        open_issues=open_issues, closed_issues=closed_issues, open_prs=open_prs, merged_prs=merged_prs,
        commits_30d=sum(d["commits"] for d in throughput), cost_30d_usd=round(float(cost), 2), throughput=throughput,
    )


@router.get("/projects/{project_id}/work")
async def project_work(project: ProjectDep, db: DB):
    """Open issues and PRs, straight from Gitea, for the project board."""
    s = get_settings()
    try:
        async with await admin_client(db) as gc:
            issues = await gc.list_issues(s.gitea_org, project.repo_name, state="open")
            pulls = await gc.list_pulls(s.gitea_org, project.repo_name, state="open")
    except GiteaError as e:
        raise HTTPException(502, f"Gitea: {e}")

    def slim(item: dict) -> dict:
        return {
            "number": item["number"], "title": item["title"], "url": item.get("html_url"),
            "author": (item.get("user") or {}).get("login"),
            "assignees": [a["login"] for a in item.get("assignees") or []],
            "labels": [lbl["name"] for lbl in item.get("labels") or []],
            "updated_at": item.get("updated_at"),
            "reviewers": [r["login"] for r in item.get("requested_reviewers") or []],
        }

    return {"issues": [slim(i) for i in issues], "pulls": [slim(p) for p in pulls]}
