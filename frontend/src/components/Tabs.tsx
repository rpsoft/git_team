import type { ReactNode } from "react";
import { cn } from "../lib/format";

export interface TabDef<T extends string> {
  id: T;
  label: ReactNode;
  icon?: ReactNode;
  count?: number;
}

export function Tabs<T extends string>({ tabs, value, onChange, className }: {
  tabs: TabDef<T>[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex gap-1 overflow-x-auto border-b border-border", className)} role="tablist">
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={cn(
              "-mb-px flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition",
              active ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg",
            )}
          >
            {t.icon}
            {t.label}
            {t.count !== undefined && (
              <span className="rounded-full bg-surface-3 px-1.5 text-[11px] text-muted tabular-nums">{t.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Pill-style segmented control. */
export function Segmented<T extends string | number>({ options, value, onChange, className }: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={cn("inline-flex rounded-lg border border-border bg-surface-2 p-0.5", className)}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          onClick={() => onChange(o.value)}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap transition",
            o.value === value ? "bg-surface-3 text-fg shadow-sm" : "text-muted hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
