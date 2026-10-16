"""Thin wrappers around Redis: live event bus (pub/sub) and the arq job queue.

Kept in one place so tests can swap them out (see tests/conftest.py).
"""

import base64
import hashlib
import json
import logging
from typing import Any

from arq import create_pool
from arq.connections import ArqRedis, RedisSettings
from cryptography.fernet import Fernet
from redis.asyncio import Redis

from app.config import get_settings

log = logging.getLogger(__name__)

EVENTS_CHANNEL = "gitteam:events"

_redis: Redis | None = None
_arq: ArqRedis | None = None


def redis_settings() -> RedisSettings:
    return RedisSettings.from_dsn(get_settings().redis_url)


def get_redis() -> Redis:
    global _redis
    if _redis is None:
        _redis = Redis.from_url(get_settings().redis_url, decode_responses=True)
    return _redis


async def publish(event_type: str, payload: dict[str, Any]) -> None:
    """Push a live update to every connected dashboard (SSE)."""
    try:
        await get_redis().publish(EVENTS_CHANNEL, json.dumps({"type": event_type, **payload}, default=str))
    except Exception:  # live updates are best-effort
        log.warning("failed to publish %s event", event_type, exc_info=True)


async def enqueue(job: str, *args: Any, job_id: str | None = None, defer_by: float | None = None) -> None:
    global _arq
    if _arq is None:
        _arq = await create_pool(redis_settings())
    await _arq.enqueue_job(job, *args, _job_id=job_id, _defer_by=defer_by)


CI_WATCH_TTL = 24 * 60 * 60


def _ci_key(repo: str, sha: str) -> str:
    return f"gitteam:ciwatch:{repo}:{sha}"


async def add_ci_watcher(repo: str, sha: str, agent_id: int) -> None:
    """Remember that an agent wants to be woken when CI for this commit finishes."""
    r = get_redis()
    await r.sadd(_ci_key(repo, sha), str(agent_id))
    await r.expire(_ci_key(repo, sha), CI_WATCH_TTL)


async def pop_ci_watchers(repo: str, sha: str) -> set[int]:
    r = get_redis()
    key = _ci_key(repo, sha)
    members = await r.smembers(key)
    await r.delete(key)
    return {int(m) for m in members}


def _fernet() -> Fernet:
    key = hashlib.sha256(get_settings().secret_key.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def encrypt(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def decrypt(value: str) -> str:
    return _fernet().decrypt(value.encode()).decode()
