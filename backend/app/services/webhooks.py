"""Translate Gitea webhook deliveries into activity events and agent wake-ups."""

import hashlib
import hmac
import re
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models import Agent, Project
from app.services import infra
from app.services.activity import record
from app.services.gitea import admin_client


def verify_signature(body: bytes, signature: str | None) -> bool:
    expected = hmac.new(get_settings().gitea_webhook_secret.encode(), body, hashlib.sha256).hexdigest()
    return bool(signature) and hmac.compare_digest(expected, signature)


class Ctx:
    def __init__(self, db: AsyncSession, agents: dict[str, Agent], project: Project | None, repo: str):
        self.db, self.agents, self.project, self.repo = db, agents, project, repo

    def agent(self, login: str | None) -> Agent | None:
        return self.agents.get(login or "")

    async def log(self, kind: str, login: str | None, summary: str, **data: Any) -> None:
        agent = self.agent(login)
        if agent is None:
            return
        await record(self.db, kind, agent_id=agent.id, project_id=self.project.id if self.project else None,
                     summary=summary, data={"repo": self.repo, **data})

    async def wake(self, login: str | None, trigger: str, ref: dict[str, Any], job_id: str, *, sender: str | None) -> None:
        agent = self.agent(login)
        if agent is None or login == sender:
            return  # never wake an agent for its own action
        await infra.enqueue("run_agent", agent.id, trigger, {"repo": self.repo, **ref},
                            job_id=f"{job_id}:{agent.id}", defer_by=2)


async def handle(db: AsyncSession, event_type: str, payload: dict[str, Any]) -> None:
    repo = (payload.get("repository") or {}).get("name", "")
    agents = {a.gitea_username: a for a in (await db.scalars(select(Agent).where(Agent.status == "active"))).all()
              if a.gitea_username}
    project = await db.scalar(select(Project).where(Project.repo_name == repo)) if repo else None
    ctx = Ctx(db, agents, project, repo)
    sender = (payload.get("sender") or {}).get("login")
    handler = HANDLERS.get(event_type)
    if handler:
        await handler(ctx, payload, sender)


async def on_push(ctx: Ctx, p: dict, sender: str | None) -> None:
    commits = p.get("commits") or []
    if not commits:
        return
    pusher = (p.get("pusher") or {}).get("login") or sender
    branch = (p.get("ref") or "").removeprefix("refs/heads/")
    await ctx.log("commits_pushed", pusher, f"pushed {len(commits)} commit(s) to {ctx.repo}:{branch}",
                  count=len(commits), branch=branch)


async def on_issues(ctx: Ctx, p: dict, sender: str | None) -> None:
    action, issue = p.get("action"), p.get("issue") or {}
    n, title = issue.get("number"), issue.get("title", "")
    assignees = [u["login"] for u in issue.get("assignees") or []]
    if action == "opened":
        await ctx.log("issue_opened", sender, f"opened {ctx.repo}#{n}: {title}", number=n)
    elif action == "closed":
        for login in assignees or [sender]:
            await ctx.log("issue_closed", login, f"closed {ctx.repo}#{n}: {title}", number=n)
    if action in ("opened", "assigned"):
        for login in assignees:
            await ctx.wake(login, "issue_assigned", {"number": n}, f"issue:{ctx.repo}:{n}", sender=sender)


async def on_comment(ctx: Ctx, p: dict, sender: str | None) -> None:
    if p.get("action") != "created":
        return
    issue, comment = p.get("issue") or {}, p.get("comment") or {}
    n, body = issue.get("number"), comment.get("body", "")
    interested = set(re.findall(r"@([A-Za-z0-9_.-]+)", body))
    interested |= {u["login"] for u in issue.get("assignees") or []}
    if issue.get("pull_request"):
        interested.add((issue.get("user") or {}).get("login"))
    for login in interested:
        await ctx.wake(login, "comment", {"number": n, "comment_id": comment.get("id"),
                                          "is_pull": bool(issue.get("pull_request"))},
                       f"comment:{comment.get('id')}", sender=sender)


async def on_pull_request(ctx: Ctx, p: dict, sender: str | None) -> None:
    action, pr = p.get("action"), p.get("pull_request") or {}
    n, title, author = pr.get("number"), pr.get("title", ""), (pr.get("user") or {}).get("login")
    if action == "opened":
        await ctx.log("pr_opened", author, f"opened PR {ctx.repo}#{n}: {title}", number=n)
    elif action == "closed" and pr.get("merged"):
        await ctx.log("pr_merged", author, f"got PR {ctx.repo}#{n} merged: {title}", number=n,
                      merged_by=(pr.get("merged_by") or {}).get("login"))
    elif action == "review_requested":
        reviewer = (p.get("requested_reviewer") or {}).get("login")
        await ctx.wake(reviewer, "review_requested", {"number": n}, f"review:{ctx.repo}:{n}:{pr.get('head', {}).get('sha', '')}",
                       sender=sender)


def _on_review(verdict: str):
    async def handler(ctx: Ctx, p: dict, sender: str | None) -> None:
        pr = p.get("pull_request") or {}
        n, author = pr.get("number"), (pr.get("user") or {}).get("login")
        content = (p.get("review") or {}).get("content", "")
        if sender != author:
            await ctx.log("review_submitted", sender, f"reviewed {ctx.repo}#{n} ({verdict})", number=n, verdict=verdict)
        if verdict == "approved":
            await ctx.log("pr_approved", author, f"PR {ctx.repo}#{n} was approved", number=n, by=sender)
        elif verdict == "changes_requested":
            await ctx.log("pr_changes_requested", author, f"changes requested on {ctx.repo}#{n}", number=n, by=sender)
        if verdict != "approved" or (ctx.agent(author) and ctx.agent(author).role.can_merge):
            await ctx.wake(author, "review_feedback", {"number": n, "verdict": verdict, "review": content[:4000]},
                           f"feedback:{ctx.repo}:{n}:{hashlib.md5(content.encode()).hexdigest()[:8]}", sender=sender)
    return handler


async def on_status(ctx: Ctx, p: dict, sender: str | None) -> None:
    """A CI job changed state. Once all CI for the commit is done, wake whoever needs to act on it."""
    if p.get("state") not in ("success", "failure", "error") or not ctx.repo:
        return
    sha, org = p.get("sha", ""), get_settings().gitea_org
    async with await admin_client(ctx.db) as gc:
        combined = await gc.combined_status(org, ctx.repo, sha)
        state = combined.get("state")
        if state not in ("success", "failure", "error"):
            return  # other jobs still running
        pulls = [pr for pr in await gc.list_pulls(org, ctx.repo, "open") if pr["head"]["sha"] == sha]
    watchers = await infra.pop_ci_watchers(ctx.repo, sha)
    for pr in pulls:
        n, author = pr["number"], (pr.get("user") or {}).get("login")
        author_agent = ctx.agent(author)
        await ctx.log("ci_passed" if state == "success" else "ci_failed", author,
                      f"CI {'passed' if state == 'success' else 'failed'} on {ctx.repo}#{n}", number=n, sha=sha)
        logins = {a.gitea_username for a in ctx.agents.values() if a.id in watchers}
        if author_agent and (state != "success" or author_agent.role.can_merge):
            logins.add(author)
        for login in logins:
            await ctx.wake(login, "ci_finished", {"number": n, "state": state, "sha": sha},
                           f"ci:{ctx.repo}:{sha}", sender=None)


HANDLERS = {
    "status": on_status,
    "push": on_push,
    "issues": on_issues,
    "issue_assign": on_issues,
    "issue_comment": on_comment,
    "pull_request_comment": on_comment,
    "pull_request": on_pull_request,
    "pull_request_review_request": on_pull_request,
    "pull_request_review_approved": _on_review("approved"),
    "pull_request_review_rejected": _on_review("changes_requested"),
    "pull_request_review_comment": _on_review("commented"),
    # X-Gitea-Event (legacy header) names for reviews
    "pull_request_approved": _on_review("approved"),
    "pull_request_rejected": _on_review("changes_requested"),
}
