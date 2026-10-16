import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, CornerUpLeft, Inbox as InboxIcon, Paperclip, Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSession } from "../App";
import { api } from "../api/client";
import { qk, useProjects } from "../api/queries";
import type { MailFolder, Message, Thread, ThreadSummary } from "../api/types";
import { cn, dateTime, shortTime } from "../lib/format";
import { AddressInput } from "./AddressInput";
import { AttachButton, AttachmentTray, DropZone, MessageAttachments, useAttachments } from "./Attachments";
import { Avatar } from "./Avatar";
import { Modal } from "./Modal";
import { useToast } from "./Toasts";
import { EmptyState, ErrorState, Field, FormError, Loading, Markdown, Spinner } from "./ui";

export function SenderAvatar({ address, size = 36 }: { address: string; size?: number }) {
  const { agentByAddress, nameFor } = useSession();
  const agent = agentByAddress(address);
  if (agent) return <Avatar agent={agent} size={size} dimmed={agent.status === "fired"} />;
  return <Avatar size={size} fallback={nameFor(address).slice(0, 1).toUpperCase()} />;
}

export function ThreadList({ threads, selected, onSelect, folder, mailbox }: {
  threads: ThreadSummary[] | undefined;
  selected: number | null;
  onSelect: (id: number) => void;
  folder: MailFolder;
  /** Address whose mailbox this is (affects unread / display). */
  mailbox: string;
}) {
  const { nameFor } = useSession();
  if (!threads) return <Loading />;
  if (!threads.length) {
    return (
      <EmptyState
        icon={<InboxIcon size={20} />}
        title={folder === "inbox" ? "Inbox zero" : folder === "sent" ? "Nothing sent yet" : "No archived threads"}
        description={folder === "inbox" ? "When your team emails you, threads show up here." : undefined}
        className="m-4 border-none"
      />
    );
  }
  return (
    <ul className="divide-y divide-border">
      {threads.map((t) => {
        const unread = t.unread > 0;
        const others = t.participants.filter((p) => p !== mailbox);
        const who = folder === "sent"
          ? `To: ${others.map(nameFor).join(", ") || "—"}`
          : t.last_sender_name ?? (t.last_sender ? nameFor(t.last_sender) : "—");
        return (
          <li key={t.id}>
            <button
              onClick={() => onSelect(t.id)}
              className={cn(
                "flex w-full items-start gap-3 px-4 py-3 text-left transition",
                selected === t.id ? "bg-accent-soft" : "hover:bg-surface-2",
              )}
            >
              {t.last_sender ? <SenderAvatar address={t.last_sender} size={34} /> : <Avatar size={34} />}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className={cn("min-w-0 flex-1 truncate text-sm", unread ? "font-semibold text-fg" : "text-muted")}>
                    {who}
                    {t.message_count > 1 && <span className="ml-1 text-xs font-normal text-subtle">({t.message_count})</span>}
                  </span>
                  <span className={cn("shrink-0 text-xs", unread ? "font-semibold text-accent" : "text-subtle")}>
                    {shortTime(t.updated_at)}
                  </span>
                </div>
                <div className={cn("flex items-center gap-1.5 truncate text-sm", unread ? "font-semibold" : "text-fg/90")}>
                  <span className="truncate">{t.subject}</span>
                  {t.attachment_count > 0 && <Paperclip size={12} className="shrink-0 text-subtle" aria-label={`${t.attachment_count} attachments`} />}
                </div>
                <div className="line-clamp-2 text-xs text-subtle">{t.snippet}</div>
              </div>
              {unread && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent" />}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function MessageCard({ m, collapsed, onToggle }: { m: Message; collapsed: boolean; onToggle: () => void }) {
  const { nameFor } = useSession();
  const to = m.recipients.filter((r) => r.kind === "to");
  const cc = m.recipients.filter((r) => r.kind === "cc");
  return (
    <article className="card overflow-hidden">
      <button onClick={onToggle} className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface-2">
        <SenderAvatar address={m.sender} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-semibold">{nameFor(m.sender)}</span>
            <span className="text-xs text-subtle">&lt;{m.sender}&gt;</span>
          </div>
          {collapsed ? (
            <div className="flex items-center gap-1.5 truncate text-sm text-muted">
              {m.attachments.length > 0 && <Paperclip size={12} className="shrink-0" />}
              <span className="truncate">{m.body.slice(0, 140) || m.attachments.map((a) => a.filename).join(", ")}</span>
            </div>
          ) : (
            <div className="text-xs text-muted">
              to {to.map((r) => nameFor(r.address)).join(", ")}
              {cc.length > 0 && <> · cc {cc.map((r) => nameFor(r.address)).join(", ")}</>}
            </div>
          )}
        </div>
        <span className="shrink-0 text-xs text-subtle" title={dateTime(m.created_at)}>
          {shortTime(m.created_at)}
        </span>
      </button>
      {!collapsed && (
        <div className="border-t border-border px-4 py-4 sm:pl-[64px]">
          {m.body.trim() && <Markdown>{m.body}</Markdown>}
          <MessageAttachments attachments={m.attachments} />
        </div>
      )}
    </article>
  );
}

/** Reply recipients: everyone else on the thread, from the viewer's perspective. */
function replyRecipients(thread: Thread, me: string): { to: string[]; cc: string[] } {
  const last = thread.messages[thread.messages.length - 1];
  if (!last) return { to: [], cc: [] };
  const everyone = new Set<string>();
  for (const m of thread.messages) {
    everyone.add(m.sender);
    for (const r of m.recipients) everyone.add(r.address);
  }
  everyone.delete(me);
  const to = last.sender !== me
    ? [last.sender]
    : last.recipients.filter((r) => r.kind === "to" && r.address !== me).map((r) => r.address);
  const cc = [...everyone].filter((a) => !to.includes(a));
  return { to, cc };
}

export function ThreadView({ threadId, readOnly, folder, onArchived }: {
  threadId: number;
  readOnly?: boolean;
  folder?: MailFolder;
  onArchived?: () => void;
}) {
  const { managerAddress } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: projects } = useProjects();
  const query = useQuery({ queryKey: qk.thread(threadId), queryFn: () => api.thread(threadId) });
  const thread = query.data;
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const files = useAttachments();

  // Opening a thread marks it read server-side; refresh counters.
  useEffect(() => {
    if (query.isSuccess) {
      qc.invalidateQueries({ queryKey: qk.unread });
      qc.invalidateQueries({ queryKey: ["mail", "threads"] });
    }
  }, [query.isSuccess, query.dataUpdatedAt, qc]);

  useEffect(() => {
    if (!thread) return;
    const r = replyRecipients(thread, managerAddress);
    setTo(r.to);
    setCc(r.cc);
    const last = thread.messages[thread.messages.length - 1];
    setExpanded(new Set(last ? [last.id] : []));
    setBody("");
    setError(null);
    files.reset();
  }, [thread?.id, thread?.messages.length]);

  const project = useMemo(() => projects?.find((p) => p.id === thread?.project_id), [projects, thread]);

  if (query.isPending) return <Loading />;
  if (query.isError) return <div className="p-4"><ErrorState error={query.error} onRetry={() => query.refetch()} /></div>;
  if (!thread) return null;

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      await api.send({ to, cc, body, thread_id: thread.id, attachment_ids: files.ids });
      setBody("");
      files.reset();
      toast.success("Reply sent");
      qc.invalidateQueries({ queryKey: ["mail"] });
    } catch (e) {
      setError(e);
    } finally {
      setSending(false);
    }
  };

  const canSend = !sending && !files.uploading && !!to.length && (!!body.trim() || files.ids.length > 0);

  const archive = async (archived: boolean) => {
    try {
      await api.archive(thread.id, archived);
      toast.success(archived ? "Thread archived" : "Moved to inbox");
      qc.invalidateQueries({ queryKey: ["mail"] });
      onArchived?.();
    } catch (e) {
      toast.error("Could not archive", e instanceof Error ? e.message : undefined);
    }
  };

  const toggle = (id: number) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="flex flex-col gap-3 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold break-words">{thread.subject}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>{thread.messages.length} message{thread.messages.length === 1 ? "" : "s"}</span>
            {project && <span className="chip">{project.name}</span>}
            {readOnly && <span className="chip">Read-only</span>}
          </div>
        </div>
        {!readOnly && folder && folder !== "sent" && (
          <button className="btn-secondary btn-sm" onClick={() => archive(folder !== "archived")}>
            {folder === "archived" ? <><ArchiveRestore size={14} /> Unarchive</> : <><Archive size={14} /> Archive</>}
          </button>
        )}
      </div>
      {thread.messages.map((m) => (
        <MessageCard key={m.id} m={m} collapsed={!expanded.has(m.id)} onToggle={() => toggle(m.id)} />
      ))}
      {!readOnly && (
        <DropZone state={files} className="card mt-2 p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium">
            <CornerUpLeft size={16} className="text-muted" /> Reply
          </div>
          <div className="grid gap-3">
            <Field label="To"><AddressInput value={to} onChange={setTo} /></Field>
            <Field label="Cc"><AddressInput value={cc} onChange={setCc} /></Field>
            <textarea
              className="input min-h-28 font-[inherit]"
              placeholder="Write your reply (Markdown supported). Paste or drop images and files to attach…"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onPaste={files.onPaste}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSend) send();
              }}
            />
            <AttachmentTray state={files} />
          </div>
          <FormError error={error} />
          <div className="mt-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <AttachButton state={files} />
              <span className="hidden text-xs text-subtle sm:inline">Ctrl/⌘ + Enter to send</span>
            </div>
            <button className="btn-primary" disabled={!canSend} onClick={send}>
              {sending ? <Spinner className="text-accent-fg" /> : <Send size={15} />} {files.uploading ? "Uploading…" : "Send"}
            </button>
          </div>
        </DropZone>
      )}
    </div>
  );
}

export function ComposeDialog({ open, onClose, initialTo = [], initialSubject = "", initialBody = "", projectId }: {
  open: boolean;
  onClose: () => void;
  initialTo?: string[];
  initialSubject?: string;
  initialBody?: string;
  projectId?: number | null;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: projects } = useProjects();
  const [to, setTo] = useState<string[]>(initialTo);
  const [cc, setCc] = useState<string[]>([]);
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(initialBody);
  const [project, setProject] = useState<number | null>(projectId ?? null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const files = useAttachments();
  const canSend = !sending && !files.uploading && !!to.length && !!subject.trim() && (!!body.trim() || files.ids.length > 0);

  useEffect(() => {
    if (open) {
      setTo(initialTo);
      setCc([]);
      setSubject(initialSubject);
      setBody(initialBody);
      setProject(projectId ?? null);
      setError(null);
      files.reset();
    }
  }, [open]);

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      await api.send({ to, cc, subject, body, project_id: project, attachment_ids: files.ids });
      toast.success("Email sent", subject);
      qc.invalidateQueries({ queryKey: ["mail"] });
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New message"
      size="lg"
      footer={
        <>
          <span className="mr-auto"><AttachButton state={files} /></span>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!canSend} onClick={send}>
            {sending ? <Spinner className="text-accent-fg" /> : <Send size={15} />} {files.uploading ? "Uploading…" : "Send"}
          </button>
        </>
      }
    >
      <DropZone state={files} className="grid gap-3">
        <Field label="To"><AddressInput value={to} onChange={setTo} placeholder="Type a name or address…" autoFocus={!initialTo.length} /></Field>
        <Field label="Cc"><AddressInput value={cc} onChange={setCc} /></Field>
        <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
          <Field label="Subject">
            <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} autoFocus={!!initialTo.length} />
          </Field>
          <Field label="Project (optional)">
            <select className="input" value={project ?? ""} onChange={(e) => setProject(e.target.value ? Number(e.target.value) : null)}>
              <option value="">None</option>
              {projects?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Message" hint="Markdown supported. Paste or drop images and files to attach — agents can open screenshots and PDFs.">
          <textarea className="input min-h-48" value={body} onChange={(e) => setBody(e.target.value)} onPaste={files.onPaste} />
        </Field>
        <AttachmentTray state={files} />
      </DropZone>
      <FormError error={error} />
    </Modal>
  );
}
