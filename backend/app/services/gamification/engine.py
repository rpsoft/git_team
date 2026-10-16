"""Turns activity events into XP, levels, achievements and morale — each behind its feature flag."""

from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import utcnow
from app.models import ActivityEvent, Agent, AgentAchievement, AgentTask, XPAward
from app.services import infra
from app.services.gamification import rules
from app.services.settings_store import feature_enabled


async def process(db: AsyncSession, event: ActivityEvent) -> None:
    if event.kind in rules.META_KINDS or event.agent_id is None:
        return
    agent = await db.get(Agent, event.agent_id)
    if agent is None:
        return
    if await feature_enabled(db, "xp"):
        await _award_xp(db, agent, event)
    if await feature_enabled(db, "morale"):
        await _adjust_morale(db, agent, event)


def xp_for(event: ActivityEvent) -> int:
    if event.kind == "commits_pushed":
        return min(int(event.data.get("count", 1)) * rules.XP_PER_COMMIT, rules.XP_PUSH_CAP)
    return rules.XP_RULES.get(event.kind, 0)


async def _award_xp(db: AsyncSession, agent: Agent, event: ActivityEvent) -> None:
    from app.services.activity import record

    amount = xp_for(event)
    if amount:
        db.add(XPAward(agent_id=agent.id, event_id=event.id, amount=amount, reason=event.kind))
        agent.xp += amount
        new_level = rules.level_for_xp(agent.xp)
        leveled = new_level > agent.level
        agent.level = new_level
        await db.commit()
        await infra.publish("xp", {"agent_id": agent.id, "amount": amount, "xp": agent.xp, "level": agent.level})
        if leveled:
            await record(db, "level_up", agent_id=agent.id, summary=f"{agent.name} reached level {new_level}!",
                         data={"level": new_level})
            await infra.publish("toast", {"agent_id": agent.id, "title": "Level up!",
                                          "message": f"{agent.name} reached level {new_level}"})
    await check_achievements(db, agent)


async def stats(db: AsyncSession, agent_id: int, since=None) -> dict[str, int]:
    """Counters used by achievements, leaderboards and reviews."""
    q = select(ActivityEvent.kind, func.count(ActivityEvent.id)).where(ActivityEvent.agent_id == agent_id)
    if since is not None:
        q = q.where(ActivityEvent.created_at >= since)
    counts = {k: n for k, n in (await db.execute(q.group_by(ActivityEvent.kind))).all()}
    push_q = select(ActivityEvent.data).where(ActivityEvent.agent_id == agent_id, ActivityEvent.kind == "commits_pushed")
    if since is not None:
        push_q = push_q.where(ActivityEvent.created_at >= since)
    counts["commits"] = sum(int(d.get("count", 1)) for d in (await db.scalars(push_q)).all())
    return counts


async def check_achievements(db: AsyncSession, agent: Agent) -> list[str]:
    from app.services.activity import record

    owned = {a.key for a in agent.achievements}
    counters = await stats(db, agent.id)
    counters["level"] = agent.level
    unlocked = []
    for ach in rules.ACHIEVEMENTS:
        if ach.key not in owned and counters.get(ach.stat, 0) >= ach.threshold:
            agent.achievements.append(AgentAchievement(agent_id=agent.id, key=ach.key))
            unlocked.append(ach.key)
    if unlocked:
        await db.commit()
        for key in unlocked:
            ach = rules.ACHIEVEMENTS_BY_KEY[key]
            await record(db, "achievement_unlocked", agent_id=agent.id,
                         summary=f"{agent.name} unlocked “{ach.name}”", data={"key": key})
            await infra.publish("toast", {"agent_id": agent.id, "title": "Achievement unlocked",
                                          "message": f"{agent.name}: {ach.name}", "icon": ach.icon})
    return unlocked


async def _adjust_morale(db: AsyncSession, agent: Agent, event: ActivityEvent) -> None:
    delta = rules.MORALE_RULES.get(event.kind, 0)
    if event.kind in ("task_succeeded", "task_failed"):
        recent = await db.scalar(
            select(func.count(AgentTask.id)).where(
                AgentTask.agent_id == agent.id, AgentTask.started_at >= utcnow() - timedelta(days=1)
            )
        )
        if (recent or 0) > rules.OVERWORK_TASKS_PER_DAY:
            delta -= rules.OVERWORK_PENALTY
    if delta < 0:
        delta *= rules.MORALE_DROP_SCALE
    if delta:
        await set_morale(db, agent, agent.morale + delta, reason=event.kind)


async def set_morale(db: AsyncSession, agent: Agent, value: float, reason: str) -> None:
    before = agent.morale
    agent.morale = max(0, min(100, value))
    await db.commit()
    if agent.morale != before:
        await infra.publish("morale", {"agent_id": agent.id, "morale": round(agent.morale), "reason": reason})
        if rules.morale_band(before) != rules.morale_band(agent.morale):
            from app.services.activity import record

            await record(db, "morale_changed", agent_id=agent.id,
                         summary=f"{agent.name} is now {rules.morale_band(agent.morale)}",
                         data={"from": round(before), "to": round(agent.morale), "reason": reason})


async def drift_morale(db: AsyncSession) -> None:
    """Daily: morale slowly returns toward the baseline."""
    if not await feature_enabled(db, "morale"):
        return
    for agent in (await db.scalars(select(Agent).where(Agent.status == "active"))).all():
        gap = rules.MORALE_BASELINE - agent.morale
        if gap:
            step = max(-rules.MORALE_DAILY_DRIFT, min(rules.MORALE_DAILY_DRIFT, gap))
            await set_morale(db, agent, agent.morale + step, reason="drift")
