import { Star } from "lucide-react";
import type { ReactNode } from "react";
import { cn, titleCase } from "../lib/format";

export function RoleBadge({ name, color, className }: { name: string; color?: string; className?: string }) {
  const c = color || "#6366f1";
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", className)}
      style={{ color: c, background: `color-mix(in srgb, ${c} 15%, transparent)`, border: `1px solid color-mix(in srgb, ${c} 35%, transparent)` }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />
      {name}
    </span>
  );
}

export function LevelBadge({ level, size = "md" }: { level: number; size?: "sm" | "md" | "lg" }) {
  const dims = { sm: "h-5 min-w-5 text-[10px]", md: "h-6 min-w-6 text-xs", lg: "h-9 min-w-9 text-sm" }[size];
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-md px-1 font-bold tabular-nums text-black shadow-sm",
        dims,
      )}
      style={{ background: "linear-gradient(135deg, #fde68a, #f59e0b)" }}
      title={`Level ${level}`}
    >
      {size === "lg" ? `Lv ${level}` : level}
    </span>
  );
}

const STATUS: Record<string, string> = {
  running: "text-accent bg-accent-soft border-accent/30",
  succeeded: "text-success bg-success/10 border-success/30",
  failed: "text-danger bg-danger/10 border-danger/30",
  skipped: "text-muted bg-surface-3 border-border",
  active: "text-success bg-success/10 border-success/30",
  fired: "text-muted bg-surface-3 border-border",
  archived: "text-muted bg-surface-3 border-border",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium", STATUS[status] ?? STATUS.skipped)}>
      {status === "running" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {titleCase(status)}
    </span>
  );
}

const RECO: Record<string, string> = {
  promote: "text-success bg-success/10 border-success/30",
  keep: "text-accent bg-accent-soft border-accent/30",
  coach: "text-warning bg-warning/10 border-warning/30",
  fire: "text-danger bg-danger/10 border-danger/30",
};

export function RecommendationBadge({ value }: { value: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide", RECO[value] ?? STATUS.skipped)}>
      {value}
    </span>
  );
}

export function Stars({ rating, max = 5, size = 14 }: { rating: number; max?: number; size?: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" title={`${rating} / ${max}`}>
      {Array.from({ length: max }, (_, i) => (
        <Star
          key={i}
          size={size}
          className={i < rating ? "fill-xp text-xp" : "text-border-strong"}
        />
      ))}
    </span>
  );
}

export function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("chip", className)}>{children}</span>;
}
