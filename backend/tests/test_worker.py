import pytest
from arq import Retry

from app.workers import main


class LockRedis:
    def __init__(self, kv: dict[str, str]):
        self.kv = kv

    async def set(self, key, value, nx=False, ex=None):
        if nx and key in self.kv:
            return None
        self.kv[key] = value
        return True

    async def get(self, key):
        return self.kv.get(key)

    async def expire(self, key, seconds):
        return key in self.kv

    async def delete(self, *keys):
        for k in keys:
            self.kv.pop(k, None)

    async def scan_iter(self, match):
        for k in list(self.kv):
            if k.startswith(match.rstrip("*")):
                yield k


async def test_busy_agent_waits_but_a_retried_job_takes_back_its_own_lock(monkeypatch):
    ran = []

    async def fake_run(agent_id, trigger, ref):
        ran.append(agent_id)

    monkeypatch.setattr(main.runtime, "run", fake_run)
    redis = LockRedis({"gitteam:lock:agent:1": "mail:1"})
    with pytest.raises(Retry):
        await main.run_agent({"redis": redis, "job_id": "comment:9"}, 1, "comment", {})
    await main.run_agent({"redis": redis, "job_id": "mail:1"}, 1, "mail", {})
    assert ran == [1] and redis.kv == {}


async def test_startup_releases_locks_left_by_the_previous_worker(monkeypatch):
    async def cleanup(all_running=False):
        return None

    monkeypatch.setattr(main.runtime, "stale_task_cleanup", cleanup)
    redis = LockRedis({"gitteam:lock:agent:2": "x", "gitteam:lock:agent:3": "y", "other": "z"})
    await main.startup({"redis": redis})
    assert redis.kv == {"other": "z"}
