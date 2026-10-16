"""API request/response shapes. The frontend's src/api/types.ts mirrors these."""

from datetime import datetime
from typing import Any, Literal

from urllib.parse import quote

from pydantic import BaseModel, ConfigDict, Field, computed_field


VoiceType = Literal["feminine", "masculine", "any"]


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---- roles ---------------------------------------------------------------
class RoleIn(BaseModel):
    name: str
    description: str = ""
    responsibilities: list[str] = []
    prompt: str = ""
    builtin_tools: list[str] = []
    can_merge: bool = False
    color: str = "#6366f1"


class RoleOut(ORM):
    id: int
    slug: str
    name: str
    description: str
    responsibilities: list[str]
    prompt: str
    builtin_tools: list[str]
    can_merge: bool
    color: str


# ---- agents --------------------------------------------------------------
class HireIn(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    handle: str = Field(min_length=2, max_length=40)
    role_id: int
    bio: str = ""
    responsibilities: list[str] | None = None
    traits: list[str] = []
    model: str | None = None
    effort: str = "high"
    avatar_style: str = "notionists"
    avatar_seed: str = ""
    voice_type: VoiceType = "any"
    voice_name: str | None = None
    max_turns: int = 60
    daily_budget_usd: float = 10.0


class GenerateProfileIn(BaseModel):
    role_id: int
    traits: list[str] = []


class GeneratedProfile(BaseModel):
    name: str
    bio: str
    voice_type: VoiceType = "any"


class AgentUpdate(BaseModel):
    name: str | None = None
    bio: str | None = None
    role_id: int | None = None
    responsibilities: list[str] | None = None
    traits: list[str] | None = None
    model: str | None = None
    effort: str | None = None
    avatar_style: str | None = None
    avatar_seed: str | None = None
    voice_type: VoiceType | None = None
    voice_name: str | None = None
    max_turns: int | None = None
    daily_budget_usd: float | None = None


class FireIn(BaseModel):
    reassign_to: int | None = None
    reason: str = ""


class NudgeIn(BaseModel):
    instruction: str = Field(min_length=1)


class KudosIn(BaseModel):
    message: str = ""


class MembershipOut(BaseModel):
    project_id: int
    project_name: str
    project_role: str


class AchievementOut(BaseModel):
    key: str
    name: str
    description: str
    icon: str
    unlocked_at: datetime


class AgentOut(BaseModel):
    id: int
    name: str
    handle: str
    email: str
    role: RoleOut
    bio: str
    responsibilities: list[str]
    traits: list[str]
    model: str
    effort: str
    avatar_style: str
    avatar_seed: str
    avatar_url: str | None
    voice_type: str
    voice_name: str | None
    status: str
    hired_at: datetime
    fired_at: datetime | None
    gitea_username: str | None
    gitea_url: str | None
    max_turns: int
    daily_budget_usd: float
    xp: int
    level: int
    level_progress: float  # 0..1 toward next level
    next_level_xp: int
    morale: int
    morale_band: str
    projects: list[MembershipOut]
    achievements: list[AchievementOut]
    working: bool  # a task is currently running
    working_project: str | None = None  # project of the running task, if any
    cost_today_usd: float


# ---- projects ------------------------------------------------------------
class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    description: str = ""
    repo_name: str | None = None
    ci_template: str | None = None  # "node" adds a Gitea Actions workflow for Node.js


class ProjectUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    status: str | None = None


class AssignIn(BaseModel):
    agent_id: int
    project_role: str = ""


class MemberOut(BaseModel):
    agent_id: int
    name: str
    handle: str
    avatar_style: str
    avatar_seed: str
    avatar_url: str | None
    role_name: str
    project_role: str


class ProjectOut(BaseModel):
    id: int
    name: str
    slug: str
    description: str
    status: str
    repo_name: str
    repo_url: str
    created_at: datetime
    members: list[MemberOut]


class ProjectStats(BaseModel):
    open_issues: int
    closed_issues: int
    open_prs: int
    merged_prs: int
    commits_30d: int
    cost_30d_usd: float
    throughput: list[dict[str, Any]]  # [{date, issues_closed, prs_merged}]


# ---- mail ----------------------------------------------------------------
class SendMailIn(BaseModel):
    to: list[str]
    cc: list[str] = []
    subject: str | None = None
    body: str = ""
    thread_id: int | None = None
    project_id: int | None = None
    attachment_ids: list[int] = []


class AttachmentOut(ORM):
    id: int
    filename: str
    content_type: str
    size: int
    is_image: bool

    @computed_field
    @property
    def url(self) -> str:
        return f"/api/mail/attachments/{self.id}/{quote(self.filename)}"


class RecipientOut(ORM):
    address: str
    kind: str
    read_at: datetime | None


class MessageOut(ORM):
    id: int
    sender: str
    body: str
    created_at: datetime
    recipients: list[RecipientOut]
    attachments: list[AttachmentOut] = []


class ThreadOut(BaseModel):
    id: int
    subject: str
    project_id: int | None
    messages: list[MessageOut]


# ---- activity / tasks ----------------------------------------------------
class ActivityOut(ORM):
    id: int
    kind: str
    agent_id: int | None
    project_id: int | None
    summary: str
    data: dict[str, Any]
    created_at: datetime


class TaskOut(ORM):
    id: int
    agent_id: int
    trigger: str
    trigger_ref: dict[str, Any]
    title: str
    status: str
    started_at: datetime
    finished_at: datetime | None
    cost_usd: float
    num_turns: int
    input_tokens: int
    output_tokens: int
    result: str
    error: str


class TaskDetail(TaskOut):
    transcript: list[dict[str, Any]]


class ReviewOut(ORM):
    id: int
    agent_id: int
    period_start: datetime
    period_end: datetime
    metrics: dict[str, Any]
    rating: int
    summary: str
    recommendation: str
    created_at: datetime


class LoginIn(BaseModel):
    username: str
    password: str


class MeetingOut(ORM):
    id: int
    agent_id: int
    started_at: datetime
    ended_at: datetime | None
    transcript: list[dict[str, Any]]
    summary: str
    action_items: list[str]
    cost_usd: float

    @computed_field
    @property
    def live(self) -> bool:
        return self.ended_at is None
