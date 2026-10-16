"""Activity ledger. Every meaningful thing goes through `record()` so gamification and
reports have a single source of truth."""

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ActivityEvent
from app.services import infra


async def record(
    db: AsyncSession,
    kind: str,
    *,
    agent_id: int | None = None,
    project_id: int | None = None,
    summary: str = "",
    data: dict[str, Any] | None = None,
    gamify: bool = True,
) -> ActivityEvent:
    event = ActivityEvent(kind=kind, agent_id=agent_id, project_id=project_id, summary=summary, data=data or {})
    db.add(event)
    await db.commit()
    await db.refresh(event)
    await infra.publish(
        "activity",
        {"id": event.id, "kind": kind, "agent_id": agent_id, "project_id": project_id, "summary": summary},
    )
    if gamify and agent_id is not None:
        from app.services.gamification import engine

        await engine.process(db, event)
    return event
