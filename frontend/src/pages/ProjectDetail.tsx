import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  CheckCircle2,
  CircleDot,
  Coins,
  ExternalLink,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Pencil,
  Tag,
  UserMinus,
  UserPlus,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { useSession } from "../App";
import { api } from "../api/client";
import { qk, useAgents, useCostLabels } from "../api/queries";
import type { Project, WorkItem } from "../api/types";
import { ActivityFeed } from "../components/ActivityFeed";
import { AgentSelect } from "../components/AgentSelect";
import { Avatar } from "../components/Avatar";
import { Modal } from "../components/Modal";
import { ThroughputChart } from "../components/ThroughputChart";
import { useToast } from "../components/Toasts";
import { EmptyState, ErrorState, Field, FormError, Loading, Markdown, Section, Spinner, StatTile } from "../components/ui";
import { timeAgo, usd } from "../lib/format";

function AddMemberDialog({ project, open, onClose }: { project: Project; open: boolean; onClose: () => void }) {
  const { data: agents } = useAgents("active");
  const qc = useQueryClient();
  const toast = useToast();
  const [agentId, setAgentId] = useState<number | null>(null);
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (open) {
      setAgentId(null);
      setRole("");
      setError(null);
    }
  }, [open]);
  const candidates = (agents ?? []).filter((a) => !project.members.some((m) => m.agent_id === a.id));
  const submit = async () => {
    if (!agentId) return;
    setBusy(true);
    setError(null);
    try {
      const p = await api.addMember(project.id, { agent_id: agentId, project_role: role });
      qc.setQueryData(qk.project(project.id), p);
      qc.invalidateQueries({ queryKey: qk.projects });
      qc.invalidateQueries({ queryKey: qk.agentsAll });
      toast.success("Member added");
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Add a member to ${project.name}`}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={busy || !agentId}>
            {busy ? <Spinner className="text-accent-fg" /> : <UserPlus size={15} />} Add member
          </button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Agent">
          <AgentSelect agents={candidates} value={agentId} onChange={setAgentId} placeholder={candidates.length ? "Select an agent…" : "Everyone is already on this project"} />
        </Field>
        <Field label="Project role (optional)" hint="e.g. Tech lead, Frontend owner, QA">
          <input className="input" value={role} onChange={(e) => setRole(e.target.value)} />
        </Field>
      </div>
      <FormError error={error} />
    </Modal>
  );
}

function EditProjectDialog({ project, open, onClose }: { project: Project; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [status, setStatus] = useState(project.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (open) {
      setName(project.name);
      setDescription(project.description);
      setStatus(project.status);
      setError(null);
    }
  }, [open, project]);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await api.updateProject(project.id, { name, description, status });
      qc.setQueryData(qk.project(project.id), p);
      qc.invalidateQueries({ queryKey: qk.projects });
      toast.success("Project updated");
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit project"
      size="lg"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={busy || !name.trim()}>
            {busy && <Spinner className="text-accent-fg" />} Save
          </button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
          <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Status">
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="archived">Archived</option>
            </select>
          </Field>
        </div>
        <Field label="Description"><textarea className="input min-h-40" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      </div>
      <FormError error={error} />
    </Modal>
  );
}

function WorkColumn({ title, icon, items, empty }: { title: string; icon: ReactNode; items: WorkItem[]; empty: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-surface-2">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5 text-sm font-semibold">
        {icon} {title} <span className="rounded-full bg-surface-3 px-1.5 text-xs text-muted">{items.length}</span>
      </div>
      <div className="max-h-[480px] space-y-2 overflow-y-auto p-2">
        {items.length ? items.map((i) => (
          <a
            key={i.number}
            href={i.url ?? undefined}
            target="_blank"
            rel="noreferrer"
            className="block rounded-lg border border-border bg-surface p-3 transition hover:border-border-strong"
          >
            <div className="flex items-start gap-2">
              <span className="font-mono text-xs text-subtle">#{i.number}</span>
              <span className="min-w-0 flex-1 text-sm leading-snug font-medium">{i.title}</span>
              <ExternalLink size={12} className="mt-1 shrink-0 text-subtle" />
            </div>
            {i.labels.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {i.labels.map((l) => <span key={l} className="chip py-0 text-[11px]"><Tag size={10} /> {l}</span>)}
              </div>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              {i.author && <span>by @{i.author}</span>}
              {i.assignees.length > 0 && <span>→ {i.assignees.map((a) => `@${a}`).join(", ")}</span>}
              {i.reviewers.length > 0 && <span>review: {i.reviewers.map((a) => `@${a}`).join(", ")}</span>}
              {i.updated_at && <span className="ml-auto text-subtle">{timeAgo(i.updated_at)}</span>}
            </div>
          </a>
        )) : <div className="px-2 py-6 text-center text-sm text-subtle">{empty}</div>}
      </div>
    </div>
  );
}

export default function ProjectDetail() {
  const costLabels = useCostLabels();
  const id = Number(useParams().id);
  const qc = useQueryClient();
  const toast = useToast();
  const { agentById } = useSession();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState<number | null>(null);

  const project = useQuery({ queryKey: qk.project(id), queryFn: () => api.project(id) });
  const stats = useQuery({ queryKey: qk.projectStats(id), queryFn: () => api.projectStats(id) });
  const work = useQuery({ queryKey: qk.projectWork(id), queryFn: () => api.projectWork(id), retry: false });
  const activity = useQuery({ queryKey: qk.activity({ project_id: id, limit: 40 }), queryFn: () => api.activity({ project_id: id, limit: 40 }) });

  if (project.isPending) return <Loading />;
  if (project.isError) return <ErrorState error={project.error} onRetry={() => project.refetch()} />;
  const p = project.data;
  const s = stats.data;

  const remove = async (agentId: number) => {
    setRemoving(agentId);
    try {
      const updated = await api.removeMember(p.id, agentId);
      qc.setQueryData(qk.project(p.id), updated);
      qc.invalidateQueries({ queryKey: qk.projects });
      qc.invalidateQueries({ queryKey: qk.agentsAll });
      toast.success("Member removed");
    } catch (e) {
      toast.error("Could not remove member", e instanceof Error ? e.message : undefined);
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div>
      <Link to="/projects" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={15} /> Projects
      </Link>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{p.name}</h1>
            {p.status !== "active" && <span className="chip capitalize">{p.status}</span>}
          </div>
          <a href={p.repo_url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1.5 font-mono text-sm text-accent hover:underline">
            {p.repo_name} <ExternalLink size={13} />
          </a>
        </div>
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={() => setEditing(true)}><Pencil size={15} /> Edit</button>
          <a className="btn-secondary" href={p.repo_url} target="_blank" rel="noreferrer"><ExternalLink size={15} /> Open in Gitea</a>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Open issues" value={s?.open_issues ?? "—"} icon={<CircleDot size={15} />} tone="#22c55e" />
        <StatTile label="Closed issues" value={s?.closed_issues ?? "—"} icon={<CheckCircle2 size={15} />} tone="#a855f7" />
        <StatTile label="Open PRs" value={s?.open_prs ?? "—"} icon={<GitPullRequest size={15} />} tone="#3b82f6" />
        <StatTile label="Merged PRs" value={s?.merged_prs ?? "—"} icon={<GitMerge size={15} />} tone="#a855f7" />
        <StatTile label="Commits" value={s?.commits_30d ?? "—"} icon={<GitCommitHorizontal size={15} />} tone="#64748b" hint="last 30 days" />
        <StatTile label={costLabels.cost} value={s ? usd(s.cost_30d_usd) : "—"} icon={<Coins size={15} />} tone="#f59e0b" hint={costLabels.subscription ? "last 30 days · API-equivalent, not billed" : "last 30 days"} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <Section title="Throughput · last 30 days">
            {stats.isPending ? <Loading /> : stats.isError ? <ErrorState error={stats.error} /> : <ThroughputChart data={s!.throughput} />}
          </Section>
          <Section title="Board" actions={<a href={p.repo_url} target="_blank" rel="noreferrer" className="text-xs text-muted hover:text-fg">View all in Gitea</a>}>
            {work.isPending ? <Loading /> : work.isError ? (
              <ErrorState error={work.error} onRetry={() => work.refetch()} />
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                <WorkColumn title="Open issues" icon={<CircleDot size={15} className="text-success" />} items={work.data.issues} empty="No open issues." />
                <WorkColumn title="Open pull requests" icon={<GitPullRequest size={15} className="text-accent" />} items={work.data.pulls} empty="No open pull requests." />
              </div>
            )}
          </Section>
        </div>
        <div className="space-y-6">
          <Section title="About">
            {p.description ? <Markdown>{p.description}</Markdown> : <div className="text-sm text-muted">No description. <button className="text-accent hover:underline" onClick={() => setEditing(true)}>Add one</button> so agents know the goal.</div>}
          </Section>
          <Section
            title={`Members (${p.members.length})`}
            actions={<button className="btn-secondary btn-sm" onClick={() => setAdding(true)}><UserPlus size={14} /> Add</button>}
          >
            {p.members.length ? (
              <ul className="-mx-2 space-y-0.5">
                {p.members.map((m) => {
                  const agent = agentById(m.agent_id);
                  return (
                    <li key={m.agent_id} className="group flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-2">
                      <Link to={`/team/${m.agent_id}`} className="flex min-w-0 flex-1 items-center gap-3">
                        <Avatar agent={m} size={34} working={agent?.working} />
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{m.name}</div>
                          <div className="truncate text-xs text-muted">{m.role_name}{m.project_role && ` · ${m.project_role}`}</div>
                        </div>
                      </Link>
                      <button
                        className="btn-ghost p-1.5 opacity-0 group-hover:opacity-100 focus:opacity-100"
                        onClick={() => remove(m.agent_id)}
                        disabled={removing === m.agent_id}
                        title="Remove from project"
                      >
                        {removing === m.agent_id ? <Spinner size={14} /> : <UserMinus size={15} />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState className="py-6" title="No members yet" description="Assign agents so they can start on this project." action={<button className="btn-primary btn-sm" onClick={() => setAdding(true)}><UserPlus size={14} /> Add member</button>} />
            )}
          </Section>
          <Section title="Project activity">
            {activity.isPending ? <Loading /> : <ActivityFeed items={activity.data} compact className="-mx-2 max-h-[420px] overflow-y-auto" emptyText="Nothing has happened in this project yet." />}
          </Section>
        </div>
      </div>
      <AddMemberDialog project={p} open={adding} onClose={() => setAdding(false)} />
      <EditProjectDialog project={p} open={editing} onClose={() => setEditing(false)} />
    </div>
  );
}
