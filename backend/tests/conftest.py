import os
import re
import tempfile
from typing import Any

_tmp = tempfile.mkdtemp()
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{_tmp}/test.db"
os.environ["DATA_DIR"] = _tmp
os.environ["WORKSPACES_DIR"] = f"{_tmp}/ws"
os.environ["MANAGER_PASSWORD"] = "pw"

import pytest  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402

from app.db import Base, SessionLocal, engine  # noqa: E402
from app.services import gitea, infra  # noqa: E402
from app.services.seed import seed_roles  # noqa: E402
from app.services.settings_store import set_setting  # noqa: E402


class FakeGitea:
    """In-memory stand-in for the Gitea API (only what the studio calls)."""

    def __init__(self) -> None:
        self.users: dict[str, dict] = {}
        self.repos: dict[str, dict] = {}
        self.collaborators: dict[str, set[str]] = {}
        self.issues: dict[str, list[dict]] = {}
        self.files: dict[str, dict[str, str]] = {}
        self.pulls: dict[str, list[dict]] = {}
        self.statuses: dict[str, dict] = {}
        self.reviews: dict[int, list[dict]] = {}
        self.calls: list[tuple[str, str]] = []

    async def request(self, method: str, path: str, *, ok404: bool = False, **kw: Any) -> Any:
        self.calls.append((method, path))
        body = kw.get("json") or {}
        routes = [
            ("POST", r"/admin/users", self._create_user),
            ("PATCH", r"/admin/users/(?P<u>[^/]+)", self._patch_user),
            ("POST", r"/users/(?P<u>[^/]+)/tokens", lambda b, u: {"sha1": f"token-{u}"}),
            ("DELETE", r"/users/(?P<u>[^/]+)/tokens/.*", lambda b, u: None),
            ("PATCH", r"/user/settings", lambda b: None),
            ("POST", r"/user/avatar", lambda b: None),
            ("GET", r"/repos/(?P<o>[^/]+)/(?P<r>[^/]+)", self._get_repo),
            ("POST", r"/orgs/(?P<o>[^/]+)/repos", self._create_repo),
            ("POST", r"/repos/[^/]+/(?P<r>[^/]+)/contents", self._create_files),
            ("PUT", r"/repos/[^/]+/(?P<r>[^/]+)/collaborators/(?P<u>[^/]+)", self._add_collab),
            ("DELETE", r"/repos/[^/]+/(?P<r>[^/]+)/collaborators/(?P<u>[^/]+)", self._rm_collab),
            ("GET", r"/repos/[^/]+/(?P<r>[^/]+)/issues", self._list_issues),
            ("PATCH", r"/repos/[^/]+/(?P<r>[^/]+)/issues/(?P<n>\d+)", self._edit_issue),
            ("GET", r"/repos/[^/]+/(?P<r>[^/]+)/pulls", lambda b, r: self.pulls.get(r, [])),
            ("GET", r"/repos/[^/]+/(?P<r>[^/]+)/pulls/(?P<n>\d+)/reviews", lambda b, r, n: self.reviews.get(int(n), [])),
            ("GET", r"/repos/[^/]+/(?P<r>[^/]+)/commits/(?P<sha>[^/]+)/status",
             lambda b, r, sha: self.statuses.get(sha, {"state": "pending", "statuses": []})),
        ]
        for m, pattern, fn in routes:
            match = re.fullmatch(pattern, path)
            if m == method and match:
                return fn(body, **match.groupdict())
        raise AssertionError(f"FakeGitea: unhandled {method} {path}")

    def _create_user(self, b):
        self.users[b["username"]] = {"active": True, **b}
        return {"id": len(self.users)}

    def _patch_user(self, b, u):
        self.users[u]["active"] = b["active"]

    def _get_repo(self, b, o, r):
        return self.repos.get(r)

    def _create_repo(self, b, o):
        self.repos[b["name"]] = {"name": b["name"], "open_issues_count": 0, "open_pr_counter": 0}
        return self.repos[b["name"]]

    def _create_files(self, b, r):
        self.files.setdefault(r, {}).update({f["path"]: f["content"] for f in b["files"]})

    def _add_collab(self, b, r, u):
        self.collaborators.setdefault(r, set()).add(u)

    def _rm_collab(self, b, r, u):
        self.collaborators.setdefault(r, set()).discard(u)

    def _list_issues(self, b, r):
        return [i for i in self.issues.get(r, []) if i["state"] == "open"]

    def _edit_issue(self, b, r, n):
        for i in self.issues.get(r, []):
            if i["number"] == int(n):
                i["assignees"] = [{"login": a} for a in b.get("assignees", [])]
                return i


@pytest.fixture
async def db_setup():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    async with SessionLocal() as db:
        await seed_roles(db)
        await set_setting(db, "gitea_admin_token", infra.encrypt("admin-token"))
        await db.commit()
    yield


@pytest.fixture
def fake_gitea(monkeypatch):
    fake = FakeGitea()

    async def request(self, method, path, *, ok404=False, **kw):
        return await fake.request(method, path, ok404=ok404, **kw)

    monkeypatch.setattr(gitea.GiteaClient, "request", request)
    return fake


@pytest.fixture
def bus(monkeypatch):
    """Captures published live events and enqueued jobs."""
    captured: dict[str, Any] = {"events": [], "jobs": [], "ci_watch": {}}

    async def publish(event_type, payload):
        captured["events"].append((event_type, payload))

    async def enqueue(job, *args, job_id=None, defer_by=None):
        captured["jobs"].append((job, args, job_id))

    async def add_ci_watcher(repo, sha, agent_id):
        captured["ci_watch"].setdefault((repo, sha), set()).add(agent_id)

    async def pop_ci_watchers(repo, sha):
        return captured["ci_watch"].pop((repo, sha), set())

    class FakeRedis:
        def __init__(self):
            self.kv: dict[str, str] = {}

        async def exists(self, key):
            return int(key in self.kv)

        async def set(self, key, value, nx=False, ex=None):
            if nx and key in self.kv:
                return None
            self.kv[key] = value
            return True

        async def get(self, key):
            return self.kv.get(key)

        async def delete(self, key):
            self.kv.pop(key, None)

    fake_redis = FakeRedis()
    captured["redis"] = fake_redis
    monkeypatch.setattr(infra, "get_redis", lambda: fake_redis)
    monkeypatch.setattr(infra, "add_ci_watcher", add_ci_watcher)
    monkeypatch.setattr(infra, "pop_ci_watchers", pop_ci_watchers)
    monkeypatch.setattr(infra, "publish", publish)
    monkeypatch.setattr(infra, "enqueue", enqueue)
    return captured


@pytest.fixture
async def db(db_setup):
    async with SessionLocal() as session:
        yield session


@pytest.fixture
async def client(db_setup, fake_gitea, bus):
    from app.main import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post("/api/auth/login", json={"username": "manager", "password": "pw"})
        assert r.status_code == 200
        yield c
