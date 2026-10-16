import { BarChart3, Table2 } from "lucide-react";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from "recharts";
import type { ThroughputPoint } from "../api/types";

const SERIES = [
  { key: "issues_closed", label: "Issues closed", color: "var(--series-1)" },
  { key: "prs_merged", label: "PRs merged", color: "var(--series-2)" },
] as const;

function fmtDay(d: string) {
  const dt = new Date(`${d}T00:00:00Z`);
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function ChartTooltip({ active, payload, label }: Partial<TooltipContentProps<number, string>>) {
  if (!active || !payload?.length) return null;
  return (
    <div className="card px-3 py-2 text-xs">
      <div className="mb-1 font-semibold">{fmtDay(String(label))}</div>
      {SERIES.map((s) => {
        const p = payload.find((x) => x.dataKey === s.key);
        return (
          <div key={s.key} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
            <span className="text-muted">{s.label}</span>
            <span className="ml-auto pl-3 font-medium tabular-nums">{Number(p?.value ?? 0)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function ThroughputChart({ data }: { data: ThroughputPoint[] }) {
  const [table, setTable] = useState(false);
  const totals = SERIES.map((s) => data.reduce((n, d) => n + (Number(d[s.key]) || 0), 0));
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-4 text-xs">
        {SERIES.map((s, i) => (
          <span key={s.key} className="flex items-center gap-1.5 text-muted">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
            {s.label}
            <span className="font-semibold text-fg tabular-nums">{totals[i]}</span>
          </span>
        ))}
        <button className="btn-ghost btn-sm ml-auto" onClick={() => setTable(!table)} aria-pressed={table}>
          {table ? <><BarChart3 size={13} /> Chart</> : <><Table2 size={13} /> Table</>}
        </button>
      </div>
      {table ? (
        <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface-2 text-muted">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Date</th>
                {SERIES.map((s) => <th key={s.key} className="px-3 py-2 text-right font-medium">{s.label}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {[...data].reverse().map((d) => (
                <tr key={d.date}>
                  <td className="px-3 py-1.5">{fmtDay(d.date)}</td>
                  {SERIES.map((s) => <td key={s.key} className="px-3 py-1.5 text-right tabular-nums">{Number(d[s.key]) || 0}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} barGap={2} barCategoryGap="20%" margin={{ top: 4, right: 4, bottom: 0, left: -24 }}>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis
                dataKey="date"
                tickFormatter={fmtDay}
                tick={{ fill: "var(--subtle)", fontSize: 11 }}
                axisLine={{ stroke: "var(--border)" }}
                tickLine={false}
                minTickGap={24}
              />
              <YAxis allowDecimals={false} tick={{ fill: "var(--subtle)", fontSize: 11 }} axisLine={false} tickLine={false} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--surface-3)", opacity: 0.6 }} />
              {SERIES.map((s) => (
                <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[4, 4, 0, 0]} maxBarSize={14} isAnimationActive={false} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
