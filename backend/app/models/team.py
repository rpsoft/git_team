from datetime import datetime

from sqlalchemy import JSON, Boolean, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base, utcnow


class Role(Base):
    """A job template: what an agent in this role is responsible for and may do."""

    __tablename__ = "roles"

    id: Mapped[int] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(String(64), unique=True)
    name: Mapped[str] = mapped_column(String(128))
    description: Mapped[str] = mapped_column(Text, default="")
    responsibilities: Mapped[list[str]] = mapped_column(JSON, default=list)
    prompt: Mapped[str] = mapped_column(Text, default="")
    # Built-in Claude Code tools the role may use (Read, Edit, Write, Glob, Grep, Bash).
    builtin_tools: Mapped[list[str]] = mapped_column(JSON, default=list)
    can_merge: Mapped[bool] = mapped_column(Boolean, default=False)
    color: Mapped[str] = mapped_column(String(16), default="#6366f1")


class Agent(Base):
    """A team member backed by an LLM."""

    __tablename__ = "agents"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    handle: Mapped[str] = mapped_column(String(64), unique=True)
    role_id: Mapped[int] = mapped_column(ForeignKey("roles.id"))
    bio: Mapped[str] = mapped_column(Text, default="")
    responsibilities: Mapped[list[str]] = mapped_column(JSON, default=list)
    traits: Mapped[list[str]] = mapped_column(JSON, default=list)
    model: Mapped[str] = mapped_column(String(64))
    effort: Mapped[str] = mapped_column(String(16), default="high")

    avatar_style: Mapped[str] = mapped_column(String(32), default="notionists")
    avatar_seed: Mapped[str] = mapped_column(String(128), default="")
    avatar_file: Mapped[str | None] = mapped_column(String(256), nullable=True)
    # Voice used in 1:1 calls (browser speech synthesis): feminine | masculine | any,
    # optionally pinned to an exact browser voice name.
    voice_type: Mapped[str] = mapped_column(String(16), default="any", server_default="any")
    voice_name: Mapped[str | None] = mapped_column(String(128), nullable=True)

    status: Mapped[str] = mapped_column(String(16), default="active")  # active | fired
    hired_at: Mapped[datetime] = mapped_column(default=utcnow)
    fired_at: Mapped[datetime | None] = mapped_column(nullable=True)

    gitea_username: Mapped[str | None] = mapped_column(String(64), nullable=True)
    gitea_password_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    gitea_token_enc: Mapped[str | None] = mapped_column(Text, nullable=True)

    max_turns: Mapped[int] = mapped_column(Integer, default=60)
    daily_budget_usd: Mapped[float] = mapped_column(Float, default=10.0)

    # Gamification state (only changes while the respective feature is enabled)
    xp: Mapped[int] = mapped_column(Integer, default=0)
    level: Mapped[int] = mapped_column(Integer, default=1)
    morale: Mapped[float] = mapped_column(Float, default=75)

    role: Mapped[Role] = relationship(lazy="joined")
    memberships: Mapped[list["ProjectMember"]] = relationship(
        back_populates="agent", cascade="all, delete-orphan", lazy="selectin"
    )
    achievements: Mapped[list["AgentAchievement"]] = relationship(  # noqa: F821
        cascade="all, delete-orphan", lazy="selectin"
    )

    @property
    def is_active(self) -> bool:
        return self.status == "active"


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    slug: Mapped[str] = mapped_column(String(64), unique=True)
    description: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), default="active")  # active | paused | archived
    repo_name: Mapped[str] = mapped_column(String(128))
    created_at: Mapped[datetime] = mapped_column(default=utcnow)

    members: Mapped[list["ProjectMember"]] = relationship(
        back_populates="project", cascade="all, delete-orphan", lazy="selectin"
    )


class ProjectMember(Base):
    __tablename__ = "project_members"
    __table_args__ = (UniqueConstraint("project_id", "agent_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    agent_id: Mapped[int] = mapped_column(ForeignKey("agents.id", ondelete="CASCADE"))
    project_role: Mapped[str] = mapped_column(String(64), default="")
    joined_at: Mapped[datetime] = mapped_column(default=utcnow)

    project: Mapped[Project] = relationship(back_populates="members", lazy="joined")
    agent: Mapped[Agent] = relationship(back_populates="memberships", lazy="joined")
