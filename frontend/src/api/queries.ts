import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { api } from "./client";
import type { MailFolder, Settings } from "./types";

/** Central query keys so SSE events can invalidate the right caches. */
export const qk = {
  me: ["me"] as const,
  meta: ["meta"] as const,
  roles: ["roles"] as const,
  agents: (status: string = "active") => ["agents", status] as const,
  agentsAll: ["agents"] as const,
  agent: (id: number) => ["agent", id] as const,
  agentTasks: (id: number) => ["tasks", "agent", id] as const,
  meetings: (agentId: number) => ["meetings", agentId] as const,
  tasks: ["tasks"] as const,
  task: (id: number) => ["task", id] as const,
  activity: (params: object = {}) => ["activity", params] as const,
  projects: ["projects"] as const,
  project: (id: number) => ["project", id] as const,
  projectStats: (id: number) => ["project", id, "stats"] as const,
  projectWork: (id: number) => ["project", id, "work"] as const,
  directory: ["mail", "directory"] as const,
  threads: (folder: MailFolder, address?: string) => ["mail", "threads", folder, address ?? "me"] as const,
  thread: (id: number) => ["mail", "thread", id] as const,
  unread: ["mail", "unread"] as const,
  settings: ["settings"] as const,
  status: ["status"] as const,
  overview: ["overview"] as const,
  leaderboard: (params: object) => ["leaderboard", params] as const,
  reviews: (agentId?: number) => ["reviews", agentId ?? "all"] as const,
};

export function useMeta() {
  return useQuery({ queryKey: qk.meta, queryFn: api.meta, staleTime: 5 * 60_000 });
}

export function useRoles() {
  return useQuery({ queryKey: qk.roles, queryFn: api.roles, staleTime: 60_000 });
}

export function useAgents(status: "active" | "fired" | "all" = "active") {
  return useQuery({ queryKey: qk.agents(status), queryFn: () => api.agents(status) });
}

export function useAgent(id: number) {
  return useQuery({ queryKey: qk.agent(id), queryFn: () => api.agent(id), enabled: Number.isFinite(id) });
}

export function useProjects() {
  return useQuery({ queryKey: qk.projects, queryFn: api.projects });
}

export function useDirectory() {
  return useQuery({ queryKey: qk.directory, queryFn: api.directory, staleTime: 30_000 });
}

export function useUnread() {
  return useQuery({ queryKey: qk.unread, queryFn: api.unread, refetchInterval: 60_000 });
}

export function useStatus() {
  return useQuery({ queryKey: qk.status, queryFn: api.status, staleTime: 30_000 });
}

const DEFAULT_SETTINGS: Settings = {
  feature_xp: true,
  feature_leaderboard: true,
  feature_morale: true,
  review_period_days: 7,
  agents_paused: false,
  voice_speed: 1.15,
};

export function useSettings() {
  return useQuery({ queryKey: qk.settings, queryFn: api.settings, staleTime: 60_000 });
}

/** Feature flags with safe defaults while loading. */
export function useFeatures() {
  const { data } = useSettings();
  const s = data ?? DEFAULT_SETTINGS;
  return {
    xp: !!s.feature_xp,
    leaderboard: !!s.feature_leaderboard,
    morale: !!s.feature_morale,
    paused: !!s.agents_paused,
    loaded: !!data,
  };
}

/** Mutation helper that invalidates a set of query keys on success. */
export function useInvalidatingMutation<TArgs, TResult>(
  fn: (args: TArgs) => Promise<TResult>,
  keys: QueryKey[],
  onSuccess?: (result: TResult, args: TArgs) => void,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (result, args) => {
      for (const key of keys) qc.invalidateQueries({ queryKey: key });
      onSuccess?.(result, args);
    },
  });
}

/**
 * On a Claude subscription, task "costs" are API-equivalent estimates (usage), not charges.
 * Use these labels wherever money is shown.
 */
export function useCostLabels() {
  const { data } = useStatus();
  const subscription = data?.claude_auth !== "api_key";
  return {
    subscription,
    cost: subscription ? "Usage" : "Cost",
    hint: subscription ? "API-equivalent — covered by your subscription" : "billed to your API key",
  };
}
