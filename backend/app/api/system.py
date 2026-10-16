import asyncio
import json
import logging
import secrets
from datetime import timedelta
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select

from app.api.deps import DB
from app.config import get_settings
from app.db import utcnow
from app.models import ActivityEvent, Agent, AgentTask, PerformanceReview, Project
from app.schemas import LoginIn, ReviewOut
from app.services import infra, mail, webhooks
from app.services.gamification import reviews
from app.services.working import running_projects
from app.services.gitea import GiteaClient
from app.services.settings_store import PUBLIC_KEYS, feature_enabled, get_setting, public_settings, set_setting

log = logging.getLogger(__name__)
router = APIRouter()
public = APIRouter()


# ---- auth ----------------------------------------------------------------
@public.post("/auth/login")
async def login(body: LoginIn, request: Request):
    s = get_settings()
    if not (secrets.compare_digest(body.username, s.manager_username)
            and secrets.compare_digest(body.password, s.manager_password)):
        raise HTTPException(401, "invalid credentials")
    request.session["user"] = body.username
    return {"username": body.username, "name": s.manager_name, "email": s.manager_address}


@public.post("/auth/logout")
async def logout(request: Request):
    request.session.clear()
    return {"ok": True}


@public.get("/auth/me")
async def whoami(request: Request):
    user = request.session.get("user")
    if not user:
        raise HTTPException(401, "not logged in")
    s = get_settings()
    return {"username": user, "name": s.manager_name, "email": s.manager_address}


# ---- webhooks ------------------------------------------------------------
@public.post("/webhooks/gitea")
async def gitea_webhook(request: Request, db: DB):
    body = await request.body()
    if not webhooks.verify_signature(body, request.headers.get("X-Gitea-Signature")):
        raise HTTPException(401, "bad signature")
    event = request.headers.get("X-Gitea-Event-Type") or request.headers.get("X-Gitea-Event", "")
    await webhooks.handle(db, event, json.loads(body))
    return {"ok": True}


# ---- settings / status ---------------------------------------------------
@router.get("/settings")
async def get_settings_(db: DB):
    return await public_settings(db)


@router.patch("/settings")
async def patch_settings(body: dict[str, Any], db: DB):
    for k, v in body.items():
        if k not in PUBLIC_KEYS:
            raise HTTPException(400, f"unknown setting {k}")
        if k == "voice_speed":
            if not isinstance(v, int | float) or not 0.7 <= v <= 1.6:
                raise HTTPException(400, "voice_speed must be between 0.7 and 1.6")
            v = round(float(v), 2)
        await set_setting(db, k, v)
    await db.commit()
    result = await public_settings(db)
    await infra.publish("settings", result)
    return result


@router.get("/system/status")
async def status(db: DB):
    s = get_settings()
    gitea_ok = False
    try:
        async with GiteaClient() as gc:
            await gc.request("GET", "/version")
            gitea_ok = True
    except Exception:
        pass
    return {
        "gitea_reachable": gitea_ok,
        "gitea_bootstrapped": bool(await get_setting(db, "gitea_admin_token")),
        "claude_auth": "subscription" if s.claude_code_oauth_token else "api_key" if s.anthropic_api_key else "local",
        "gitea_url": s.gitea_public_url,
        "gitea_org": s.gitea_org,
    }


# ---- overview ------------------------------------------------------------
@router.get("/overview")
async def overview(db: DB):
    since_week = utcnow() - timedelta(days=7)
    agents = (await db.scalars(select(Agent).where(Agent.status == "active"))).unique().all()
    running = (await db.scalars(select(AgentTask).where(AgentTask.status == "running"))).all()
    working = await running_projects(db)
    kinds = dict((await db.execute(
        select(ActivityEvent.kind, func.count(ActivityEvent.id)).where(ActivityEvent.created_at >= since_week)
        .group_by(ActivityEvent.kind)
    )).all())
    start_of_day = utcnow().replace(hour=0, minute=0, second=0, microsecond=0)  # same as AgentOut.cost_today_usd
    cost_today = await db.scalar(select(func.coalesce(func.sum(AgentTask.cost_usd), 0.0))
                                 .where(AgentTask.started_at >= start_of_day)) or 0.0
    cost_week = await db.scalar(select(func.coalesce(func.sum(AgentTask.cost_usd), 0.0))
                                .where(AgentTask.started_at >= since_week)) or 0.0
    tasks_week = await db.scalar(select(func.count(AgentTask.id)).where(AgentTask.started_at >= since_week)) or 0
    projects = await db.scalar(select(func.count(Project.id)).where(Project.status == "active")) or 0
    return {
        "team_size": len(agents),
        "active_projects": projects,
        "working_now": [{"agent_id": t.agent_id, "task_id": t.id, "title": t.title, "since": t.started_at,
                         "project": working.get(t.agent_id)}
                        for t in running],
        "week": {
            "prs_merged": kinds.get("pr_merged", 0),
            "prs_opened": kinds.get("pr_opened", 0),
            "issues_closed": kinds.get("issue_closed", 0),
            "reviews": kinds.get("review_submitted", 0),
            "tasks": tasks_week,
            "cost_usd": round(float(cost_week), 2),
        },
        "cost_today_usd": round(float(cost_today), 2),
        "unread_mail": await mail.unread_count(db, get_settings().manager_address),
        "avg_morale": round(sum(a.morale for a in agents) / len(agents)) if agents else None,
    }


# ---- leaderboard & reviews ----------------------------------------------
@router.get("/leaderboard")
async def leaderboard(db: DB, metric: str = "xp", days: int | None = None, project_id: int | None = None):
    if not await feature_enabled(db, "leaderboard"):
        raise HTTPException(404, "leaderboards are disabled")
    if metric not in reviews.LEADERBOARD_METRICS:
        raise HTTPException(400, f"metric must be one of {reviews.LEADERBOARD_METRICS}")
    return await reviews.leaderboard(db, metric, days, project_id)


@router.get("/reviews", response_model=list[ReviewOut])
async def list_reviews(db: DB, agent_id: int | None = None, limit: int = 50):
    q = select(PerformanceReview).order_by(PerformanceReview.id.desc()).limit(limit)
    if agent_id:
        q = q.where(PerformanceReview.agent_id == agent_id)
    return (await db.scalars(q)).all()


@router.post("/reviews/run")
async def run_reviews_now():
    await infra.enqueue("run_reviews", True)
    return {"queued": True}


# ---- live events (SSE) ---------------------------------------------------
@router.get("/events")
async def events(request: Request):
    async def stream():
        pubsub = infra.get_redis().pubsub()
        await pubsub.subscribe(infra.EVENTS_CHANNEL)
        try:
            yield "retry: 3000\n\n"
            while not await request.is_disconnected():
                msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=15)
                if msg is None:
                    yield ": keepalive\n\n"
                    continue
                yield f"data: {msg['data']}\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            await pubsub.unsubscribe(infra.EVENTS_CHANNEL)
            await pubsub.aclose()

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
