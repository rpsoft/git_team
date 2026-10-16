import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Crown, Eye, GitCommitHorizontal, GitMerge, Medal, Trophy, Zap } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { useSession } from "../App";
import { api } from "../api/client";
import { qk, useFeatures, useProjects } from "../api/queries";
import type { LeaderboardMetric, LeaderboardRow } from "../api/types";
import { Avatar } from "../components/Avatar";
import { LevelBadge } from "../components/Badges";
import { Segmented, Tabs } from "../components/Tabs";
import { EmptyState, ErrorState, Loading, PageHeader } from "../components/ui";
import { cn } from "../lib/format";

const METRICS: { id: LeaderboardMetric; label: string; unit: string; icon: typeof Zap }[] = [
  { id: "xp", label: "XP", unit: "XP", icon: Zap },
  { id: "pr_merged", label: "PRs merged", unit: "PRs", icon: GitMerge },
  { id: "review_submitted", label: "Reviews", unit: "reviews", icon: Eye },
  { id: "issue_closed", label: "Issues closed", unit: "issues", icon: CheckCircle2 },
  { id: "commits", label: "Commits", unit: "commits", icon: GitCommitHorizontal },
];

const PODIUM = [
  { place: 2, height: "h-24", color: "#cbd5e1", label: "2nd" },
  { place: 1, height: "h-32", color: "#fbbf24", label: "1st" },
  { place: 3, height: "h-16", color: "#d97706", label: "3rd" },
];

function Podium({ rows, unit }: { rows: LeaderboardRow[]; unit: string }) {
  const { agentById } = useSession();
  const features = useFeatures();
  return (
    <div className="card mb-6 overflow-hidden px-4 pt-8">
      <div className="mx-auto grid max-w-2xl grid-cols-3 items-end gap-3 sm:gap-6">
        {PODIUM.map((slot) => {
          const row = rows[slot.place - 1];
          if (!row) return <div key={slot.place} />;
          const agent = agentById(row.agent_id);
          return (
            <Link key={slot.place} to={`/team/${row.agent_id}`} className="group flex flex-col items-center text-center">
              <div className="relative">
                {slot.place === 1 && <Crown size={26} className="absolute -top-7 left-1/2 -translate-x-1/2 fill-xp text-xp" />}
                <Avatar agent={agent ?? { name: row.name, handle: row.handle }} size={slot.place === 1 ? 84 : 68} ring={slot.color} />
              </div>
              <div className="mt-3 max-w-full truncate text-sm font-semibold group-hover:text-accent">{row.name}</div>
              <div className="truncate text-xs text-muted">{row.role}</div>
              <div className="mt-1 flex items-center gap-1.5 text-lg font-bold tabular-nums">
                {row.score.toLocaleString()} <span className="text-xs font-normal text-muted">{unit}</span>
              </div>
              {features.xp && <div className="mt-1"><LevelBadge level={row.level} size="sm" /></div>}
              <div
                className={cn("mt-3 flex w-full items-start justify-center rounded-t-xl pt-2 text-sm font-bold text-black/70", slot.height)}
                style={{ background: `linear-gradient(180deg, ${slot.color}, color-mix(in srgb, ${slot.color} 40%, transparent))` }}
              >
                {slot.label}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export default function Leaderboard() {
  const features = useFeatures();
  const [metric, setMetric] = useState<LeaderboardMetric>(features.xp ? "xp" : "pr_merged");
  const [days, setDays] = useState<number>(7);
  const [projectId, setProjectId] = useState<number | "">("");
  const { data: projects } = useProjects();
  const { agentById } = useSession();

  const metrics = METRICS.filter((m) => m.id !== "xp" || features.xp);
  const effectiveMetric = metrics.some((m) => m.id === metric) ? metric : metrics[0]!.id;
  const params = { metric: effectiveMetric, days: days || undefined, project_id: projectId || undefined };
  const q = useQuery({ queryKey: qk.leaderboard(params), queryFn: () => api.leaderboard(params) });
  const unit = METRICS.find((m) => m.id === effectiveMetric)!.unit;
  const rows = q.data ?? [];
  const max = Math.max(1, ...rows.map((r) => r.score));

  return (
    <div>
      <PageHeader icon={<Trophy size={20} />} title="Leaderboard" subtitle="Who’s shipping the most? Friendly competition, updated live." />
      <Tabs
        className="mb-4"
        value={effectiveMetric}
        onChange={setMetric}
        tabs={metrics.map((m) => ({ id: m.id, label: m.label, icon: <m.icon size={15} /> }))}
      />
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Segmented<number>
          value={days}
          onChange={setDays}
          options={[{ value: 7, label: "7 days" }, { value: 30, label: "30 days" }, { value: 0, label: "All time" }]}
        />
        <select className="input w-auto" value={projectId} onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : "")}>
          <option value="">All projects</option>
          {projects?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      {q.isPending && <Loading />}
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && !rows.length && <EmptyState icon={<Medal size={22} />} title="No contenders yet" description="Hire agents and assign them to projects to start the race." />}
      {rows.length > 0 && (
        <>
          <Podium rows={rows} unit={unit} />
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-surface-2 text-xs text-muted">
                <tr>
                  <th className="w-14 px-4 py-2.5 text-left font-medium">#</th>
                  <th className="px-4 py-2.5 text-left font-medium">Agent</th>
                  <th className="hidden px-4 py-2.5 text-left font-medium sm:table-cell">Role</th>
                  {features.xp && <th className="hidden px-4 py-2.5 text-left font-medium md:table-cell">Level</th>}
                  <th className="px-4 py-2.5 text-right font-medium">{METRICS.find((m) => m.id === effectiveMetric)!.label}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => {
                  const agent = agentById(r.agent_id);
                  return (
                    <tr key={r.agent_id} className="hover:bg-surface-2">
                      <td className="px-4 py-2.5 font-semibold text-muted tabular-nums">{r.rank}</td>
                      <td className="px-4 py-2.5">
                        <Link to={`/team/${r.agent_id}`} className="flex items-center gap-2.5 hover:text-accent">
                          <Avatar agent={agent ?? { name: r.name, handle: r.handle }} size={28} working={agent?.working} />
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{r.name}</span>
                            <span className="block truncate text-xs text-muted">@{r.handle}</span>
                          </span>
                        </Link>
                      </td>
                      <td className="hidden px-4 py-2.5 text-muted sm:table-cell">{r.role}</td>
                      {features.xp && <td className="hidden px-4 py-2.5 md:table-cell"><LevelBadge level={r.level} size="sm" /></td>}
                      <td className="px-4 py-2.5">
                        <div className="flex items-center justify-end gap-3">
                          <div className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-surface-3 sm:block">
                            <div className="h-full rounded-full bg-accent" style={{ width: `${(r.score / max) * 100}%` }} />
                          </div>
                          <span className="w-14 text-right font-semibold tabular-nums">{r.score.toLocaleString()}</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
