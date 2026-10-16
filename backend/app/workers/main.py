"""arq worker: agent runs, performance reviews and periodic housekeeping.

Run with: arq app.workers.main.WorkerSettings
"""

import logging
import time
from typing import Any

from arq import Retry, cron

from app.agents import runtime
from app.config import get_settings
from app.db import SessionLocal
from app.services import infra
from app.services import standup
from app.services.gamification import engine, reviews
from app.services.settings_store import get_setting

log = logging.getLogger(__name__)
LOCK_TTL = 3 * 60 * 60
INFRA_RETRIES = 3


async def run_agent(ctx: dict, agent_id: int, trigger: str, ref: dict[str, Any]) -> int | None:
    """One agent works on one thing at a time; concurrent requests for the same agent wait."""
    redis = ctx["redis"]
    lock = f"gitteam:lock:agent:{agent_id}"
    if not await redis.set(lock, ctx["job_id"], nx=True, ex=LOCK_TTL):
        holder = await redis.get(lock)
        if (holder.decode() if isinstance(holder, bytes) else holder) != ctx["job_id"]:
            raise Retry(defer=20)
        await redis.expire(lock, LOCK_TTL)  # a retry of the job that held it (e.g. after a worker restart)
    try:
        return await runtime.run(agent_id, trigger, ref)
    except runtime.Deferred as d:
        raise Retry(defer=d.seconds)
    except runtime.InfraFailure:
        key = f"gitteam:infra-retries:{ctx['job_id']}"
        attempt = await redis.incr(key)
        await redis.expire(key, 6 * 3600)
        if attempt > INFRA_RETRIES:
            log.error("giving up on %s after %d infrastructure failures", ctx["job_id"], attempt - 1)
            return None
        raise Retry(defer=60 * attempt)
    finally:
        await redis.delete(lock)


async def run_reviews(ctx: dict, force: bool = False) -> int:
    async with SessionLocal() as db:
        return len(await reviews.run_reviews(db, force=force))


async def scheduled_reviews(ctx: dict) -> None:
    async with SessionLocal() as db:
        days = int(await get_setting(db, "review_period_days") or 7)
    # Weekly by default: the cron fires daily and we run when the period has elapsed.
    last = await ctx["redis"].get("gitteam:last_review_run")
    if last and time.time() - float(last) < days * 86400 - 3600:
        return
    await run_reviews(ctx)
    await ctx["redis"].set("gitteam:last_review_run", str(time.time()))


async def morale_drift(ctx: dict) -> None:
    async with SessionLocal() as db:
        await engine.drift_morale(db)


async def standup_check(ctx: dict) -> None:
    async with SessionLocal() as db:
        await standup.run(db)


async def cleanup(ctx: dict) -> None:
    await runtime.stale_task_cleanup()


async def startup(ctx: dict) -> None:
    logging.basicConfig(level=logging.INFO)
    await runtime.stale_task_cleanup(all_running=True)
    # Nothing is running yet, so any agent lock is left over from jobs killed with the previous worker.
    stale = [k async for k in ctx["redis"].scan_iter(match="gitteam:lock:agent:*")]
    if stale:
        await ctx["redis"].delete(*stale)
        logging.getLogger(__name__).info("released %d stale agent locks", len(stale))


class WorkerSettings:
    functions = [run_agent, run_reviews]
    cron_jobs = [
        cron(scheduled_reviews, hour={9}, minute={0}),
        cron(morale_drift, hour={3}, minute={0}),
        cron(cleanup, minute={15}),
        cron(standup_check, minute=set(range(0, 60, 10)), second={30}),
    ]
    on_startup = startup
    redis_settings = infra.redis_settings()
    max_jobs = get_settings().worker_max_jobs
    job_timeout = 2 * 60 * 60
    max_tries = 500  # Retry() is used to wait for a busy agent / paused studio
    keep_result = 0
    allow_abort_jobs = True
