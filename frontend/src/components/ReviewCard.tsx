import { ChevronDown, Heart, User, UserMinus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import type { Agent, Review } from "../api/types";
import { cn, dateOnly, titleCase, usd } from "../lib/format";
import { Avatar } from "./Avatar";
import { RecommendationBadge, RoleBadge, Stars } from "./Badges";
import { Markdown } from "./ui";

function metricValue(k: string, v: unknown): string {
  if (typeof v === "number") return k.includes("cost") ? usd(v) : v.toLocaleString();
  return String(v);
}

export function ReviewCard({ review, agent, onFire, onKudos, showAgent = true, canKudos = true }: {
  review: Review;
  agent?: Agent;
  onFire?: () => void;
  onKudos?: () => void;
  showAgent?: boolean;
  canKudos?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const active = agent?.status === "active";
  const metrics = Object.entries(review.metrics ?? {});
  return (
    <article className={cn("card overflow-hidden", review.recommendation === "fire" && "border-danger/40")}>
      <div className="flex flex-wrap items-start gap-4 p-4">
        {showAgent && (
          <Link to={agent ? `/team/${agent.id}` : "#"} className="flex min-w-0 items-center gap-3">
            <Avatar agent={agent} size={44} dimmed={agent && !active} />
            <div className="min-w-0">
              <div className="truncate font-semibold">{agent?.name ?? `Agent #${review.agent_id}`}</div>
              {agent && <RoleBadge name={agent.role.name} color={agent.role.color} />}
            </div>
          </Link>
        )}
        <div className="flex flex-1 flex-wrap items-center justify-end gap-3">
          <span className="text-xs text-muted">{dateOnly(review.period_start)} – {dateOnly(review.period_end)}</span>
          <Stars rating={review.rating} />
          <RecommendationBadge value={review.recommendation} />
        </div>
      </div>
      <div className="px-4 pb-4">
        <div className={cn("relative", !open && "max-h-28 overflow-hidden")}>
          <Markdown>{review.summary}</Markdown>
          {!open && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-surface to-transparent" />}
        </div>
        <button className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-accent" onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Read full review & metrics"} <ChevronDown size={13} className={cn("transition", open && "rotate-180")} />
        </button>
        {open && metrics.length > 0 && (
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {metrics.map(([k, v]) => (
              <div key={k} className="rounded-lg border border-border bg-surface-2 px-3 py-2">
                <div className="truncate text-[11px] text-muted" title={titleCase(k)}>{titleCase(k)}</div>
                <div className="text-sm font-semibold tabular-nums">{metricValue(k, v)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      {agent && (onFire || onKudos || showAgent) && (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-surface-2 px-4 py-2.5">
          {showAgent && <Link to={`/team/${agent.id}`} className="btn-ghost btn-sm"><User size={13} /> Open profile</Link>}
          {active && onKudos && canKudos && <button className="btn-secondary btn-sm" onClick={onKudos}><Heart size={13} /> Give kudos</button>}
          {active && onFire && (
            <button className={cn("btn-sm", review.recommendation === "fire" ? "btn-danger" : "btn-secondary")} onClick={onFire}>
              <UserMinus size={13} /> Fire
            </button>
          )}
          {!active && <span className="text-xs text-subtle">No longer on the team</span>}
        </div>
      )}
    </article>
  );
}
