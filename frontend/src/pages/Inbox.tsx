import { useQuery } from "@tanstack/react-query";
import { Archive, ArrowLeft, Inbox as InboxIcon, Mail, PenSquare, RefreshCw, Search, Send } from "lucide-react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useSession } from "../App";
import { api } from "../api/client";
import { qk, useUnread } from "../api/queries";
import type { MailFolder } from "../api/types";
import { ComposeDialog, ThreadList, ThreadView } from "../components/Mail";
import { ErrorState } from "../components/ui";
import { cn } from "../lib/format";

const FOLDERS: { id: MailFolder; label: string; icon: typeof InboxIcon }[] = [
  { id: "inbox", label: "Inbox", icon: InboxIcon },
  { id: "sent", label: "Sent", icon: Send },
  { id: "archived", label: "Archived", icon: Archive },
];

export default function Inbox() {
  const { managerAddress, nameFor } = useSession();
  const [params, setParams] = useSearchParams();
  const folder = (FOLDERS.some((f) => f.id === params.get("folder")) ? params.get("folder") : "inbox") as MailFolder;
  const selected = params.get("thread") ? Number(params.get("thread")) : null;
  const [composing, setComposing] = useState(false);
  const [q, setQ] = useState("");
  const { data: unread } = useUnread();

  const threads = useQuery({ queryKey: qk.threads(folder), queryFn: () => api.threads(folder) });

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle || !threads.data) return threads.data;
    return threads.data.filter(
      (t) =>
        t.subject.toLowerCase().includes(needle) ||
        t.snippet.toLowerCase().includes(needle) ||
        t.participants.some((p) => p.includes(needle) || nameFor(p).toLowerCase().includes(needle)),
    );
  }, [threads.data, q, nameFor]);

  const setFolder = (f: MailFolder) => setParams({ folder: f });
  const select = (id: number | null) => {
    const next: Record<string, string> = { folder };
    if (id) next.thread = String(id);
    setParams(next);
  };

  return (
    <div className="flex h-full min-h-0">
      {/* Folders */}
      <aside className="hidden w-52 shrink-0 flex-col border-r border-border bg-surface p-3 lg:flex">
        <button className="btn-primary mb-4 w-full" onClick={() => setComposing(true)}>
          <PenSquare size={16} /> Compose
        </button>
        <nav className="space-y-0.5">
          {FOLDERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFolder(f.id)}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium",
                folder === f.id ? "bg-accent-soft text-fg" : "text-muted hover:bg-surface-3 hover:text-fg",
              )}
            >
              <f.icon size={16} className={folder === f.id ? "text-accent" : ""} />
              <span className="flex-1 text-left">{f.label}</span>
              {f.id === "inbox" && !!unread?.count && <span className="text-xs font-semibold text-accent tabular-nums">{unread.count}</span>}
            </button>
          ))}
        </nav>
        <div className="mt-auto rounded-lg border border-border bg-surface-2 p-3 text-xs text-muted">
          <Mail size={14} className="mb-1.5" />
          Your address: <span className="font-mono break-all text-fg">{managerAddress}</span>
          <div className="mt-1.5">Agents only communicate by email — this is how they report to you.</div>
        </div>
      </aside>

      {/* Thread list */}
      <section className={cn("flex min-h-0 w-full shrink-0 flex-col border-r border-border bg-surface md:w-[340px] xl:w-[380px]", selected != null && "hidden md:flex")}>
        <div className="space-y-2 border-b border-border p-3">
          <div className="flex items-center gap-2">
            <div className="flex flex-1 gap-1 lg:hidden">
              {FOLDERS.map((f) => (
                <button key={f.id} onClick={() => setFolder(f.id)} className={cn("rounded-md px-2 py-1 text-xs font-medium", folder === f.id ? "bg-accent-soft text-fg" : "text-muted")}>
                  {f.label}
                </button>
              ))}
            </div>
            <h2 className="hidden flex-1 text-sm font-semibold lg:block">{FOLDERS.find((f) => f.id === folder)?.label}</h2>
            <button className="btn-ghost p-1.5" onClick={() => threads.refetch()} title="Refresh">
              <RefreshCw size={15} className={threads.isFetching ? "animate-spin" : ""} />
            </button>
            <button className="btn-primary p-1.5 lg:hidden" onClick={() => setComposing(true)} title="Compose">
              <PenSquare size={15} />
            </button>
          </div>
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-subtle" />
            <input className="input py-1.5 pl-8" placeholder="Search mail" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {threads.isError ? <div className="p-3"><ErrorState error={threads.error} onRetry={() => threads.refetch()} /></div> : (
            <ThreadList threads={filtered} selected={selected} onSelect={select} folder={folder} mailbox={managerAddress} />
          )}
        </div>
      </section>

      {/* Thread view */}
      <section className={cn("min-h-0 min-w-0 flex-1 overflow-y-auto", !selected && "hidden md:block")}>
        {selected ? (
          <>
            <button className="btn-ghost m-3 mb-0 md:hidden" onClick={() => select(null)}>
              <ArrowLeft size={15} /> Back
            </button>
            <ThreadView key={selected} threadId={selected} folder={folder} onArchived={() => select(null)} />
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-muted">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent"><Mail size={26} /></span>
            <div className="font-medium text-fg">Select a conversation</div>
            <div className="max-w-xs text-sm">Or start a new one — assign work, ask for a status update, or share feedback.</div>
            <button className="btn-secondary mt-2" onClick={() => setComposing(true)}><PenSquare size={15} /> Compose</button>
          </div>
        )}
      </section>

      <ComposeDialog open={composing} onClose={() => setComposing(false)} />
    </div>
  );
}
