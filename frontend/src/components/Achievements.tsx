import { Lock } from "lucide-react";
import { useMeta } from "../api/queries";
import type { Achievement } from "../api/types";
import { cn, dateOnly } from "../lib/format";
import { iconFor } from "../lib/icons";

export function AchievementGrid({ unlocked }: { unlocked: Achievement[] }) {
  const { data: meta } = useMeta();
  const owned = new Map(unlocked.map((a) => [a.key, a]));
  const catalog = meta?.achievements ?? unlocked.map((a) => ({ ...a, stat: "", threshold: 0 }));
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {catalog.map((def) => {
        const got = owned.get(def.key);
        const Icon = iconFor(def.icon);
        return (
          <div
            key={def.key}
            className={cn(
              "flex items-center gap-3 rounded-xl border p-3 transition",
              got ? "border-xp/40 bg-xp/5" : "border-border bg-surface-2 opacity-60",
            )}
            title={got ? `Unlocked ${dateOnly(got.unlocked_at)}` : "Locked"}
          >
            <span
              className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", got ? "text-black" : "bg-surface-3 text-subtle")}
              style={got ? { background: "linear-gradient(135deg, #fde68a, #f59e0b)" } : undefined}
            >
              {got ? <Icon size={20} /> : <Lock size={16} />}
            </span>
            <div className="min-w-0">
              <div className={cn("text-sm leading-snug font-semibold", !got && "text-muted")}>{def.name}</div>
              <div className="text-xs leading-snug text-muted">{def.description}</div>
              {got && <div className="mt-0.5 text-[11px] text-xp">{dateOnly(got.unlocked_at)}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
