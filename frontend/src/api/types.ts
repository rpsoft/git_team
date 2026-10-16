// Mirrors backend/app/schemas.py (plus the untyped dict responses in app/api/*.py).
// Datetimes are naive UTC ISO strings.

export type ISODate = string;

// ---- roles ---------------------------------------------------------------
export interface RoleIn {
  name: string;
  description: string;
  responsibilities: string[];
  prompt: string;
  builtin_tools: string[];
  can_merge: boolean;
  color: string;
}

export interface Role extends RoleIn {
  id: number;
  slug: string;
}

// ---- agents --------------------------------------------------------------
export interface GeneratedProfile {
  name: string;
  bio: string;
  voice_type: VoiceType;
}

export interface HireIn {
  name: string;
  handle: string;
  role_id: number;
  bio?: string;
  responsibilities?: string[] | null;
  traits?: string[];
  model?: string | null;
  effort?: string;
  avatar_style?: string;
  avatar_seed?: string;
  voice_type?: VoiceType;
  voice_name?: string | null;
  max_turns?: number;
  daily_budget_usd?: number;
}

export type VoiceType = "feminine" | "masculine" | "any";

export interface AgentUpdate {
  name?: string;
  bio?: string;
  role_id?: number;
  responsibilities?: string[];
  traits?: string[];
  model?: string;
  effort?: string;
  avatar_style?: string;
  avatar_seed?: string;
  voice_type?: VoiceType;
  voice_name?: string | null;
  max_turns?: number;
  daily_budget_usd?: number;
}

export interface FireIn {
  reassign_to: number | null;
  reason: string;
}

export interface FireOut {
  handed_over: string[];
}

export interface Membership {
  project_id: number;
  project_name: string;
  project_role: string;
}

export interface Achievement {
  key: string;
  name: string;
  description: string;
  icon: string;
  unlocked_at: ISODate;
}

export type AgentStatus = "active" | "fired" | string;

export interface Agent {
  id: number;
  name: string;
  handle: string;
  email: string;
  role: Role;
  bio: string;
  responsibilities: string[];
  traits: string[];
  model: string;
  effort: string;
  avatar_style: string;
  avatar_seed: string;
  avatar_url: string | null;
  voice_type: VoiceType;
  voice_name: string | null;
  status: AgentStatus;
  hired_at: ISODate;
  fired_at: ISODate | null;
  gitea_username: string | null;
  gitea_url: string | null;
  max_turns: number;
  daily_budget_usd: number;
  xp: number;
  level: number;
  level_progress: number;
  next_level_xp: number;
  morale: number;
  morale_band: MoraleBand | string;
  projects: Membership[];
  achievements: Achievement[];
  working: boolean;
  /** Project of the task the agent is running right now, if it belongs to one. */
  working_project: string | null;
  cost_today_usd: number;
}

export type MoraleBand = "thriving" | "motivated" | "steady" | "frustrated" | "burned out";

// ---- projects ------------------------------------------------------------
export interface ProjectIn {
  name: string;
  description?: string;
  repo_name?: string | null;
  /** "node" adds a Gitea Actions workflow for Node.js. */
  ci_template?: "node" | null;
}

export interface ProjectUpdate {
  name?: string;
  description?: string;
  status?: string;
}

export interface AssignIn {
  agent_id: number;
  project_role: string;
}

export interface Member {
  agent_id: number;
  name: string;
  handle: string;
  avatar_style: string;
  avatar_seed: string;
  avatar_url: string | null;
  role_name: string;
  project_role: string;
}

export interface Project {
  id: number;
  name: string;
  slug: string;
  description: string;
  status: string;
  repo_name: string;
  repo_url: string;
  created_at: ISODate;
  members: Member[];
}

export interface ThroughputPoint {
  date: string;
  issues_closed: number;
  prs_merged: number;
  commits?: number;
}

export interface ProjectStats {
  open_issues: number;
  closed_issues: number;
  open_prs: number;
  merged_prs: number;
  commits_30d: number;
  cost_30d_usd: number;
  throughput: ThroughputPoint[];
}

export interface WorkItem {
  number: number;
  title: string;
  url: string | null;
  author: string | null;
  assignees: string[];
  labels: string[];
  updated_at: ISODate | null;
  reviewers: string[];
}

export interface ProjectWork {
  issues: WorkItem[];
  pulls: WorkItem[];
}

// ---- mail ----------------------------------------------------------------
export interface SendMailIn {
  to: string[];
  cc?: string[];
  subject?: string | null;
  body: string;
  thread_id?: number | null;
  project_id?: number | null;
  attachment_ids?: number[];
}

export interface Attachment {
  id: number;
  filename: string;
  content_type: string;
  size: number;
  is_image: boolean;
  /** Same-origin download URL (auth cookie required). */
  url: string;
}

export interface Recipient {
  address: string;
  kind: "to" | "cc" | string;
  read_at: ISODate | null;
}

export interface Message {
  id: number;
  sender: string;
  body: string;
  created_at: ISODate;
  recipients: Recipient[];
  attachments: Attachment[];
}

export interface Thread {
  id: number;
  subject: string;
  project_id: number | null;
  messages: Message[];
}

export interface ThreadSummary {
  id: number;
  subject: string;
  project_id: number | null;
  updated_at: ISODate;
  message_count: number;
  unread: number;
  last_sender: string | null;
  last_sender_name: string | null;
  snippet: string;
  attachment_count: number;
  participants: string[];
}

export type MailFolder = "inbox" | "sent" | "archived";

export interface DirectoryEntry {
  address: string;
  name: string;
  kind: "manager" | "system" | "agent" | string;
  agent_id: number | null;
}

// ---- activity / tasks ----------------------------------------------------
export interface Activity {
  id: number;
  kind: string;
  agent_id: number | null;
  project_id: number | null;
  summary: string;
  data: Record<string, unknown>;
  created_at: ISODate;
}

export type TaskStatus = "running" | "succeeded" | "failed" | "skipped" | string;

export interface Task {
  id: number;
  agent_id: number;
  trigger: string;
  trigger_ref: Record<string, unknown>;
  title: string;
  status: TaskStatus;
  started_at: ISODate;
  finished_at: ISODate | null;
  cost_usd: number;
  num_turns: number;
  input_tokens: number;
  output_tokens: number;
  result: string;
  error: string;
}

export type TranscriptEntry = { type: string } & Record<string, unknown>;

export interface TaskDetail extends Task {
  transcript: TranscriptEntry[];
}

export type Recommendation = "promote" | "keep" | "coach" | "fire" | string;

export interface Review {
  id: number;
  agent_id: number;
  period_start: ISODate;
  period_end: ISODate;
  metrics: Record<string, unknown>;
  rating: number;
  summary: string;
  recommendation: Recommendation;
  created_at: ISODate;
}

// ---- auth / system -------------------------------------------------------
export interface LoginIn {
  username: string;
  password: string;
}

export interface Me {
  username: string;
  name: string;
  email: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  tier: string;
}

export interface TraitInfo {
  key: string;
  description: string;
}

export interface AchievementDef {
  key: string;
  name: string;
  description: string;
  icon: string;
  stat: string;
  threshold: number;
}

export interface Meta {
  models: ModelInfo[];
  avatar_styles: string[];
  traits: TraitInfo[];
  achievements: AchievementDef[];
  efforts: string[];
  builtin_tools: string[];
  mail_domain: string;
  manager_address: string;
  gitea_url: string;
}

export interface Settings {
  feature_xp: boolean;
  feature_leaderboard: boolean;
  feature_morale: boolean;
  review_period_days: number;
  agents_paused: boolean;
  /** Speaking rate in 1:1 calls (1.0 = normal). */
  voice_speed: number;
}

export interface SystemStatus {
  gitea_reachable: boolean;
  gitea_bootstrapped: boolean;
  claude_auth: "subscription" | "api_key" | "local";
  gitea_url: string;
  gitea_org: string;
}

export interface WorkingNow {
  agent_id: number;
  task_id: number;
  title: string;
  since: ISODate;
  project: string | null;
}

export interface Overview {
  team_size: number;
  active_projects: number;
  working_now: WorkingNow[];
  week: {
    prs_merged: number;
    prs_opened: number;
    issues_closed: number;
    reviews: number;
    tasks: number;
    cost_usd: number;
  };
  cost_today_usd: number;
  unread_mail: number;
  avg_morale: number | null;
}

export type LeaderboardMetric = "xp" | "pr_merged" | "review_submitted" | "issue_closed" | "commits";

export interface LeaderboardRow {
  agent_id: number;
  name: string;
  handle: string;
  level: number;
  role: string;
  score: number;
  rank: number;
}

// ---- live events (SSE) ---------------------------------------------------
export type LiveEvent =
  | { type: "mail"; thread_id: number; message_id: number; sender: string; subject: string; recipients: string[] }
  | { type: "activity"; id: number; kind: string; agent_id: number | null; project_id: number | null; summary: string }
  | { type: "task"; task_id: number; agent_id: number; status: string; title: string }
  | { type: "xp"; agent_id: number; amount: number; xp: number; level: number }
  | { type: "morale"; agent_id: number; morale: number; reason: string }
  | { type: "toast"; title: string; message: string; icon?: string; agent_id?: number }
  | ({ type: "settings" } & Settings);

export interface MeetingLine {
  speaker: "manager" | "agent";
  text: string;
  at: ISODate;
}

export interface Meeting {
  id: number;
  agent_id: number;
  started_at: ISODate;
  ended_at: ISODate | null;
  transcript: MeetingLine[];
  summary: string;
  action_items: string[];
  cost_usd: number;
  live: boolean;
}

export type MeetingEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; name: string }
  | { type: "done"; text: string }
  | { type: "error"; message: string };
