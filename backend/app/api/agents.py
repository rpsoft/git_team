import secrets
from datetime import timedelta
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func, select

from app.api.deps import DB, AgentDep
from app.config import get_settings
from app.db import utcnow
from app.models import ActivityEvent, Agent, AgentTask, Role
from app.schemas import (
    AchievementOut,
    ActivityOut,
    AgentOut,
    AgentUpdate,
    FireIn,
    GeneratedProfile,
    GenerateProfileIn,
    HireIn,
    KudosIn,
    MembershipOut,
    NudgeIn,
    RoleIn,
    RoleOut,
    TaskDetail,
    TaskOut,
)
from app.services import infra, mail, profiles, team
from app.services.activity import record
from app.services.gamification import engine, rules
from app.services.gitea import GiteaError
from app.services.settings_store import feature_enabled
from app.services.working import running_projects

router = APIRouter()
public = APIRouter()  # no auth (avatar images are loaded by <img> tags and Gitea)

MODELS = [
    {"id": "claude-opus-5-5", "name": "Claude Opus 5.5", "tier": "Senior"},
    {"id": "claude-sonnet-5-5", "name": "Claude Sonnet 5.5", "tier": "Mid-level"},
    {"id": "claude-haiku-4-5", "name": "Claude Haiku 4.5", "tier": "Junior"},
]
AVATAR_STYLES = ["notionists", "lorelei", "adventurer", "avataaars", "bottts", "personas", "micah", "pixel-art"]


def avatars_dir() -> Path:
    path = Path(get_settings().data_dir) / "avatars"
    path.mkdir(parents=True, exist_ok=True)
    return path


async def serialize(db: DB, agent: Agent, running: dict[int, str | None] | None = None,
                    costs: dict[int, float] | None = None) -> AgentOut:
    s = get_settings()
    if running is None:
        running = await running_projects(db)
    if costs is None:
        costs = await costs_today(db)
    cur, nxt = rules.xp_threshold(agent.level), rules.xp_threshold(agent.level + 1)
    return AgentOut(
        id=agent.id, name=agent.name, handle=agent.handle, email=mail.agent_address(agent),
        role=RoleOut.model_validate(agent.role), bio=agent.bio, responsibilities=agent.responsibilities,
        traits=agent.traits, model=agent.model, effort=agent.effort, avatar_style=agent.avatar_style,
        avatar_seed=agent.avatar_seed,
        avatar_url=f"/api/avatars/{agent.avatar_file}" if agent.avatar_file else None,
        voice_type=agent.voice_type, voice_name=agent.voice_name,
        status=agent.status, hired_at=agent.hired_at, fired_at=agent.fired_at,
        gitea_username=agent.gitea_username,
        gitea_url=f"{s.gitea_public_url.rstrip('/')}/{agent.gitea_username}" if agent.gitea_username else None,
        max_turns=agent.max_turns, daily_budget_usd=agent.daily_budget_usd,
        xp=agent.xp, level=agent.level, next_level_xp=nxt,
        level_progress=min(1.0, (agent.xp - cur) / max(1, nxt - cur)),
        morale=round(agent.morale), morale_band=rules.morale_band(agent.morale),
        projects=[MembershipOut(project_id=m.project_id, project_name=m.project.name, project_role=m.project_role)
                  for m in agent.memberships],
        achievements=[
            AchievementOut(key=a.key, name=rules.ACHIEVEMENTS_BY_KEY[a.key].name,
                           description=rules.ACHIEVEMENTS_BY_KEY[a.key].description,
                           icon=rules.ACHIEVEMENTS_BY_KEY[a.key].icon, unlocked_at=a.unlocked_at)
            for a in agent.achievements if a.key in rules.ACHIEVEMENTS_BY_KEY
        ],
        working=agent.id in running,
        working_project=running.get(agent.id),
        cost_today_usd=round(costs.get(agent.id, 0.0), 4),
    )


async def costs_today(db: DB) -> dict[int, float]:
    since = utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    rows = await db.execute(
        select(AgentTask.agent_id, func.sum(AgentTask.cost_usd)).where(AgentTask.started_at >= since)
        .group_by(AgentTask.agent_id)
    )
    return {a: float(c or 0) for a, c in rows.all()}


# ---- meta / roles --------------------------------------------------------
@router.get("/meta")
async def meta(db: DB) -> dict:
    return {
        "models": MODELS,
        "avatar_styles": AVATAR_STYLES,
        "traits": [{"key": k, "description": v} for k, v in rules.TRAITS.items()],
        "achievements": [a.__dict__ for a in rules.ACHIEVEMENTS],
        "efforts": ["low", "medium", "high", "xhigh", "max"],
        "builtin_tools": ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
        "mail_domain": get_settings().mail_domain,
        "manager_address": get_settings().manager_address,
        "gitea_url": get_settings().gitea_public_url,
    }


@router.get("/roles", response_model=list[RoleOut])
async def list_roles(db: DB):
    return (await db.scalars(select(Role).order_by(Role.id))).all()


@router.post("/roles", response_model=RoleOut)
async def create_role(body: RoleIn, db: DB):
    if await db.scalar(select(Role).where(Role.slug == team.slugify(body.name))):
        raise HTTPException(409, f"a role named {body.name!r} already exists")
    role = Role(slug=team.slugify(body.name), **body.model_dump())
    db.add(role)
    await db.commit()
    return role


@router.patch("/roles/{role_id}", response_model=RoleOut)
async def update_role(role_id: int, body: RoleIn, db: DB):
    role = await db.get(Role, role_id)
    if role is None:
        raise HTTPException(404, "role not found")
    for k, v in body.model_dump().items():
        setattr(role, k, v)
    await db.commit()
    return role


# ---- agents --------------------------------------------------------------
@router.get("/agents", response_model=list[AgentOut])
async def list_agents(db: DB, status: str | None = "active"):
    q = select(Agent).order_by(Agent.hired_at)
    if status and status != "all":
        q = q.where(Agent.status == status)
    agents = (await db.scalars(q)).unique().all()
    running = await running_projects(db)
    costs = await costs_today(db)
    return [await serialize(db, a, running, costs) for a in agents]


@router.post("/agents", response_model=AgentOut, status_code=201)
async def hire_agent(body: HireIn, db: DB):
    try:
        agent = await team.hire(db, **body.model_dump())
    except team.TeamError as e:
        raise HTTPException(400, str(e))
    except GiteaError as e:
        raise HTTPException(502, f"Gitea: {e}")
    return await serialize(db, agent)


@router.post("/agents/generate-profile", response_model=GeneratedProfile)
async def generate_profile(body: GenerateProfileIn, db: DB):
    """Invent a name and bio for a new hire (the 🤖 button in the hire wizard)."""
    role = await db.get(Role, body.role_id)
    if role is None:
        raise HTTPException(404, "role not found")
    taken = list((await db.scalars(select(Agent.name))).all())
    try:
        return await profiles.generate(role, body.traits, taken)
    except Exception as e:
        raise HTTPException(502, f"Could not generate a profile: {e}")


@router.post("/agents/restore-morale")
async def restore_morale(db: DB):
    """Lift every active agent's morale back to the level new hires start at (never lowers it)."""
    if not await feature_enabled(db, "morale"):
        raise HTTPException(400, "morale is switched off")
    start = Agent.morale.default.arg
    restored = 0
    for agent in (await db.scalars(select(Agent).where(Agent.status == "active", Agent.morale < start))).unique().all():
        await engine.set_morale(db, agent, start, reason="restored")
        restored += 1
    return {"restored": restored, "morale": start}


@router.get("/agents/{agent_id}", response_model=AgentOut)
async def get_agent(agent: AgentDep, db: DB):
    return await serialize(db, agent)


@router.patch("/agents/{agent_id}", response_model=AgentOut)
async def update_agent(agent: AgentDep, body: AgentUpdate, db: DB):
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(agent, k, v)
    await db.commit()
    await db.refresh(agent)
    return await serialize(db, agent)


@router.post("/agents/{agent_id}/fire")
async def fire_agent(agent: AgentDep, body: FireIn, db: DB):
    successor = await db.get(Agent, body.reassign_to) if body.reassign_to else None
    try:
        return await team.fire(db, agent, successor, body.reason)
    except team.TeamError as e:
        raise HTTPException(400, str(e))
    except GiteaError as e:
        raise HTTPException(502, f"Gitea: {e}")


@router.post("/agents/{agent_id}/nudge")
async def nudge_agent(agent: AgentDep, body: NudgeIn):
    if not agent.is_active:
        raise HTTPException(400, "agent is not active")
    await infra.enqueue("run_agent", agent.id, "nudge", {"instruction": body.instruction},
                        job_id=f"nudge:{agent.id}:{secrets.token_hex(4)}")
    return {"queued": True}


@router.post("/agents/{agent_id}/kudos")
async def kudos(agent: AgentDep, body: KudosIn, db: DB):
    if not (await feature_enabled(db, "xp") or await feature_enabled(db, "morale")):
        raise HTTPException(400, "kudos need XP or morale to be enabled")
    await record(db, "kudos", agent_id=agent.id, summary=f"{agent.name} received kudos"
                 + (f": “{body.message}”" if body.message else ""), data={"message": body.message})
    if body.message:
        s = get_settings()
        await mail.send(db, sender=s.manager_address, to=[mail.agent_address(agent)], subject="Kudos!",
                        body=body.message, wake_agents=False)
    await db.refresh(agent)
    return await serialize(db, agent)


@router.post("/agents/{agent_id}/avatar", response_model=AgentOut)
async def upload_avatar(agent: AgentDep, file: UploadFile, db: DB):
    data = await file.read()
    if len(data) > 2_000_000:
        raise HTTPException(413, "avatar must be under 2 MB")
    ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}.get(file.content_type or "")
    if ext is None:
        raise HTTPException(415, "use a PNG, JPEG, WebP or GIF image")
    name = f"{agent.id}-{secrets.token_hex(6)}.{ext}"
    (avatars_dir() / name).write_bytes(data)
    agent.avatar_file = name
    await db.commit()
    await team.push_avatar_to_gitea(agent, data)
    return await serialize(db, agent)


@router.delete("/agents/{agent_id}/avatar", response_model=AgentOut)
async def remove_avatar(agent: AgentDep, db: DB):
    agent.avatar_file = None
    await db.commit()
    return await serialize(db, agent)


@public.get("/avatars/{name}")
async def avatar(name: str):
    path = avatars_dir() / Path(name).name
    if not path.is_file():
        raise HTTPException(404)
    return FileResponse(path)


@router.get("/agents/{agent_id}/tasks", response_model=list[TaskOut])
async def agent_tasks(agent: AgentDep, db: DB, limit: int = 50):
    return (await db.scalars(
        select(AgentTask).where(AgentTask.agent_id == agent.id).order_by(AgentTask.id.desc()).limit(limit)
    )).all()


@router.get("/tasks", response_model=list[TaskOut])
async def list_tasks(db: DB, status: str | None = None, limit: int = 50):
    q = select(AgentTask).order_by(AgentTask.id.desc()).limit(limit)
    if status:
        q = q.where(AgentTask.status == status)
    return (await db.scalars(q)).all()


@router.get("/tasks/{task_id}", response_model=TaskDetail)
async def get_task(task_id: int, db: DB):
    task = await db.get(AgentTask, task_id)
    if task is None:
        raise HTTPException(404, "task not found")
    return task


@router.get("/activity", response_model=list[ActivityOut])
async def activity(db: DB, agent_id: int | None = None, project_id: int | None = None, limit: int = 50,
                   days: int | None = None):
    q = select(ActivityEvent).order_by(ActivityEvent.id.desc()).limit(min(limit, 500))
    if agent_id:
        q = q.where(ActivityEvent.agent_id == agent_id)
    if project_id:
        q = q.where(ActivityEvent.project_id == project_id)
    if days:
        q = q.where(ActivityEvent.created_at >= utcnow() - timedelta(days=days))
    return (await db.scalars(q)).all()
