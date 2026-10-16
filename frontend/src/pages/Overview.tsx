import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Coins,
  FolderGit2,
  GitMerge,
  LayoutDashboard,
  Smile,
  Terminal,
  UserPlus,
  Users,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useSession } from "../App";
import { api } from "../api/client";
import { qk, useCostLabels, useFeatures, useStatus } from "../api/queries";
import { ActivityFeed } from "../components/ActivityFeed";
import { Avatar } from "../components/Avatar";
import { RoleBadge } from "../components/Badges";
import { moraleColor } from "../components/Meters";
import { TaskDrawer } from "../components/Tasks";
import { EmptyState, ErrorState, Loading, PageHeader, Section, StatTile } from "../components/ui";
import { duration, usd } from "../lib/format";

function bandFor(m: number) {
  return m >= 85 ? "thriving" : m >= 65 ? "motivated" : m >= 45 ? "steady" : m >= 25 ? "frustrated" : "burned out";
}

function SystemWarnings() {
  const { data: status } = useStatus();
  if (!status) return null;
  const issues: { title: string; body: ReactNode }[] = [];
  if (!status.gitea_reachable) {
    issues.push({ title: "Gitea is unreachable", body: <>The bundled Gitea at <code>{status.gitea_url}</code> isn’t responding. Check that the container is running.</> });
  }
  if (!status.gitea_bootstrapped) {
    issues.push({ title: "Gitea is not bootstrapped", body: <>Run <code className="rounded bg-surface-3 px-1.5 py-0.5 font-mono">make bootstrap</code> to create the admin token and the <code>{status.gitea_org}</code> organization.</> });
  }
  if (status.claude_auth === "local") {
    issues.push({ title: "No Claude credentials configured", body: <>Agents will use a local Claude Code login, which only exists outside Docker. Run <code className="rounded bg-surface-3 px-1.5 py-0.5 font-mono">claude setup-token</code>, put the token in <code className="rounded bg-surface-3 px-1.5 py-0.5 font-mono">CLAUDE_CODE_OAUTH_TOKEN</code> in <code>.env</code> and restart.</> });
  }
  if (!issues.length) return null;
  return (
    <div className="mb-6 space-y-2">
      {issues.map((i) => (
        <div key={i.title} className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning" />
          <div>
            <div className="font-semibold">{i.title}</div>
            <div className="mt-0.5 text-muted">{i.body}</div>
          </div>
          <Terminal size={16} className="ml-auto shrink-0 text-subtle" />
        </div>
      ))}
    </div>
  );
}

export default function Overview() {
  const costLabels = useCostLabels();
  const features = useFeatures();
  const { agentById, me } = useSession();
  const [taskId, setTaskId] = useState<number | null>(null);
  const overview = useQuery({ queryKey: qk.overview, queryFn: api.overview, refetchInterval: 60_000 });
  const activity = useQuery({ queryKey: qk.activity({ limit: 40 }), queryFn: () => api.activity({ limit: 40 }) });

  const o = overview.data;
  const displayName = me.name || me.username;

  return (
    <div>
      <PageHeader icon={<LayoutDashboard size={20} />} title={`Welcome back, ${displayName}`} subtitle="Here’s what your team is up to." />
      <SystemWarnings />
      {overview.isError && <ErrorState error={overview.error} onRetry={() => overview.refetch()} />}
      {overview.isPending && <Loading />}
      {o && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatTile label="Team size" value={o.team_size} icon={<Users size={15} />} tone="#7c6cff" hint={`${o.working_now.length} working now`} />
            <StatTile label="Projects" value={o.active_projects} icon={<FolderGit2 size={15} />} tone="#3b82f6" hint="active" />
            <StatTile label="PRs merged" value={o.week.prs_merged} icon={<GitMerge size={15} />} tone="#a855f7" hint={`${o.week.prs_opened} opened · 7d`} />
            <StatTile label="Issues closed" value={o.week.issues_closed} icon={<CheckCircle2 size={15} />} tone="#22c55e" hint="last 7 days" />
            <StatTile label="Reviews" value={o.week.reviews} icon={<ClipboardCheck size={15} />} tone="#06b6d4" hint="last 7 days" />
            <StatTile label={`${costLabels.cost} today`} value={usd(o.cost_today_usd)} icon={<Coins size={15} />} tone="#f59e0b" hint={`${usd(o.week.cost_usd)} this week · ${o.week.tasks} tasks${costLabels.subscription ? " · API-equivalent" : ""}`} />
          </div>
          {features.morale && o.avg_morale != null && (
            <div className="card mt-3 flex items-center gap-4 p-4">
              <Smile size={20} style={{ color: moraleColor(bandFor(o.avg_morale)) }} />
              <div className="flex-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">Team morale</span>
                  <span className="text-muted capitalize">{bandFor(o.avg_morale)} · {o.avg_morale}/100</span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-3">
                  <div className="h-full rounded-full" style={{ width: `${o.avg_morale}%`, background: moraleColor(bandFor(o.avg_morale)) }} />
                </div>
              </div>
            </div>
          )}

          {o.team_size === 0 && (
            <EmptyState
              className="mt-6"
              icon={<UserPlus size={22} />}
              title="No team yet — hire your first agent"
              description="Agents pick up issues, open pull requests, review each other’s code and report to you by email."
              action={<Link to="/team/hire" className="btn-primary"><UserPlus size={16} /> Hire an agent</Link>}
            />
          )}

          <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <Section
              title={
                <span className="flex items-center gap-2">
                  Working now
                  {o.working_now.length > 0 && <span className="h-2 w-2 animate-pulse rounded-full bg-success" />}
                </span>
              }
            >
              {o.working_now.length ? (
                <ul className="space-y-1">
                  {o.working_now.map((w) => {
                    const agent = agentById(w.agent_id);
                    return (
                      <li key={w.task_id}>
                        <button onClick={() => setTaskId(w.task_id)} className="flex w-full items-center gap-3 rounded-lg p-2 text-left hover:bg-surface-2">
                          <Avatar agent={agent} size={36} working />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium">{agent?.name ?? `Agent #${w.agent_id}`}</span>
                              {agent && <RoleBadge name={agent.role.name} color={agent.role.color} />}
                            </div>
                            <div className="truncate text-xs text-muted">
                              {w.project && <span className="font-medium text-success">{w.project} · </span>}{w.title}
                            </div>
                          </div>
                          <span className="text-xs text-subtle tabular-nums">{duration(w.since, null)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="py-6 text-center text-sm text-muted">
                  Nobody is working right now.
                  {features.paused && <div className="mt-1 text-warning">Agents are paused.</div>}
                </div>
              )}
            </Section>
            <Section title="Live activity" actions={<span className="text-xs text-subtle">updates in real time</span>}>
              {activity.isPending ? <Loading /> : <ActivityFeed items={activity.data} className="-mx-2 max-h-[560px] overflow-y-auto" />}
            </Section>
          </div>
        </>
      )}
      <TaskDrawer taskId={taskId} onClose={() => setTaskId(null)} />
    </div>
  );
}
