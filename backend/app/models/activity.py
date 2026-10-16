from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, utcnow


class ActivityEvent(Base):
    """Append-only ledger of everything that happens. Source for XP, morale and reports."""

    __tablename__ = "activity_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(64), index=True)
    agent_id: Mapped[int | None] = mapped_column(ForeignKey("agents.id"), nullable=True, index=True)
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id"), nullable=True)
    summary: Mapped[str] = mapped_column(Text, default="")
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(default=utcnow, index=True)


class AgentTask(Base):
    """One run of an agent (one Claude Agent SDK query)."""

    __tablename__ = "agent_tasks"

    id: Mapped[int] = mapped_column(primary_key=True)
    agent_id: Mapped[int] = mapped_column(ForeignKey("agents.id"), index=True)
    trigger: Mapped[str] = mapped_column(String(32))  # mail | issue_assigned | review_requested | mention | welcome | kickoff | nudge
    trigger_ref: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    title: Mapped[str] = mapped_column(String(512), default="")
    status: Mapped[str] = mapped_column(String(16), default="running")  # running | succeeded | failed | skipped
    started_at: Mapped[datetime] = mapped_column(default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(nullable=True)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    num_turns: Mapped[int] = mapped_column(Integer, default=0)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    result: Mapped[str] = mapped_column(Text, default="")
    error: Mapped[str] = mapped_column(Text, default="")
    transcript: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)


class XPAward(Base):
    __tablename__ = "xp_awards"

    id: Mapped[int] = mapped_column(primary_key=True)
    agent_id: Mapped[int] = mapped_column(ForeignKey("agents.id"), index=True)
    event_id: Mapped[int | None] = mapped_column(ForeignKey("activity_events.id"), nullable=True)
    amount: Mapped[int] = mapped_column(Integer)
    reason: Mapped[str] = mapped_column(String(256))
    created_at: Mapped[datetime] = mapped_column(default=utcnow, index=True)


class AgentAchievement(Base):
    __tablename__ = "agent_achievements"
    __table_args__ = (UniqueConstraint("agent_id", "key"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    agent_id: Mapped[int] = mapped_column(ForeignKey("agents.id", ondelete="CASCADE"))
    key: Mapped[str] = mapped_column(String(64))
    unlocked_at: Mapped[datetime] = mapped_column(default=utcnow)


class PerformanceReview(Base):
    __tablename__ = "performance_reviews"

    id: Mapped[int] = mapped_column(primary_key=True)
    agent_id: Mapped[int] = mapped_column(ForeignKey("agents.id"), index=True)
    period_start: Mapped[datetime]
    period_end: Mapped[datetime]
    metrics: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    rating: Mapped[int] = mapped_column(Integer, default=3)  # 1..5
    summary: Mapped[str] = mapped_column(Text, default="")
    recommendation: Mapped[str] = mapped_column(String(16), default="keep")  # promote | keep | coach | fire
    created_at: Mapped[datetime] = mapped_column(default=utcnow)


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON)


class Meeting(Base):
    """A live 1:1 voice call between the manager and an agent."""

    __tablename__ = "meetings"

    id: Mapped[int] = mapped_column(primary_key=True)
    agent_id: Mapped[int] = mapped_column(ForeignKey("agents.id"), index=True)
    started_at: Mapped[datetime] = mapped_column(default=utcnow)
    ended_at: Mapped[datetime | None] = mapped_column(nullable=True)
    # [{"speaker": "manager" | "agent", "text": str, "at": iso}]
    transcript: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    summary: Mapped[str] = mapped_column(Text, default="")
    action_items: Mapped[list[str]] = mapped_column(JSON, default=list)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
