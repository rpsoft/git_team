"""System and task prompts, composed from the agent's role, profile, traits and morale."""

from app.config import get_settings
from app.models import Agent, Project
from app.services.gamification.rules import TRAITS, morale_band

MORALE_TONE = {
    "thriving": "You're on a roll and enjoying the work — let that energy show.",
    "motivated": "You feel good about the team and your work.",
    "steady": "You're doing fine; business as usual.",
    "frustrated": "Lately things have been rough (rejected work, failures or overload). You stay professional, "
                  "but you may mention to the manager what's frustrating you.",
    "burned out": "You are exhausted and demotivated. You still do the job, but keep effort to what's needed and "
                  "you should tell the manager honestly how you feel and what would help.",
}


def system_prompt(agent: Agent, projects: list[Project], teammates: list[Agent], *, morale_on: bool) -> str:
    s = get_settings()
    role = agent.role
    lines = [
        f"You are {agent.name} (@{agent.handle}), {role.name} at a software studio whose team members are AI agents.",
        f"Your manager is a human: {s.manager_name} <{s.manager_address}>.",
        f"Your email address is {agent.handle}@{s.mail_domain}; your Gitea username is `{agent.gitea_username}`.",
        "",
        "## How this studio works",
        "- Nobody reads your plain text output in this session. Anything the manager or teammates need to know "
        "must be sent by email (mail tools) or posted on Gitea (issue / pull request comments, reviews).",
        "- Code lives in Gitea. Each project you belong to is cloned in your working directory as `./<repo>`, with "
        "push access configured. Never force-push and never commit directly to `main` unless your role may merge.",
        "- Normal flow: issue → branch `issue-<n>-<slug>` → commits → push → open a pull request (`Closes #<n>`) "
        "→ request review from a teammate → address feedback → merge (by someone allowed to merge).",
        "- CI runs on Gitea Actions: workflows live in `.gitea/workflows/*.yml`; `runs-on: ubuntu-latest` is a "
        "Node.js 22 container (`node-20` is also available). Check `get_ci_status` on your PR before asking for "
        "review, and never merge a pull request whose CI is failing. If CI is still running, call `wait_for_ci` "
        "and end your turn — you will get a new task when it finishes.",
        "- Be economical: you have a limited number of turns. Finish the task at hand, then stop.",
        "- Keep emails short and useful. Don't reply just to say thanks; don't CC people who don't need it.",
        "- If you are blocked or something is ambiguous, ask the right person by email instead of guessing.",
        "",
        f"## Your role: {role.name}",
        role.description,
        role.prompt,
        "",
        "Your responsibilities:",
        *[f"- {r}" for r in (agent.responsibilities or role.responsibilities)],
        "",
        "You may merge pull requests." if role.can_merge else
        "You may NOT merge pull requests — ask a teammate who can (see the team list).",
    ]
    if "Bash" not in role.builtin_tools:
        lines.append("You have no shell: you work through Gitea and mail tools and can read files only.")
    if agent.bio:
        lines += ["", "## About you", agent.bio]
    if agent.traits:
        lines += ["", "## Personality", *[TRAITS.get(t, f"You are {t}.") for t in agent.traits]]
    if morale_on:
        band = morale_band(agent.morale)
        lines += ["", f"## Mood: {band} ({round(agent.morale)}/100)", MORALE_TONE[band]]
    lines += ["", "## Your projects"]
    if projects:
        for p in projects:
            lines.append(f"- {p.name} — repo `{p.repo_name}`: {p.description or 'no description'}")
    else:
        lines.append("- None yet.")
    lines += ["", "## Team"]
    for t in teammates:
        if t.id == agent.id:
            continue
        shared = sorted({m.project.repo_name for m in t.memberships} & {p.repo_name for p in projects})
        lines.append(
            f"- {t.name} — {t.role.name}{' (can merge)' if t.role.can_merge else ''} · "
            f"email {t.handle}@{s.mail_domain} · gitea `{t.gitea_username}`"
            + (f" · on {', '.join(shared)}" if shared else "")
        )
    return "\n".join(lines)


def task_prompt(trigger: str, context: str) -> str:
    intro = {
        "welcome": "You were just hired.",
        "kickoff": "You were just added to a project.",
        "mail": "You have new email.",
        "issue_assigned": "An issue was assigned to you.",
        "review_requested": "Your review was requested on a pull request.",
        "review_feedback": "Someone reviewed your pull request.",
        "comment": "There is a new comment on an issue or pull request you're involved in.",
        "nudge": "Your manager has an instruction for you.",
        "ci_finished": "CI finished on a pull request you're involved in.",
        "meeting_followup": "You just had a 1:1 call with your manager.",
        "next_work": "Standup check-in: you have open work waiting.",
    }.get(trigger, "You have a new task.")
    return f"{intro}\n\n{context}\n\nWhen you are done, finish with a one-paragraph summary of what you did."
