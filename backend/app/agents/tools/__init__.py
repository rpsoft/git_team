"""In-process MCP tools that let an agent use the studio: mail, Gitea and the team directory.

All tools act *as the agent* (its own Gitea token, its own mailbox) and are limited to the
repos of the projects the agent is assigned to.
"""

import json
import mimetypes
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool
from sqlalchemy import select

from app.config import get_settings
from app.db import SessionLocal
from app.models import Agent, Project, Thread
from app.services import infra, mail
from app.services.gitea import GiteaError, agent_client

SERVER_NAME = "studio"
MAX_DIFF_CHARS = 60_000


@dataclass
class ToolContext:
    agent_id: int
    handle: str
    gitea_username: str
    token_enc: str
    can_merge: bool
    repos: set[str]
    workspace: Path | None = None
    project_ids: dict[str, int] = field(default_factory=dict)

    @property
    def address(self) -> str:
        return f"{self.handle}@{get_settings().mail_domain}"


def ok(data: Any) -> dict[str, Any]:
    text = data if isinstance(data, str) else json.dumps(data, indent=2, default=str)
    return {"content": [{"type": "text", "text": text}]}


def err(message: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": f"Error: {message}"}], "is_error": True}


def str_list(description: str) -> dict[str, Any]:
    return {"type": "array", "items": {"type": "string"}, "description": description}


def schema(props: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {"type": "object", "properties": props, "required": required}


REPO = {"type": "string", "description": "Repository name (one of your projects' repos)"}
NUMBER = {"type": "integer", "description": "Issue or pull request number"}


# Look-up tools that are safe and quick to use during a live call.
READ_ONLY_TOOLS = {"list_inbox", "read_thread", "list_team", "get_project", "list_issues", "read_issue",
                   "list_pull_requests", "read_pull_request", "get_ci_status"}


def build_server(ctx: ToolContext, only: set[str] | None = None):
    org = get_settings().gitea_org

    async def upload(db, paths: list[str]) -> list[int]:
        """Turn workspace file paths into stored attachments."""
        if not paths:
            return []
        if ctx.workspace is None:
            raise mail.MailError("attachments are not available in this session")
        root = ctx.workspace.resolve()
        ids = []
        for raw in paths:
            path = (root / raw).resolve()
            if root not in path.parents or not path.is_file():
                raise mail.MailError(f"attachment not found in your workspace: {raw}")
            att = await mail.store_attachment(db, uploaded_by=ctx.address, filename=path.name,
                                              data=path.read_bytes(), content_type=mimetypes.guess_type(path.name)[0])
            ids.append(att.id)
        return ids

    ATTACH = str_list("Files from your working directory to attach (relative paths), e.g. screenshots, reports")

    def check_repo(repo: str) -> str | None:
        if repo not in ctx.repos:
            return f"you don't have access to repo '{repo}'. Your repos: {sorted(ctx.repos) or 'none'}"
        return None

    def slim_issue(i: dict) -> dict:
        return {"number": i["number"], "title": i["title"], "state": i["state"],
                "author": (i.get("user") or {}).get("login"),
                "assignees": [a["login"] for a in i.get("assignees") or []],
                "labels": [lbl["name"] for lbl in i.get("labels") or []],
                "is_pull": bool(i.get("pull_request")), "updated_at": i.get("updated_at")}

    # ---- mail ------------------------------------------------------------
    @tool("send_email", "Start a new email thread.", schema({
        "to": str_list("Recipient addresses"), "cc": str_list("CC addresses (optional)"),
        "subject": {"type": "string"}, "body": {"type": "string", "description": "Markdown body"},
        "attachments": ATTACH,
    }, ["to", "subject", "body"]))
    async def send_email(args):
        async with SessionLocal() as db:
            try:
                ids = await upload(db, args.get("attachments") or [])
                msg = await mail.send(db, sender=ctx.address, to=args["to"], cc=args.get("cc") or [],
                                      subject=args["subject"], body=args["body"], attachment_ids=ids)
            except mail.MailError as e:
                return err(str(e))
        return ok(f"Sent (thread #{msg.thread_id}).")

    @tool("reply_email", "Reply in an existing thread. By default replies to all other participants.", schema({
        "thread_id": {"type": "integer"}, "body": {"type": "string"},
        "to": str_list("Override recipients (optional)"), "cc": str_list("CC (optional)"),
        "attachments": ATTACH,
    }, ["thread_id", "body"]))
    async def reply_email(args):
        async with SessionLocal() as db:
            thread = await db.get(Thread, args["thread_id"])
            if thread is None:
                return err("thread not found")
            to = args.get("to")
            if not to:
                participants = {m.sender for m in thread.messages} | {r.address for m in thread.messages for r in m.recipients}
                to = sorted(participants - {ctx.address})
            try:
                ids = await upload(db, args.get("attachments") or [])
                await mail.send(db, sender=ctx.address, to=to, cc=args.get("cc") or [], body=args["body"],
                                thread_id=thread.id, attachment_ids=ids)
            except mail.MailError as e:
                return err(str(e))
        return ok(f"Replied to thread #{args['thread_id']}.")

    @tool("list_inbox", "List your email threads (most recent first).", schema({
        "folder": {"type": "string", "enum": ["inbox", "sent"]}}, []))
    async def list_inbox(args):
        async with SessionLocal() as db:
            threads = await mail.mailbox(db, ctx.address, args.get("folder") or "inbox")
        return ok([{k: t[k] for k in ("id", "subject", "last_sender", "unread", "updated_at", "snippet")}
                   for t in threads[:30]])

    @tool("read_thread", "Read a full email thread.", schema({"thread_id": {"type": "integer"}}, ["thread_id"]))
    async def read_thread(args):
        async with SessionLocal() as db:
            thread = await db.get(Thread, args["thread_id"])
            if thread is None:
                return err("thread not found")
            participants = {m.sender for m in thread.messages} | {r.address for m in thread.messages for r in m.recipients}
            if ctx.address not in participants:
                return err("you are not part of that thread")
            await mail.mark_read(db, thread.id, ctx.address)
            if ctx.workspace is not None:
                mail.materialize(thread, ctx.workspace)
            return ok(mail.render_thread(thread, await mail.directory(db, include_fired=True)))

    # ---- team ------------------------------------------------------------
    @tool("list_team", "List all active teammates with role, email, Gitea username and projects.", schema({}, []))
    async def list_team(args):
        async with SessionLocal() as db:
            agents = (await db.scalars(select(Agent).where(Agent.status == "active"))).unique().all()
            return ok([{"name": a.name, "role": a.role.name, "email": mail.agent_address(a),
                        "gitea_username": a.gitea_username, "can_merge": a.role.can_merge,
                        "responsibilities": a.responsibilities,
                        "projects": [m.project.repo_name for m in a.memberships]} for a in agents])

    @tool("get_project", "Get a project's description and members.", schema({"repo": REPO}, ["repo"]))
    async def get_project(args):
        async with SessionLocal() as db:
            p = await db.scalar(select(Project).where(Project.repo_name == args["repo"]))
            if p is None:
                return err("no such project")
            return ok({"name": p.name, "repo": p.repo_name, "status": p.status, "description": p.description,
                       "members": [{"name": m.agent.name, "gitea_username": m.agent.gitea_username,
                                    "project_role": m.project_role} for m in p.members]})

    # ---- gitea: issues ---------------------------------------------------
    @tool("list_issues", "List issues (and optionally PRs) in a repo.", schema({
        "repo": REPO, "state": {"type": "string", "enum": ["open", "closed", "all"]},
        "assignee": {"type": "string", "description": "Filter by Gitea username"},
    }, ["repo"]))
    async def list_issues(args):
        if e := check_repo(args["repo"]):
            return err(e)
        async with agent_client(ctx.token_enc) as gc:
            items = await gc.list_issues(org, args["repo"], state=args.get("state") or "open",
                                         assignee=args.get("assignee"))
        return ok([slim_issue(i) for i in items])

    @tool("read_issue", "Read an issue (or PR conversation) with its comments.", schema({"repo": REPO, "number": NUMBER},
                                                                                        ["repo", "number"]))
    async def read_issue(args):
        if e := check_repo(args["repo"]):
            return err(e)
        async with agent_client(ctx.token_enc) as gc:
            issue = await gc.get_issue(org, args["repo"], args["number"])
            comments = await gc.list_comments(org, args["repo"], args["number"])
        return ok({**slim_issue(issue), "body": issue.get("body", ""),
                   "comments": [{"id": c["id"], "author": c["user"]["login"], "body": c["body"],
                                 "created_at": c["created_at"]} for c in comments]})

    @tool("create_issue", "Create an issue.", schema({
        "repo": REPO, "title": {"type": "string"}, "body": {"type": "string"},
        "assignees": str_list("Gitea usernames to assign"),
    }, ["repo", "title", "body"]))
    async def create_issue(args):
        if e := check_repo(args["repo"]):
            return err(e)
        async with agent_client(ctx.token_enc) as gc:
            issue = await gc.create_issue(org, args["repo"], args["title"], args["body"], args.get("assignees"))
        return ok(f"Created {args['repo']}#{issue['number']}.")

    @tool("update_issue", "Update an issue: close/reopen, change assignees, title or body.", schema({
        "repo": REPO, "number": NUMBER, "state": {"type": "string", "enum": ["open", "closed"]},
        "assignees": str_list("Replace assignees with these Gitea usernames"),
        "title": {"type": "string"}, "body": {"type": "string"},
    }, ["repo", "number"]))
    async def update_issue(args):
        if e := check_repo(args["repo"]):
            return err(e)
        fields = {k: args[k] for k in ("state", "assignees", "title", "body") if k in args}
        async with agent_client(ctx.token_enc) as gc:
            await gc.edit_issue(org, args["repo"], args["number"], **fields)
        return ok(f"Updated {args['repo']}#{args['number']}.")

    @tool("comment", "Comment on an issue or pull request. Use @username to mention someone.", schema({
        "repo": REPO, "number": NUMBER, "body": {"type": "string"}}, ["repo", "number", "body"]))
    async def comment(args):
        if e := check_repo(args["repo"]):
            return err(e)
        async with agent_client(ctx.token_enc) as gc:
            await gc.comment(org, args["repo"], args["number"], args["body"])
        return ok("Comment posted.")

    # ---- gitea: pull requests -------------------------------------------
    @tool("list_pull_requests", "List pull requests in a repo.", schema({
        "repo": REPO, "state": {"type": "string", "enum": ["open", "closed", "all"]}}, ["repo"]))
    async def list_pull_requests(args):
        if e := check_repo(args["repo"]):
            return err(e)
        async with agent_client(ctx.token_enc) as gc:
            pulls = await gc.list_pulls(org, args["repo"], args.get("state") or "open")
        return ok([{"number": p["number"], "title": p["title"], "state": p["state"], "merged": p.get("merged"),
                    "author": p["user"]["login"], "head": p["head"]["ref"], "base": p["base"]["ref"],
                    "reviewers": [r["login"] for r in p.get("requested_reviewers") or []]} for p in pulls])

    @tool("read_pull_request", "Read a pull request: description, diff and conversation.", schema({
        "repo": REPO, "number": NUMBER}, ["repo", "number"]))
    async def read_pull_request(args):
        if e := check_repo(args["repo"]):
            return err(e)
        async with agent_client(ctx.token_enc) as gc:
            pr = await gc.get_pull(org, args["repo"], args["number"])
            diff = await gc.get_pull_diff(org, args["repo"], args["number"])
            comments = await gc.list_comments(org, args["repo"], args["number"])
        if len(diff) > MAX_DIFF_CHARS:
            diff = diff[:MAX_DIFF_CHARS] + "\n... (diff truncated; check out the branch to see everything)"
        return ok({"number": pr["number"], "title": pr["title"], "body": pr.get("body", ""), "state": pr["state"],
                   "merged": pr.get("merged"), "mergeable": pr.get("mergeable"), "author": pr["user"]["login"],
                   "head": pr["head"]["ref"], "base": pr["base"]["ref"],
                   "comments": [{"author": c["user"]["login"], "body": c["body"]} for c in comments],
                   "diff": diff})

    @tool("open_pull_request", "Open a pull request from a pushed branch and request reviewers.", schema({
        "repo": REPO, "head": {"type": "string", "description": "Your pushed branch"},
        "base": {"type": "string", "description": "Target branch, usually main"},
        "title": {"type": "string"},
        "body": {"type": "string", "description": "Markdown text (not a shell command). Include 'Closes #<n>'"},
        "reviewers": str_list("Gitea usernames to request review from"),
    }, ["repo", "head", "title", "body"]))
    async def open_pull_request(args):
        if e := check_repo(args["repo"]):
            return err(e)
        async with agent_client(ctx.token_enc) as gc:
            pr = await gc.create_pull(org, args["repo"], args["head"], args.get("base") or "main",
                                      args["title"], args["body"])
            if args.get("reviewers"):
                await gc.request_reviewers(org, args["repo"], pr["number"], args["reviewers"])
        return ok(f"Opened PR {args['repo']}#{pr['number']}.")

    @tool("get_ci_status", "CI (Gitea Actions) status for a branch, commit SHA or pull request.", schema({
        "repo": REPO, "ref": {"type": "string", "description": "Branch name or commit SHA"},
        "pull_request": {"type": "integer", "description": "Alternatively, a PR number (uses its head commit)"},
    }, ["repo"]))
    async def get_ci_status(args):
        if e := check_repo(args["repo"]):
            return err(e)
        async with agent_client(ctx.token_enc) as gc:
            ref = args.get("ref")
            if args.get("pull_request"):
                ref = (await gc.get_pull(org, args["repo"], args["pull_request"]))["head"]["sha"]
            if not ref:
                return err("give a ref or a pull_request number")
            return ok(summarize_ci(await gc.combined_status(org, args["repo"], ref), ref))

    @tool("wait_for_ci", "Get woken up when CI finishes on a pull request. Use this instead of re-checking a "
          "pending CI run; then end your turn.", schema({"repo": REPO, "pull_request": NUMBER},
                                                        ["repo", "pull_request"]))
    async def wait_for_ci(args):
        if e := check_repo(args["repo"]):
            return err(e)
        async with agent_client(ctx.token_enc) as gc:
            pr = await gc.get_pull(org, args["repo"], args["pull_request"])
            sha = pr["head"]["sha"]
            status = await gc.combined_status(org, args["repo"], sha)
        if status.get("state") in ("success", "failure", "error"):
            return ok("CI has already finished:\n" + summarize_ci(status, sha))
        await infra.add_ci_watcher(args["repo"], sha, ctx.agent_id)
        return ok(f"OK — you'll get a new task when CI on {args['repo']}#{args['pull_request']} finishes. "
                  "End your turn now.")

    @tool("request_review", "Request review on a pull request.", schema({
        "repo": REPO, "number": NUMBER, "reviewers": str_list("Gitea usernames")}, ["repo", "number", "reviewers"]))
    async def request_review(args):
        if e := check_repo(args["repo"]):
            return err(e)
        async with agent_client(ctx.token_enc) as gc:
            await gc.request_reviewers(org, args["repo"], args["number"], args["reviewers"])
        return ok("Review requested.")

    @tool("submit_review", "Submit a review on someone else's pull request.", schema({
        "repo": REPO, "number": NUMBER,
        "verdict": {"type": "string", "enum": ["approve", "request_changes", "comment"]},
        "body": {"type": "string", "description": "Specific, actionable feedback"},
    }, ["repo", "number", "verdict", "body"]))
    async def submit_review(args):
        if e := check_repo(args["repo"]):
            return err(e)
        event = {"approve": "APPROVED", "request_changes": "REQUEST_CHANGES", "comment": "COMMENT"}[args["verdict"]]
        async with agent_client(ctx.token_enc) as gc:
            await gc.submit_review(org, args["repo"], args["number"], event, args["body"])
        return ok("Review submitted.")

    tools = [send_email, reply_email, list_inbox, read_thread, list_team, get_project, list_issues, read_issue,
             create_issue, update_issue, comment, list_pull_requests, read_pull_request, open_pull_request,
             get_ci_status, wait_for_ci, request_review, submit_review]

    if ctx.can_merge:
        @tool("merge_pull_request", "Merge an approved pull request (squash).", schema({
            "repo": REPO, "number": NUMBER}, ["repo", "number"]))
        async def merge_pull_request(args):
            if e := check_repo(args["repo"]):
                return err(e)
            async with agent_client(ctx.token_enc) as gc:
                await gc.merge_pull(org, args["repo"], args["number"])
            return ok(f"Merged {args['repo']}#{args['number']}.")

        tools.append(merge_pull_request)

    if only is not None:
        tools = [t for t in tools if t.name in only]

    # Surface Gitea failures to the model as tool errors instead of crashing the run.
    for t in tools:
        t.handler = _guard(t.handler)

    server = create_sdk_mcp_server(name=SERVER_NAME, version="1.0.0", tools=tools)
    return server, [f"mcp__{SERVER_NAME}__{t.name}" for t in tools]


def summarize_ci(status: dict, ref: str) -> str:
    statuses = status.get("statuses") or []
    if not statuses:
        return f"No CI runs for {ref[:12]} (the repo may have no .gitea/workflows yet, or CI hasn't started)."
    base = get_settings().gitea_public_url.rstrip("/")
    lines = [f"Overall: {status.get('state')} for {ref[:12]}"]
    for st in statuses:
        lines.append(f"- {st['context']}: {st['status']} — {st.get('description') or ''} "
                     f"({base}{st.get('target_url') or ''})")
    if status.get("state") == "pending":
        lines.append("CI is still running. Don't poll: call wait_for_ci and end your turn — you'll be woken when "
                     "it finishes.")
    if status.get("state") in ("failure", "error"):
        lines.append("Reproduce failures locally in your clone (e.g. `npm ci && npm test`), fix, and push.")
    return "\n".join(lines)


def _guard(fn):
    async def wrapped(args):
        try:
            return await fn(args)
        except GiteaError as e:
            return err(str(e))
    return wrapped
