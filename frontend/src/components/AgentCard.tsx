import { Briefcase, Mail } from "lucide-react";
import { Link } from "react-router";
import { useFeatures } from "../api/queries";
import type { Agent } from "../api/types";
import { cn, dateOnly } from "../lib/format";
import { Avatar } from "./Avatar";
import { LevelBadge, RoleBadge } from "./Badges";
import { MoraleMeter, XPBar } from "./Meters";

export function AgentCard({ agent }: { agent: Agent }) {
  const features = useFeatures();
  const fired = agent.status === "fired";
  return (
    <Link
      to={`/team/${agent.id}`}
      className={cn(
        "card group relative flex flex-col overflow-hidden p-4 transition hover:-translate-y-0.5 hover:border-border-strong",
        fired && "opacity-70",
      )}
    >
      <span
        className="absolute inset-x-0 top-0 h-1"
        style={{ background: fired ? "var(--border-strong)" : agent.role.color }}
      />
      <div className="flex items-start gap-3">
        <Avatar agent={agent} size={56} working={agent.working} dimmed={fired} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{agent.name}</span>
            {features.xp && !fired && <LevelBadge level={agent.level} size="sm" />}
          </div>
          <div className="truncate text-xs text-muted">@{agent.handle}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <RoleBadge name={agent.role.name} color={fired ? "#94a3b8" : agent.role.color} />
            {agent.working && (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
                Working{agent.working_project && <span className="font-normal text-success/80">({agent.working_project})</span>}
              </span>
            )}
            {fired && <span className="chip">Alumni · left {dateOnly(agent.fired_at)}</span>}
          </div>
        </div>
      </div>

      {!fired && (features.xp || features.morale) && (
        <div className="mt-4 space-y-3">
          {features.xp && (
            <XPBar xp={agent.xp} level={agent.level} progress={agent.level_progress} nextLevelXp={agent.next_level_xp} />
          )}
          {features.morale && <MoraleMeter morale={agent.morale} band={agent.morale_band} compact />}
        </div>
      )}

      <div className="mt-4 flex flex-1 flex-wrap items-end gap-1.5 text-xs">
        {agent.projects.length ? (
          agent.projects.map((p) => (
            <span key={p.project_id} className="chip">
              <Briefcase size={11} /> {p.project_name}
            </span>
          ))
        ) : (
          <span className="flex items-center gap-1 text-subtle">
            <Mail size={12} /> {fired ? agent.email : "Not assigned to a project"}
          </span>
        )}
      </div>
    </Link>
  );
}
