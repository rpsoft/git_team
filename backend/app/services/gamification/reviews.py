"""Leaderboards and periodic performance reviews."""

import json
import logging
from datetime import datetime, timedelta

from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import utcnow
from app.models import ActivityEvent, Agent, AgentTask, PerformanceReview, XPAward
from app.services import mail
from app.services.gamification.engine import stats
from app.services.gamification.rules import morale_band
from app.services.settings_store import feature_enabled, get_setting

log = logging.getLogger(__name__)

LEADERBOARD_METRICS = ("xp", "pr_merged", "review_submitted", "issue_closed", "commits")

REVIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "rating": {"type": "integer", "description": "1 (poor) to 5 (outstanding)"},
        "recommendation": {"type": "string", "enum": ["promote", "keep", "coach", "fire"]},
        "summary": {"type": "string", "description": "The written review in markdown, 120-250 words."},
    },
    "required": ["rating", "recommendation", "summary"],
    "additionalProperties": False,
}


async def leaderboard(db: AsyncSession, metric: str = "xp", days: int | None = None,
                      project_id: int | None = None) -> list[dict]:
    since = utcnow() - timedelta(days=days) if days else None
    agents = (await db.scalars(select(Agent).where(Agent.status == "active"))).all()
    if project_id is not None:
        agents = [a for a in agents if any(m.project_id == project_id for m in a.memberships)]
    rows = []
    for agent in agents:
        if metric == "xp":
            if since is None:
                score = agent.xp
            else:
                score = await db.scalar(
                    select(func.coalesce(func.sum(XPAward.amount), 0)).where(
                        XPAward.agent_id == agent.id, XPAward.created_at >= since
                    )
                ) or 0
        else:
            score = (await stats(db, agent.id, since)).get(metric, 0)
        rows.append({"agent_id": agent.id, "name": agent.name, "handle": agent.handle, "level": agent.level,
                     "role": agent.role.name, "score": int(score)})
    rows.sort(key=lambda r: r["score"], reverse=True)
    for i, r in enumerate(rows, start=1):
        r["rank"] = i
    return rows


async def review_metrics(db: AsyncSession, agent: Agent, start: datetime, end: datetime) -> dict:
    counters = await stats(db, agent.id, start)
    tasks = (await db.scalars(
        select(AgentTask).where(AgentTask.agent_id == agent.id, AgentTask.started_at >= start)
    )).all()
    xp = await db.scalar(
        select(func.coalesce(func.sum(XPAward.amount), 0)).where(XPAward.agent_id == agent.id,
                                                                 XPAward.created_at >= start)
    ) or 0
    return {
        "xp_gained": int(xp),
        "level": agent.level,
        "morale": round(agent.morale),
        "prs_opened": counters.get("pr_opened", 0),
        "prs_merged": counters.get("pr_merged", 0),
        "changes_requested_on_their_prs": counters.get("pr_changes_requested", 0),
        "reviews_submitted": counters.get("review_submitted", 0),
        "issues_opened": counters.get("issue_opened", 0),
        "issues_closed": counters.get("issue_closed", 0),
        "commits": counters.get("commits", 0),
        "kudos": counters.get("kudos", 0),
        "tasks_total": len(tasks),
        "tasks_failed": sum(1 for t in tasks if t.status == "failed"),
        "cost_usd": round(sum(t.cost_usd for t in tasks), 2),
    }


async def _write_review(agent: Agent, metrics: dict, highlights: list[str], morale_on: bool) -> dict:
    s = get_settings()
    prompt = (
        f"You are the HR department of a software studio whose team members are AI agents.\n"
        f"Write a fair, specific performance review for {agent.name} (@{agent.handle}), "
        f"role: {agent.role.name}.\n\n"
        f"Responsibilities:\n" + "\n".join(f"- {r}" for r in (agent.responsibilities or agent.role.responsibilities))
        + f"\n\nMetrics for the period (JSON):\n{json.dumps(metrics, indent=2)}\n\n"
        f"Notable activity:\n" + ("\n".join(f"- {h}" for h in highlights[:40]) or "- (none)")
        + ("\n\nMorale: " + morale_band(agent.morale) if morale_on else "")
        + "\n\nJudge output relative to the role (a reviewer is measured on reviews, a developer on merged work). "
        "Recommend 'fire' only for sustained lack of output or high failure rates; 'coach' for fixable issues."
    )
    options = ClaudeAgentOptions(
        model=s.review_model,
        effort="medium",
        tools=[],  # pure writing task
        setting_sources=[],
        max_turns=3,
        output_format={"type": "json_schema", "schema": REVIEW_SCHEMA},
        env=s.claude_env(),
    )
    result: ResultMessage | None = None
    async for message in query(prompt=prompt, options=options):
        if isinstance(message, ResultMessage):
            result = message
    if result is None or result.is_error:
        raise RuntimeError(f"review generation failed: {result.subtype if result else 'no result'}")
    if isinstance(result.structured_output, dict):
        return result.structured_output
    return json.loads(result.result or "")


async def run_reviews(db: AsyncSession, force: bool = False) -> list[PerformanceReview]:
    """Create a review for every active agent and email the batch to the manager."""
    if not force and not await feature_enabled(db, "leaderboard"):
        return []
    s = get_settings()
    days = int(await get_setting(db, "review_period_days") or 7)
    end = utcnow()
    start = end - timedelta(days=days)
    morale_on = await feature_enabled(db, "morale")
    reviews: list[PerformanceReview] = []
    for agent in (await db.scalars(select(Agent).where(Agent.status == "active"))).all():
        metrics = await review_metrics(db, agent, start, end)
        highlights = [
            e.summary for e in (await db.scalars(
                select(ActivityEvent).where(ActivityEvent.agent_id == agent.id, ActivityEvent.created_at >= start)
                .order_by(ActivityEvent.id.desc()).limit(40)
            )).all() if e.summary
        ]
        try:
            written = await _write_review(agent, metrics, highlights, morale_on)
        except Exception as exc:  # keep going for other agents
            log.exception("review for %s failed", agent.handle)
            written = {"rating": 3, "recommendation": "keep", "summary": f"_Automatic review failed: {exc}_"}
        review = PerformanceReview(
            agent_id=agent.id, period_start=start, period_end=end, metrics=metrics,
            rating=max(1, min(5, int(written["rating"]))), recommendation=written["recommendation"],
            summary=written["summary"],
        )
        db.add(review)
        reviews.append(review)
    await db.commit()
    if reviews:
        names = {a.id: a for a in (await db.scalars(select(Agent))).all()}
        body = [f"Performance reviews for {start:%b %d} – {end:%b %d}.", ""]
        for r in sorted(reviews, key=lambda r: -r.rating):
            a = names[r.agent_id]
            body += [f"## {a.name} (@{a.handle}) — {'★' * r.rating}{'☆' * (5 - r.rating)} · {r.recommendation.upper()}",
                     "", r.summary, ""]
        body.append("Open the Reviews page in the dashboard to act on these recommendations.")
        await mail.send(db, sender=s.hr_address, to=[s.manager_address],
                        subject=f"Performance reviews · {end:%Y-%m-%d}", body="\n".join(body), wake_agents=False)
    return reviews
