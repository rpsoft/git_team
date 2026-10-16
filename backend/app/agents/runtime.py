"""Runs one agent task with the Claude Agent SDK.

A task = (agent, trigger, ref). The runtime builds the context for the trigger, prepares a
fresh workspace with the agent's project repos cloned using the agent's own Gitea token,
runs Claude with the studio tools, and records cost, transcript and outcome.
"""

import asyncio
import logging
import os
import shutil
import warnings
from datetime import timedelta
from pathlib import Path
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    CLIConnectionError,
    ProcessError,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    PermissionResultAllow,
    PermissionResultDeny,
    ResultMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
from sqlalchemy import func, select

from app.agents import prompts
from app.agents.tools import ToolContext, build_server, summarize_ci
from app.config import get_settings
from app.db import SessionLocal, utcnow
from app.models import Agent, AgentTask, Meeting, Message, Project, Recipient, Thread
from app.services import infra, mail
from app.services.activity import record
from app.services.gitea import agent_client, clone_url
from app.services.meetings import render_transcript
from app.services.standup import account_error, render_queue
from app.services.settings_store import feature_enabled, get_setting

log = logging.getLogger(__name__)
# Studio MCP tools are deliberately auto-approved; can_use_tool only gates built-in file tools.
warnings.filterwarnings("ignore", message="can_use_tool will not be invoked")

MAX_CONTEXT_CHARS = 40_000
FILE_TOOLS = {"Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit"}


class InfraFailure(Exception):
    """Claude Code couldn't run at all (e.g. the container hit a resource limit). Not the agent's
    fault: the worker retries the job a few times instead of losing the work."""


class Deferred(Exception):
    """The task can't run right now (agent busy / agents paused); retry later."""

    def __init__(self, seconds: int):
        self.seconds = seconds


async def run(agent_id: int, trigger: str, ref: dict[str, Any]) -> int | None:
    """Entry point used by the worker. Returns the AgentTask id (None when skipped silently)."""
    begun = utcnow()
    async with SessionLocal() as db:
        agent = await db.get(Agent, agent_id)
        if agent is None or not agent.is_active or not agent.gitea_token_enc:
            return None
        if await get_setting(db, "agents_paused"):
            raise Deferred(120)

        built = await build_context(db, agent, trigger, ref)
        if built is None:
            return None  # nothing to do (e.g. mail already handled by an earlier run)
        title, context = built

        task = AgentTask(agent_id=agent.id, trigger=trigger, trigger_ref=ref, title=title[:500])
        db.add(task)

        spent = await db.scalar(
            select(func.coalesce(func.sum(AgentTask.cost_usd), 0.0)).where(
                AgentTask.agent_id == agent.id,
                AgentTask.started_at >= utcnow().replace(hour=0, minute=0, second=0, microsecond=0),
            )
        ) or 0.0
        remaining = agent.daily_budget_usd - float(spent)
        if remaining <= 0.01:
            task.status, task.finished_at = "skipped", utcnow()
            task.error = f"Daily budget of ${agent.daily_budget_usd:.2f} exhausted."
            await db.commit()
            await notify_budget_exhausted(db, agent, float(spent))
            await infra.publish("task", {"task_id": task.id, "agent_id": agent.id, "status": "skipped", "title": title})
            return task.id

        await db.commit()
        await infra.publish("task", {"task_id": task.id, "agent_id": agent.id, "status": "running", "title": title})

        projects = [m.project for m in agent.memberships if m.project.status != "archived"]
        teammates = (await db.scalars(select(Agent).where(Agent.status == "active"))).unique().all()
        morale_on = await feature_enabled(db, "morale")
        system = prompts.system_prompt(agent, projects, list(teammates), morale_on=morale_on)
        prompt = prompts.task_prompt(trigger, context)
        snapshot = {
            "agent_id": agent.id, "name": agent.name, "handle": agent.handle, "model": agent.model,
            "effort": agent.effort, "max_turns": agent.max_turns, "gitea_username": agent.gitea_username,
            "token_enc": agent.gitea_token_enc, "can_merge": agent.role.can_merge,
            "builtin_tools": list(agent.role.builtin_tools), "repos": [p.repo_name for p in projects],
        }
        task_id = task.id

    status, error, result = "succeeded", "", None
    infra_failure = False
    transcript: list[dict[str, Any]] = []
    workspace = Path(get_settings().workspaces_dir) / snapshot["handle"] / f"task-{task_id}"
    try:
        await prepare_workspace(workspace, snapshot)
        if trigger == "mail":
            async with SessionLocal() as db:
                thread = await db.get(Thread, ref["thread_id"])
                if thread is not None:
                    mail.materialize(thread, workspace)
        result = await execute(snapshot, system, prompt, workspace, remaining, transcript)
        if result is not None and result.is_error:
            status, error = "failed", f"{result.subtype}: {'; '.join(result.errors or []) or result.result or ''}"
            if account_error(error):
                infra_failure = True
                error = "Claude account limit (will retry): " + error
    except Exception as exc:
        log.exception("agent task %s failed", task_id)
        status, error = "failed", f"{type(exc).__name__}: {exc}"
        # Nothing ran at all and Claude Code itself failed to start/crashed: an infrastructure problem.
        infra_failure = result is None and not transcript and isinstance(exc, (CLIConnectionError, ProcessError, OSError))
        if infra_failure:
            error = "Infrastructure error (will retry): " + error
    finally:
        kill_workspace_processes(workspace)
        shutil.rmtree(workspace, ignore_errors=True)

    async with SessionLocal() as db:
        task = await db.get(AgentTask, task_id)
        task.status, task.error, task.finished_at = status, error[:4000], utcnow()
        task.transcript = transcript[-400:]
        if result is not None:
            usage = result.usage or {}
            task.cost_usd = result.total_cost_usd or 0.0
            task.num_turns = result.num_turns
            task.input_tokens = int(usage.get("input_tokens", 0)) + int(usage.get("cache_read_input_tokens", 0)) \
                + int(usage.get("cache_creation_input_tokens", 0))
            task.output_tokens = int(usage.get("output_tokens", 0))
            task.result = (result.result or "")[:8000]
        if infra_failure and trigger == "mail":
            # Hand the email back so the retry (or a later run) still sees it as unread.
            rows = (await db.scalars(select(Recipient).join(Message).where(
                Message.thread_id == ref["thread_id"], Recipient.address == f"{snapshot['handle']}@{get_settings().mail_domain}",
                Recipient.read_at >= begun))).all()
            for r in rows:
                r.read_at = None
        await db.commit()
        await infra.publish("task", {"task_id": task_id, "agent_id": snapshot["agent_id"], "status": status,
                                     "title": task.title, "cost_usd": task.cost_usd})
        if infra_failure:
            raise InfraFailure(error)
        await record(db, f"task_{status}", agent_id=snapshot["agent_id"],
                     summary=f"{snapshot['name']} {'finished' if status == 'succeeded' else 'failed'}: {task.title}",
                     data={"task_id": task_id, "trigger": trigger, "cost_usd": task.cost_usd})
    return task_id


async def build_context(db, agent: Agent, trigger: str, ref: dict[str, Any]) -> tuple[str, str] | None:
    """Returns (title, prompt context) for a trigger, or None if there's nothing to do."""
    s = get_settings()
    repo, number = ref.get("repo"), ref.get("number")

    if trigger in ("welcome", "kickoff") and await db.scalar(select(func.count(AgentTask.id)).where(
        AgentTask.agent_id == agent.id, AgentTask.trigger == trigger, AgentTask.status == "succeeded",
        *([AgentTask.trigger_ref["project_id"].as_integer() == ref.get("project_id")] if trigger == "kickoff" else []),
    )):
        return None  # one-off triggers only ever run once

    if trigger == "welcome":
        return ("Introduce yourself",
                f"Send {s.manager_name} <{s.manager_address}> a short introduction email: who you are, what you're "
                "good at, how you like to work, and ask what they'd like you to focus on first.")

    if trigger == "kickoff":
        project = await db.get(Project, ref.get("project_id"))
        if project is None:
            return None
        return (f"Join project {project.name}",
                f"You were added to project **{project.name}** (repo `{project.repo_name}`, cloned at "
                f"./{project.repo_name}).\nDescription: {project.description or '(none)'}\n\n"
                "Get familiar with the repository and its open issues. If issues are already assigned to you, "
                "start on the most important one. Otherwise send the manager a brief note that you're on board, "
                "with any first observations or questions. Keep it short.")

    if trigger == "mail":
        thread = await db.get(Thread, ref["thread_id"])
        if thread is None:
            return None
        address = mail.agent_address(agent)
        unread = (await db.scalars(
            select(Recipient).join(Message).where(
                Message.thread_id == thread.id, Recipient.address == address, Recipient.read_at.is_(None)
            )
        )).all()
        if not unread:
            return None
        now = utcnow()
        for r in unread:
            r.read_at = now
        await db.commit()
        rendered = mail.render_thread(thread, await mail.directory(db, include_fired=True))
        return (f"Email: {thread.subject}",
                f"New message(s) in email thread #{thread.id}. Read it and act on it: do the work requested, "
                f"then reply (reply_email, thread_id={thread.id}) if a reply is useful. If the latest message "
                f"needs no response from you (e.g. an FYI or a thank-you), do nothing.\n\n"
                + truncate(rendered))

    if trigger == "meeting_followup":
        meeting = await db.get(Meeting, ref.get("meeting_id"))
        if meeting is None or not meeting.action_items:
            return None
        return ("Follow up on 1:1",
                f"Here is the transcript of your 1:1 call with {s.manager_name}:\n\n"
                + truncate(render_transcript(meeting.transcript, agent.name))
                + "\n\nAction items you agreed to:\n" + "\n".join(f"- {a}" for a in meeting.action_items)
                + "\n\nDo them now, in the normal way (issues, branches, pull requests, emails to teammates). "
                  "Then send the manager a short recap email (subject \"1:1 follow-up\") saying what you did "
                  "and anything still open.")

    if trigger == "next_work":
        queue = ref.get("queue") or []
        if not queue:
            return None
        return ("Pick up next work",
                "You're free, and this is your open work, most urgent first:\n\n" + render_queue(queue)
                + "\n\nReviews come first because they unblock teammates, then fixing your own pull requests, "
                  "then merges, then your assigned issues. Respect any priorities the manager set by email "
                  "(check your inbox if unsure). Make real progress on the top item you can move forward — "
                  "finish it if possible — and stop. If everything is blocked, say so on the relevant issue "
                  "or email the person who can unblock you, then stop.")

    if trigger == "nudge":
        return (f"Manager: {ref['instruction'][:80]}",
                f"Instruction from {s.manager_name}:\n\n{ref['instruction']}")

    if not repo or repo not in {m.project.repo_name for m in agent.memberships}:
        return None  # webhook for a repo the agent isn't staffed on

    async with agent_client(agent.gitea_token_enc) as gc:
        if trigger == "issue_assigned":
            done = await db.scalar(select(func.count(AgentTask.id)).where(
                AgentTask.agent_id == agent.id, AgentTask.trigger == "issue_assigned",
                AgentTask.status == "succeeded", AgentTask.trigger_ref["repo"].as_string() == repo,
                AgentTask.trigger_ref["number"].as_integer() == number,
            ))
            if done:
                return None
            issue = await gc.get_issue(s.gitea_org, repo, number)
            if issue.get("state") != "open":
                return None
            comments = await gc.list_comments(s.gitea_org, repo, number)
            return (f"{repo}#{number}: {issue['title']}",
                    f"Issue {repo}#{number} is assigned to you.\n\n# {issue['title']}\n\n{issue.get('body') or ''}\n\n"
                    + render_comments(comments)
                    + "\nWork on it according to your role. When done, open a pull request (or, if no code change is "
                      "needed, comment and close the issue).")

        if trigger == "review_requested":
            pr = await gc.get_pull(s.gitea_org, repo, number)
            if pr.get("state") != "open":
                return None
            ci = summarize_ci(await gc.combined_status(s.gitea_org, repo, pr["head"]["sha"]), pr["head"]["sha"])
            return (f"Review {repo}#{number}: {pr['title']}",
                    f"Please review pull request {repo}#{number} \"{pr['title']}\" by {pr['user']['login']} "
                    f"(branch `{pr['head']['ref']}` → `{pr['base']['ref']}`).\nUse read_pull_request to see the diff, "
                    "optionally check out the branch to run tests, then submit_review with a clear verdict.\n\n"
                    f"CI:\n{ci}"
                    + (" If you approve and it's ready, you may merge it." if agent.role.can_merge else ""))

        if trigger == "review_feedback":
            pr = await gc.get_pull(s.gitea_org, repo, number)
            if pr.get("state") != "open":
                return None
            verdict = ref.get("verdict", "commented")
            follow_up = ("It was approved. If it's ready, merge it."
                         if verdict == "approved" else
                         "Address the feedback: push fixes to the same branch, reply on the PR, and re-request review.")
            return (f"Feedback on {repo}#{number}",
                    f"Your pull request {repo}#{number} \"{pr['title']}\" received a review ({verdict}):\n\n"
                    f"{ref.get('review') or '(no summary — see review comments)'}\n\n{follow_up}")

        if trigger == "ci_finished":
            if await db.scalar(select(func.count(AgentTask.id)).where(
                AgentTask.agent_id == agent.id, AgentTask.trigger == "ci_finished", AgentTask.status == "succeeded",
                AgentTask.trigger_ref["sha"].as_string() == ref.get("sha"),
            )):
                return None
            pr = await gc.get_pull(s.gitea_org, repo, number)
            if pr.get("state") != "open" or pr["head"]["sha"] != ref.get("sha"):
                return None  # merged/closed meanwhile, or new commits started a new CI run
            ci = summarize_ci(await gc.combined_status(s.gitea_org, repo, pr["head"]["sha"]), pr["head"]["sha"])
            reviews = await gc.request("GET", f"/repos/{s.gitea_org}/{repo}/pulls/{number}/reviews") or []
            latest: dict[str, str] = {}
            for r in reviews:
                if r.get("state") in ("APPROVED", "REQUEST_CHANGES"):
                    latest[(r.get("user") or {}).get("login", "?")] = r["state"]
            review_text = ", ".join(f"{u}: {st.lower()}" for u, st in latest.items()) or "no reviews yet"
            mine = pr["user"]["login"] == agent.gitea_username
            if ref.get("state") == "success":
                todo = ("If it is approved and has no outstanding change requests, merge it now. "
                        if agent.role.can_merge else
                        "If it is approved, ask a teammate who can merge to merge it (comment with an @mention). ")
                todo += "If you said you would do something once CI is green, do it now."
            else:
                todo = ("Fix it: check out the branch, reproduce the failure locally, push a fix to the same branch."
                        if mine else "Let the author know on the PR if they haven't noticed, or help fix it.")
            return (f"CI {ref.get('state')} on {repo}#{number}",
                    f"CI finished on pull request {repo}#{number} \"{pr['title']}\" by {pr['user']['login']} "
                    f"(branch `{pr['head']['ref']}`).\n\n{ci}\n\nReviews: {review_text}\n\n{todo}")

        if trigger == "comment":
            comments = await gc.list_comments(s.gitea_org, repo, number)
            issue = await gc.get_issue(s.gitea_org, repo, number)
            kind = "pull request" if ref.get("is_pull") else "issue"
            return (f"Comment on {repo}#{number}",
                    f"New comment on {kind} {repo}#{number} \"{issue['title']}\".\n\n"
                    + render_comments(comments[-15:])
                    + "\nRespond if the comment is addressed to you or needs your action; otherwise do nothing.")
    return None


async def notify_budget_exhausted(db, agent: Agent, spent: float) -> None:
    """Tell the manager (once per agent per day) that an agent has stopped for the day."""
    key = f"gitteam:budget-mail:{agent.id}:{utcnow():%Y-%m-%d}"
    if not await infra.get_redis().set(key, "1", nx=True, ex=2 * 86400):
        return
    s = get_settings()
    await mail.send(
        db, sender=s.hr_address, to=[s.manager_address], wake_agents=False,
        subject=f"{agent.name} is out of budget for today",
        body=f"{agent.name} ({agent.role.name}) has used today's budget: ${spent:.2f} of "
             f"${agent.daily_budget_usd:.2f} (API-equivalent).\n\n"
             "Their new tasks are being skipped until the budget resets at 00:00 UTC. To let them continue "
             "now, raise the **daily budget** on their profile (Edit) — they'll pick their work back up within "
             "about ten minutes.",
    )
    await infra.publish("toast", {"agent_id": agent.id, "title": "Out of budget",
                                  "message": f"{agent.name} stopped for today (${spent:.2f})"})


def render_comments(comments: list[dict]) -> str:
    if not comments:
        return ""
    out = ["## Comments"]
    for c in comments:
        out.append(f"**{c['user']['login']}** ({c['created_at']}):\n{c['body']}\n")
    return truncate("\n".join(out))


def truncate(text: str) -> str:
    return text if len(text) <= MAX_CONTEXT_CHARS else "…(earlier content truncated)…\n" + text[-MAX_CONTEXT_CHARS:]


async def prepare_workspace(workspace: Path, snap: dict[str, Any]) -> None:
    shutil.rmtree(workspace, ignore_errors=True)
    workspace.mkdir(parents=True)
    if "Bash" not in snap["builtin_tools"] and "Read" not in snap["builtin_tools"]:
        return
    token = infra.decrypt(snap["token_enc"])
    for repo in snap["repos"]:
        proc = await asyncio.create_subprocess_exec(
            "git", "clone", "--quiet", clone_url(repo, snap["gitea_username"], token), str(workspace / repo),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=git_env(snap),
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            log.warning("clone of %s failed: %s", repo, stderr.decode(errors="replace").replace(token, "***"))


def git_env(snap: dict[str, Any]) -> dict[str, str]:
    email = f"{snap['handle']}@{get_settings().mail_domain}"
    return {
        **os.environ,
        "GIT_AUTHOR_NAME": snap["name"], "GIT_AUTHOR_EMAIL": email,
        "GIT_COMMITTER_NAME": snap["name"], "GIT_COMMITTER_EMAIL": email,
        "GIT_TERMINAL_PROMPT": "0",
    }


def make_permission_check(workspace: Path):
    root = workspace.resolve()

    async def can_use_tool(name: str, tool_input: dict[str, Any], _ctx) -> PermissionResultAllow | PermissionResultDeny:
        if name in FILE_TOOLS:
            raw = tool_input.get("file_path") or tool_input.get("path") or tool_input.get("notebook_path") or "."
            target = (root / raw).resolve() if not os.path.isabs(raw) else Path(raw).resolve()
            if target != root and root not in target.parents:
                return PermissionResultDeny(message=f"Access outside your workspace ({root}) is not allowed.")
        return PermissionResultAllow()

    return can_use_tool


async def execute(snap: dict[str, Any], system: str, prompt: str, workspace: Path, budget_usd: float,
                  transcript: list[dict[str, Any]]) -> ResultMessage | None:
    s = get_settings()
    server, mcp_tool_names = build_server(ToolContext(
        agent_id=snap["agent_id"], handle=snap["handle"], gitea_username=snap["gitea_username"],
        token_enc=snap["token_enc"], can_merge=snap["can_merge"], repos=set(snap["repos"]), workspace=workspace,
    ))
    env = {k: v for k, v in git_env(snap).items() if k.startswith("GIT_")}
    env.update(s.claude_env())
    options = ClaudeAgentOptions(
        model=snap["model"],
        effort=snap["effort"],
        system_prompt={"type": "preset", "preset": "claude_code", "append": system},
        tools=snap["builtin_tools"],
        allowed_tools=mcp_tool_names,
        mcp_servers={"studio": server},
        strict_mcp_config=True,
        setting_sources=[],
        can_use_tool=make_permission_check(workspace),
        permission_mode="default",
        cwd=str(workspace),
        max_turns=snap["max_turns"],
        max_budget_usd=max(0.05, budget_usd),
        env=env,
    )
    result: ResultMessage | None = None
    async with ClaudeSDKClient(options=options) as client:
        await client.query(prompt)
        async for message in client.receive_response():
            if isinstance(message, AssistantMessage):
                for block in message.content:
                    if isinstance(block, TextBlock) and block.text.strip():
                        transcript.append({"type": "text", "text": block.text})
                    elif isinstance(block, ToolUseBlock):
                        transcript.append({"type": "tool_use", "id": block.id, "name": block.name,
                                           "input": block.input})
            elif isinstance(message, UserMessage) and isinstance(message.content, list):
                for block in message.content:
                    if isinstance(block, ToolResultBlock):
                        content = block.content
                        if isinstance(content, list):
                            content = "\n".join(c.get("text", "") for c in content if isinstance(c, dict))
                        transcript.append({"type": "tool_result", "tool_use_id": block.tool_use_id,
                                           "is_error": bool(block.is_error), "content": (content or "")[:4000]})
            elif isinstance(message, ResultMessage):
                result = message
                transcript.append({"type": "result", "subtype": message.subtype, "text": message.result or "",
                                   "cost_usd": message.total_cost_usd, "turns": message.num_turns})
    return result


def kill_workspace_processes(workspace: Path) -> int:
    """Kill anything an agent left running in its workspace (test watchers, dev servers, ...)."""
    root = str(workspace.resolve())
    killed = 0
    for entry in Path("/proc").glob("[0-9]*"):
        pid = int(entry.name)
        if pid == os.getpid():
            continue
        try:
            cwd = os.readlink(entry / "cwd")
            cmdline = (entry / "cmdline").read_bytes().decode(errors="replace")
        except OSError:
            continue  # gone, zombie, or not ours
        if cwd == root or cwd.startswith(root + "/") or root in cmdline:
            try:
                os.kill(pid, 9)
                killed += 1
            except OSError:
                pass
    if killed:
        log.info("killed %d leftover process(es) from %s", killed, root)
    return killed


async def stale_task_cleanup(all_running: bool = False) -> None:
    """Mark tasks that were 'running' when a worker died as failed.

    On worker startup every running task is stale (there's a single worker); the periodic cleanup
    only catches tasks that have been running implausibly long.
    """
    async with SessionLocal() as db:
        q = select(AgentTask).where(AgentTask.status == "running")
        if not all_running:
            q = q.where(AgentTask.started_at < utcnow() - timedelta(hours=3))
        for task in (await db.scalars(q)).all():
            task.status, task.error, task.finished_at = "failed", "worker restarted", utcnow()
        await db.commit()
