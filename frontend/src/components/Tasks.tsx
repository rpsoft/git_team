import { useQuery } from "@tanstack/react-query";
import { Bot, CheckCircle2, ChevronRight, Coins, Flag, MessageSquare, Repeat, Wrench, XCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useSession } from "../App";
import { api } from "../api/client";
import { qk, useCostLabels } from "../api/queries";
import type { Task, TranscriptEntry } from "../api/types";
import { cn, dateTime, duration, timeAgo, titleCase, usd } from "../lib/format";
import { Avatar } from "./Avatar";
import { StatusBadge } from "./Badges";
import { Drawer } from "./Modal";
import { EmptyState, ErrorState, Loading, Markdown } from "./ui";

export function TaskList({ tasks, onOpen, showAgent }: { tasks: Task[] | undefined; onOpen: (id: number) => void; showAgent?: boolean }) {
  const { agentById } = useSession();
  if (!tasks) return <Loading />;
  if (!tasks.length) {
    return <EmptyState icon={<Bot size={20} />} title="No tasks yet" description="Agents start tasks when they get mail, are assigned issues, or are asked for reviews." />;
  }
  return (
    <div className="card divide-y divide-border overflow-hidden">
      {tasks.map((t) => {
        const agent = showAgent ? agentById(t.agent_id) : undefined;
        return (
          <button key={t.id} onClick={() => onOpen(t.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2">
            {agent && <Avatar agent={agent} size={28} />}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{t.title || `Task #${t.id}`}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
                <span>{titleCase(t.trigger)}</span>
                <span title={dateTime(t.started_at)}>{timeAgo(t.started_at)}</span>
                <span>{duration(t.started_at, t.finished_at)}</span>
                <span>{t.num_turns} turns</span>
                <span>{usd(t.cost_usd)}</span>
              </div>
            </div>
            <StatusBadge status={t.status} />
            <ChevronRight size={16} className="text-subtle" />
          </button>
        );
      })}
    </div>
  );
}

function Collapsible({ summary, children, defaultOpen, tone }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean; tone?: string }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className={cn("rounded-lg border border-border bg-surface-2", tone)}>
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs">
        <ChevronRight size={14} className={cn("shrink-0 text-subtle transition-transform", open && "rotate-90")} />
        <span className="min-w-0 flex-1 truncate">{summary}</span>
      </button>
      {open && <div className="border-t border-border px-3 py-2">{children}</div>}
    </div>
  );
}

function Code({ value }: { value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return <pre className="max-h-96 overflow-auto font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-muted">{text}</pre>;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : JSON.stringify(c)))
      .join("\n");
  }
  return JSON.stringify(content, null, 2);
}

function inputPreview(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const v = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.subject ?? o.title ?? o.query ?? Object.values(o)[0];
  return typeof v === "string" ? v.slice(0, 90) : "";
}

function TranscriptItem({ entry }: { entry: TranscriptEntry }) {
  const e = entry as Record<string, unknown>;
  switch (entry.type) {
    case "text":
      return (
        <div className="flex gap-3">
          <MessageSquare size={15} className="mt-1 shrink-0 text-accent" />
          <Markdown className="min-w-0 flex-1">{String(e.text ?? "")}</Markdown>
        </div>
      );
    case "tool_use":
      return (
        <Collapsible
          summary={
            <span className="flex items-center gap-2">
              <Wrench size={12} className="shrink-0 text-warning" />
              <span className="font-mono font-semibold">{String(e.name ?? "tool")}</span>
              <span className="truncate font-mono text-subtle">{inputPreview(e.input)}</span>
            </span>
          }
        >
          <Code value={e.input ?? e} />
        </Collapsible>
      );
    case "tool_result": {
      const isError = !!e.is_error;
      const text = resultText(e.content ?? e.output ?? "");
      return (
        <Collapsible
          tone={isError ? "border-danger/40" : undefined}
          summary={
            <span className="flex items-center gap-2">
              {isError ? <XCircle size={12} className="shrink-0 text-danger" /> : <CheckCircle2 size={12} className="shrink-0 text-success" />}
              <span className="text-muted">{isError ? "Tool error" : "Tool result"}</span>
              <span className="truncate font-mono text-subtle">{text.split("\n")[0]?.slice(0, 100)}</span>
            </span>
          }
        >
          <Code value={text} />
        </Collapsible>
      );
    }
    case "result":
      return (
        <div className="rounded-lg border border-accent/30 bg-accent-soft p-3">
          <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-accent">
            <Flag size={13} /> Result
            {typeof e.subtype === "string" && <span className="font-normal text-muted">{e.subtype}</span>}
          </div>
          {typeof e.result === "string" ? <Markdown>{e.result}</Markdown> : <Code value={e} />}
        </div>
      );
    default:
      return (
        <Collapsible summary={<span className="font-mono text-muted">{entry.type}</span>}>
          <Code value={entry} />
        </Collapsible>
      );
  }
}

export function TaskDrawer({ taskId, onClose }: { taskId: number | null; onClose: () => void }) {
  const costLabels = useCostLabels();
  const { agentById } = useSession();
  const query = useQuery({
    queryKey: qk.task(taskId ?? 0),
    queryFn: () => api.task(taskId!),
    enabled: taskId != null,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 5000 : false),
  });
  const t = query.data;
  const agent = agentById(t?.agent_id);
  return (
    <Drawer
      open={taskId != null}
      onClose={onClose}
      width={760}
      title={
        <span className="flex items-center gap-2">
          <span className="truncate">{t?.title || `Task #${taskId}`}</span>
          {t && <StatusBadge status={t.status} />}
        </span>
      }
    >
      {query.isPending && <Loading />}
      {query.isError && <div className="p-4"><ErrorState error={query.error} /></div>}
      {t && (
        <div className="space-y-5 p-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: "Trigger", value: titleCase(t.trigger), icon: <Repeat size={13} /> },
              { label: "Duration", value: duration(t.started_at, t.finished_at), icon: <Bot size={13} /> },
              { label: "Turns", value: t.num_turns, icon: <MessageSquare size={13} /> },
              { label: costLabels.cost, value: usd(t.cost_usd, 3), icon: <Coins size={13} /> },
            ].map((s) => (
              <div key={s.label} className="rounded-lg border border-border bg-surface-2 p-2.5">
                <div className="flex items-center gap-1.5 text-[11px] tracking-wide text-muted uppercase">{s.icon}{s.label}</div>
                <div className="mt-0.5 text-sm font-semibold tabular-nums">{s.value}</div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
            {agent && (
              <Link to={`/team/${agent.id}`} className="flex items-center gap-1.5 hover:text-fg" onClick={onClose}>
                <Avatar agent={agent} size={20} /> {agent.name}
              </Link>
            )}
            <span>Started {dateTime(t.started_at)}</span>
            <span>{t.input_tokens.toLocaleString()} in / {t.output_tokens.toLocaleString()} out tokens</span>
          </div>
          {Object.keys(t.trigger_ref ?? {}).length > 0 && (
            <Collapsible summary={<span className="text-muted">Trigger details</span>}>
              <Code value={t.trigger_ref} />
            </Collapsible>
          )}
          {t.error && (
            <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
              <div className="mb-1 font-semibold">Error</div>
              <pre className="font-mono text-xs whitespace-pre-wrap">{t.error}</pre>
            </div>
          )}
          {t.result && (
            <div>
              <div className="label">Outcome</div>
              <div className="card p-3"><Markdown>{t.result}</Markdown></div>
            </div>
          )}
          <div>
            <div className="label">Transcript ({t.transcript.length})</div>
            {t.transcript.length ? (
              <div className="space-y-2">
                {t.transcript.map((entry, i) => <TranscriptItem key={i} entry={entry} />)}
              </div>
            ) : (
              <div className="text-sm text-muted">{t.status === "running" ? "Transcript will appear when the task finishes." : "No transcript recorded."}</div>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}
