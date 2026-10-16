import type {
  Activity,
  Agent,
  AgentUpdate,
  AssignIn,
  Attachment,
  DirectoryEntry,
  FireIn,
  FireOut,
  GeneratedProfile,
  HireIn,
  LeaderboardMetric,
  LeaderboardRow,
  LoginIn,
  Meeting,
  MeetingEvent,
  MailFolder,
  Me,
  Message,
  Meta,
  Overview,
  Project,
  ProjectIn,
  ProjectStats,
  ProjectUpdate,
  ProjectWork,
  Review,
  Role,
  RoleIn,
  SendMailIn,
  Settings,
  SystemStatus,
  Task,
  TaskDetail,
  Thread,
  ThreadSummary,
} from "./types";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

function detailMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
    // FastAPI validation errors: [{loc, msg, type}]
    if (Array.isArray(detail)) {
      return detail
        .map((d) => {
          if (d && typeof d === "object" && "msg" in d) {
            const loc = Array.isArray((d as { loc?: unknown }).loc)
              ? ((d as { loc: unknown[] }).loc.filter((x) => x !== "body").join("."))
              : "";
            return loc ? `${loc}: ${(d as { msg: string }).msg}` : (d as { msg: string }).msg;
          }
          return String(d);
        })
        .join("; ");
    }
    return JSON.stringify(detail);
  }
  return fallback;
}

type Query = Record<string, string | number | boolean | null | undefined>;

function qs(params?: Query): string {
  if (!params) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export async function request<T>(method: string, path: string, body?: unknown, params?: Query): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", headers: {} };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  const res = await fetch(`/api${path}${qs(params)}`, init);
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    throw new ApiError(res.status, detailMessage(data, `${res.status} ${res.statusText || "request failed"}`));
  }
  return data as T;
}

const get = <T>(path: string, params?: Query) => request<T>("GET", path, undefined, params);
const post = <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {});
const patch = <T>(path: string, body: unknown) => request<T>("PATCH", path, body);
const del = <T>(path: string) => request<T>("DELETE", path);

export const api = {
  // auth
  login: (body: LoginIn) => post<Me>("/auth/login", body),
  logout: () => post<{ ok: boolean }>("/auth/logout"),
  me: () => get<Me>("/auth/me"),

  // meta & roles
  meta: () => get<Meta>("/meta"),
  roles: () => get<Role[]>("/roles"),
  createRole: (body: RoleIn) => post<Role>("/roles", body),
  updateRole: (id: number, body: RoleIn) => patch<Role>(`/roles/${id}`, body),

  // agents
  agents: (status: "active" | "fired" | "all" = "active") => get<Agent[]>("/agents", { status }),
  agent: (id: number) => get<Agent>(`/agents/${id}`),
  hire: (body: HireIn) => post<Agent>("/agents", body),
  generateProfile: (role_id: number, traits: string[]) =>
    post<GeneratedProfile>("/agents/generate-profile", { role_id, traits }),
  updateAgent: (id: number, body: AgentUpdate) => patch<Agent>(`/agents/${id}`, body),
  fire: (id: number, body: FireIn) => post<FireOut>(`/agents/${id}/fire`, body),
  nudge: (id: number, instruction: string) => post<{ queued: boolean }>(`/agents/${id}/nudge`, { instruction }),
  restoreMorale: () => post<{ restored: number; morale: number }>("/agents/restore-morale", {}),
  kudos: (id: number, message: string) => post<Agent>(`/agents/${id}/kudos`, { message }),
  uploadAvatar: (id: number, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<Agent>("POST", `/agents/${id}/avatar`, fd);
  },
  removeAvatar: (id: number) => del<Agent>(`/agents/${id}/avatar`),
  agentTasks: (id: number, limit = 50) => get<Task[]>(`/agents/${id}/tasks`, { limit }),
  tasks: (status?: string, limit = 50) => get<Task[]>("/tasks", { status, limit }),
  task: (id: number) => get<TaskDetail>(`/tasks/${id}`),
  activity: (params: { agent_id?: number; project_id?: number; limit?: number; days?: number } = {}) =>
    get<Activity[]>("/activity", params),

  // projects
  projects: () => get<Project[]>("/projects"),
  project: (id: number) => get<Project>(`/projects/${id}`),
  createProject: (body: ProjectIn) => post<Project>("/projects", body),
  updateProject: (id: number, body: ProjectUpdate) => patch<Project>(`/projects/${id}`, body),
  projectStats: (id: number, days = 30) => get<ProjectStats>(`/projects/${id}/stats`, { days }),
  projectWork: (id: number) => get<ProjectWork>(`/projects/${id}/work`),
  addMember: (id: number, body: AssignIn) => post<Project>(`/projects/${id}/members`, body),
  removeMember: (id: number, agentId: number) => del<Project>(`/projects/${id}/members/${agentId}`),

  // mail
  directory: () => get<DirectoryEntry[]>("/mail/directory"),
  threads: (folder: MailFolder = "inbox", address?: string) =>
    get<ThreadSummary[]>("/mail/threads", { folder, address }),
  thread: (id: number) => get<Thread>(`/mail/threads/${id}`),
  send: (body: SendMailIn) => post<Message>("/mail/send", body),
  uploadAttachment: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<Attachment>("POST", "/mail/attachments", fd);
  },
  // 1:1 meetings
  startMeeting: (agentId: number) => post<Meeting>(`/agents/${agentId}/meetings`),
  endMeeting: (id: number) => post<Meeting>(`/meetings/${id}/end`),
  interruptMeeting: (id: number) => post<{ ok: boolean }>(`/meetings/${id}/interrupt`),
  meetings: (agentId?: number) => get<Meeting[]>("/meetings", { agent_id: agentId }),
  /** Send what the manager said and stream the agent's reply (NDJSON). */
  say: async (id: number, text: string | null, onEvent: (e: MeetingEvent) => void) => {
    const res = await fetch(`/api/meetings/${id}/say`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok || !res.body) {
      let detail = res.statusText;
      try { detail = (await res.json()).detail ?? detail; } catch { /* not json */ }
      throw new ApiError(res.status, detail);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onEvent(JSON.parse(line) as MeetingEvent);
      }
    }
  },
  archive: (id: number, archived: boolean) => post<{ ok: boolean }>(`/mail/threads/${id}/archive`, { archived }),
  unread: () => get<{ count: number }>("/mail/unread"),

  // system
  settings: () => get<Settings>("/settings"),
  updateSettings: (body: Partial<Settings>) => patch<Settings>("/settings", body),
  status: () => get<SystemStatus>("/system/status"),
  overview: () => get<Overview>("/overview"),
  leaderboard: (params: { metric: LeaderboardMetric; days?: number; project_id?: number }) =>
    get<LeaderboardRow[]>("/leaderboard", params),
  reviews: (agent_id?: number, limit = 50) => get<Review[]>("/reviews", { agent_id, limit }),
  runReviews: () => post<{ queued: boolean }>("/reviews/run"),
};
