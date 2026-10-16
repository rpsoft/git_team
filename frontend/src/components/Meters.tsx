import { Annoyed, Frown, Laugh, Meh, Smile, Zap, type LucideIcon } from "lucide-react";
import { cn } from "../lib/format";
import { LevelBadge } from "./Badges";

interface XPProps {
  xp: number;
  level: number;
  progress: number;
  nextLevelXp: number;
  compact?: boolean;
  className?: string;
}

export function XPBar({ xp, level, progress, nextLevelXp, compact, className }: XPProps) {
  const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  return (
    <div className={cn("w-full", className)}>
      {!compact && (
        <div className="mb-1.5 flex items-center justify-between text-xs">
          <span className="flex items-center gap-1.5 font-medium">
            <LevelBadge level={level} size="sm" /> Level {level}
          </span>
          <span className="flex items-center gap-1 text-muted tabular-nums">
            <Zap size={12} className="text-xp" />
            {xp.toLocaleString()} / {nextLevelXp.toLocaleString()} XP
          </span>
        </div>
      )}
      <div
        className={cn("overflow-hidden rounded-full bg-surface-3", compact ? "h-1.5" : "h-2")}
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        title={`${xp} XP — ${pct}% to level ${level + 1}`}
      >
        <div
          className="h-full rounded-full transition-[width] duration-700"
          style={{ width: `${pct}%`, background: "linear-gradient(90deg, #f59e0b, #fde047)" }}
        />
      </div>
    </div>
  );
}

export const MORALE_COLORS: Record<string, string> = {
  thriving: "#22c55e",
  motivated: "#14b8a6",
  steady: "#eab308",
  frustrated: "#f97316",
  "burned out": "#ef4444",
};

const MORALE_ICON: Record<string, LucideIcon> = {
  thriving: Laugh,
  motivated: Smile,
  steady: Meh,
  frustrated: Annoyed,
  "burned out": Frown,
};

export function MoraleIcon({ band, size = 14 }: { band: string; size?: number }) {
  const Icon = MORALE_ICON[band] ?? Smile;
  return <Icon size={size} style={{ color: moraleColor(band) }} />;
}

export function moraleColor(band: string): string {
  return MORALE_COLORS[band] ?? "#94a3b8";
}

export function MoraleMeter({ morale, band, compact, className }: { morale: number; band: string; compact?: boolean; className?: string }) {
  const color = moraleColor(band);
  return (
    <div className={cn("w-full", className)} title={`Morale ${morale}/100 — ${band}`}>
      <div className={cn("flex items-center justify-between text-xs", compact ? "mb-1" : "mb-1.5")}>
        <span className="flex items-center gap-1.5 font-medium">
          <MoraleIcon band={band} />
          <span className="capitalize" style={{ color }}>{band}</span>
        </span>
        <span className="text-muted tabular-nums">{morale}/100</span>
      </div>
      <div className={cn("relative overflow-hidden rounded-full bg-surface-3", compact ? "h-1.5" : "h-2")}>
        <div
          className="h-full rounded-full transition-[width] duration-700"
          style={{ width: `${Math.max(2, Math.min(100, morale))}%`, background: color }}
        />
      </div>
    </div>
  );
}
