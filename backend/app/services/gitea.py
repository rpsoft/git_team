"""Minimal async Gitea API client covering what the studio needs."""

import base64
import secrets
from typing import Any

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.services.infra import decrypt
from app.services.settings_store import get_setting

AGENT_TOKEN_SCOPES = ["write:repository", "write:issue", "write:user", "read:organization"]


class GiteaError(RuntimeError):
    pass


class GiteaClient:
    def __init__(self, token: str | None = None, basic: tuple[str, str] | None = None):
        headers = {"Accept": "application/json"}
        if token:
            headers["Authorization"] = f"token {token}"
        self._client = httpx.AsyncClient(
            base_url=get_settings().gitea_url.rstrip("/") + "/api/v1",
            headers=headers,
            auth=basic,
            timeout=30,
        )

    async def __aenter__(self) -> "GiteaClient":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self._client.aclose()

    async def request(self, method: str, path: str, *, ok404: bool = False, **kw: Any) -> Any:
        resp = await self._client.request(method, path, **kw)
        if ok404 and resp.status_code == 404:
            return None
        if resp.status_code >= 400:
            raise GiteaError(f"{method} {path} -> {resp.status_code}: {resp.text[:500]}")
        if not resp.content:
            return None
        if "json" in resp.headers.get("content-type", ""):
            return resp.json()
        return resp.text

    # ---- admin / users -------------------------------------------------
    async def create_user(self, username: str, email: str, full_name: str) -> str:
        password = secrets.token_urlsafe(24)
        await self.request(
            "POST",
            "/admin/users",
            json={
                "username": username,
                "email": email,
                "full_name": full_name,
                "password": password,
                "must_change_password": False,
                "send_notify": False,
                "visibility": "public",
            },
        )
        return password

    async def set_user_active(self, username: str, active: bool) -> None:
        await self.request(
            "PATCH",
            f"/admin/users/{username}",
            json={"login_name": username, "source_id": 0, "active": active, "prohibit_login": not active},
        )

    async def create_token(self, username: str, name: str) -> str:
        data = await self.request(
            "POST", f"/users/{username}/tokens", json={"name": name, "scopes": AGENT_TOKEN_SCOPES}
        )
        return data["sha1"]

    async def delete_token(self, username: str, name: str) -> None:
        await self.request("DELETE", f"/users/{username}/tokens/{name}", ok404=True)

    async def update_avatar(self, image_b64: str) -> None:
        await self.request("POST", "/user/avatar", json={"image": image_b64})

    async def update_profile(self, full_name: str, description: str) -> None:
        await self.request("PATCH", "/user/settings", json={"full_name": full_name, "description": description[:255]})

    # ---- orgs / repos --------------------------------------------------
    async def ensure_org(self, org: str) -> None:
        if await self.request("GET", f"/orgs/{org}", ok404=True) is None:
            await self.request("POST", "/orgs", json={"username": org, "full_name": "The Studio", "visibility": "public"})

    HOOK_EVENTS = ["push", "issues", "issue_assign", "issue_comment", "pull_request", "pull_request_assign",
                   "pull_request_comment", "pull_request_review_approved", "pull_request_review_rejected",
                   "pull_request_review_comment", "pull_request_review_request", "status"]

    async def ensure_org_hook(self, org: str, url: str, secret: str) -> None:
        """Create the studio webhook, or update it in place (events/secret) if it already exists."""
        body = {"type": "gitea", "active": True, "events": self.HOOK_EVENTS,
                "config": {"url": url, "content_type": "json", "secret": secret}}
        hooks = await self.request("GET", f"/orgs/{org}/hooks") or []
        existing = next((h for h in hooks if h.get("config", {}).get("url") == url), None)
        if existing:
            await self.request("PATCH", f"/orgs/{org}/hooks/{existing['id']}",
                               json={k: body[k] for k in ("active", "events", "config")})
        else:
            await self.request("POST", f"/orgs/{org}/hooks", json=body)

    async def create_repo(self, org: str, name: str, description: str) -> dict[str, Any]:
        return await self.request(
            "POST",
            f"/orgs/{org}/repos",
            json={"name": name, "description": description, "auto_init": True, "default_branch": "main",
                  "private": False, "readme": "Default"},
        )

    async def get_repo(self, owner: str, repo: str) -> dict[str, Any] | None:
        return await self.request("GET", f"/repos/{owner}/{repo}", ok404=True)

    async def add_collaborator(self, owner: str, repo: str, username: str, permission: str = "write") -> None:
        await self.request("PUT", f"/repos/{owner}/{repo}/collaborators/{username}", json={"permission": permission})

    async def remove_collaborator(self, owner: str, repo: str, username: str) -> None:
        await self.request("DELETE", f"/repos/{owner}/{repo}/collaborators/{username}", ok404=True)

    # ---- issues / PRs --------------------------------------------------
    async def list_issues(self, owner: str, repo: str, state: str = "open", kind: str = "issues",
                          assignee: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"state": state, "type": kind, "limit": limit}
        if assignee:
            params["assigned_by"] = assignee
        return await self.request("GET", f"/repos/{owner}/{repo}/issues", params=params) or []

    async def get_issue(self, owner: str, repo: str, number: int) -> dict[str, Any]:
        return await self.request("GET", f"/repos/{owner}/{repo}/issues/{number}")

    async def list_comments(self, owner: str, repo: str, number: int) -> list[dict[str, Any]]:
        return await self.request("GET", f"/repos/{owner}/{repo}/issues/{number}/comments") or []

    async def create_issue(self, owner: str, repo: str, title: str, body: str,
                           assignees: list[str] | None = None) -> dict[str, Any]:
        return await self.request(
            "POST", f"/repos/{owner}/{repo}/issues", json={"title": title, "body": body, "assignees": assignees or []}
        )

    async def edit_issue(self, owner: str, repo: str, number: int, **fields: Any) -> dict[str, Any]:
        return await self.request("PATCH", f"/repos/{owner}/{repo}/issues/{number}", json=fields)

    async def comment(self, owner: str, repo: str, number: int, body: str) -> dict[str, Any]:
        return await self.request("POST", f"/repos/{owner}/{repo}/issues/{number}/comments", json={"body": body})

    async def list_pulls(self, owner: str, repo: str, state: str = "open") -> list[dict[str, Any]]:
        return await self.request("GET", f"/repos/{owner}/{repo}/pulls", params={"state": state, "limit": 50}) or []

    async def get_pull(self, owner: str, repo: str, number: int) -> dict[str, Any]:
        return await self.request("GET", f"/repos/{owner}/{repo}/pulls/{number}")

    async def get_pull_diff(self, owner: str, repo: str, number: int) -> str:
        return await self.request("GET", f"/repos/{owner}/{repo}/pulls/{number}.diff")

    async def create_pull(self, owner: str, repo: str, head: str, base: str, title: str, body: str) -> dict[str, Any]:
        return await self.request(
            "POST", f"/repos/{owner}/{repo}/pulls", json={"head": head, "base": base, "title": title, "body": body}
        )

    async def request_reviewers(self, owner: str, repo: str, number: int, reviewers: list[str]) -> None:
        await self.request(
            "POST", f"/repos/{owner}/{repo}/pulls/{number}/requested_reviewers", json={"reviewers": reviewers}
        )

    async def submit_review(self, owner: str, repo: str, number: int, event: str, body: str) -> dict[str, Any]:
        return await self.request(
            "POST", f"/repos/{owner}/{repo}/pulls/{number}/reviews", json={"event": event, "body": body}
        )

    async def combined_status(self, owner: str, repo: str, ref: str) -> dict[str, Any]:
        """CI status for a branch/sha (Gitea Actions report one status per job)."""
        return await self.request("GET", f"/repos/{owner}/{repo}/commits/{ref}/status") or {}

    async def create_files(self, owner: str, repo: str, message: str, files: dict[str, str],
                           branch: str = "main") -> None:
        await self.request("POST", f"/repos/{owner}/{repo}/contents", json={
            "message": message, "branch": branch,
            "files": [{"operation": "create", "path": path, "content": base64.b64encode(text.encode()).decode()}
                      for path, text in files.items()],
        })

    async def merge_pull(self, owner: str, repo: str, number: int, style: str = "squash") -> None:
        await self.request(
            "POST",
            f"/repos/{owner}/{repo}/pulls/{number}/merge",
            json={"Do": style, "delete_branch_after_merge": True},
        )


async def admin_client(db: AsyncSession) -> GiteaClient:
    token = await get_setting(db, "gitea_admin_token")
    if not token:
        raise GiteaError("Gitea is not bootstrapped yet (run `make bootstrap`).")
    return GiteaClient(token=decrypt(token))


def agent_client(token_enc: str) -> GiteaClient:
    return GiteaClient(token=decrypt(token_enc))


def clone_url(repo: str, username: str | None = None, token: str | None = None) -> str:
    s = get_settings()
    base = s.gitea_url.rstrip("/")
    if username and token:
        scheme, rest = base.split("://", 1)
        base = f"{scheme}://{username}:{token}@{rest}"
    return f"{base}/{s.gitea_org}/{repo}.git"


def web_url(repo: str, path: str = "") -> str:
    s = get_settings()
    return f"{s.gitea_public_url.rstrip('/')}/{s.gitea_org}/{repo}{path}"
