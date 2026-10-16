import { useQueryClient } from "@tanstack/react-query";
import { FolderGit2, FolderPlus, Plus } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api/client";
import { qk, useProjects } from "../api/queries";
import type { Project } from "../api/types";
import { Avatar } from "../components/Avatar";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toasts";
import { EmptyState, ErrorState, Field, FormError, Loading, PageHeader, Spinner, Switch } from "../components/ui";
import { cn, dateOnly, slugifyHandle } from "../lib/format";

export function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [repo, setRepo] = useState("");
  const [nodeCi, setNodeCi] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await api.createProject({ name, description, repo_name: repo.trim() || null, ci_template: nodeCi ? "node" : null });
      qc.invalidateQueries({ queryKey: qk.projects });
      toast.success("Project created", `Repository ${p.repo_name} is ready in Gitea.`);
      onClose();
      setName("");
      setDescription("");
      setRepo("");
      navigate(`/projects/${p.id}`);
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
      title="New project"
      description="Creates a Gitea repository your team can work in."
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !name.trim()} onClick={submit}>
            {busy ? <Spinner className="text-accent-fg" /> : <FolderPlus size={15} />} Create project
          </button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Name"><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Payments API" /></Field>
        <Field label="Repository name" hint={`Leave empty to use “${slugifyHandle(name) || "derived-from-name"}”.`}>
          <input className="input font-mono" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder={slugifyHandle(name)} />
        </Field>
        <Field label="Description" hint="Agents read this to understand the goal. Markdown is fine.">
          <textarea className="input min-h-28" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What should the team build? Who is it for?" />
        </Field>
        <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-surface-2 px-3 py-2.5">
          <div>
            <div className="text-sm font-medium">Node.js CI</div>
            <p className="text-xs text-muted">Adds a Gitea Actions workflow that installs, lints, tests and builds on every push and pull request.</p>
          </div>
          <Switch checked={nodeCi} onChange={setNodeCi} label="Node.js CI" />
        </div>
      </div>
      <FormError error={error} />
    </Modal>
  );
}

function ProjectCard({ p }: { p: Project }) {
  const archived = p.status !== "active";
  return (
    <Link to={`/projects/${p.id}`} className={cn("card group flex flex-col p-5 transition hover:-translate-y-0.5 hover:border-border-strong", archived && "opacity-60")}>
      <div className="flex items-start justify-between gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <FolderGit2 size={20} />
        </span>
        {archived && <span className="chip capitalize">{p.status}</span>}
      </div>
      <div className="mt-3 font-semibold">{p.name}</div>
      <div className="font-mono text-xs text-subtle">{p.repo_name}</div>
      <p className="mt-2 line-clamp-3 flex-1 text-sm text-muted">{p.description || "No description yet."}</p>
      <div className="mt-4 flex items-center justify-between">
        <div className="flex -space-x-2">
          {p.members.slice(0, 6).map((m) => <Avatar key={m.agent_id} agent={m} size={28} className="rounded-full ring-2 ring-surface" />)}
          {p.members.length > 6 && (
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-surface-3 text-[11px] font-semibold ring-2 ring-surface">
              +{p.members.length - 6}
            </span>
          )}
          {!p.members.length && <span className="text-xs text-subtle">No members yet</span>}
        </div>
        <span className="text-xs text-subtle">{dateOnly(p.created_at)}</span>
      </div>
    </Link>
  );
}

export default function Projects() {
  const { data, isPending, isError, error, refetch } = useProjects();
  const [open, setOpen] = useState(false);
  return (
    <div>
      <PageHeader
        icon={<FolderGit2 size={20} />}
        title="Projects"
        subtitle="Each project is a Gitea repository with its own team."
        actions={<button className="btn-primary" onClick={() => setOpen(true)}><Plus size={16} /> New project</button>}
      />
      {isPending && <Loading />}
      {isError && <ErrorState error={error} onRetry={() => refetch()} />}
      {data && !data.length && (
        <EmptyState
          icon={<FolderGit2 size={22} />}
          title="No projects yet"
          description="Create a project to give your team a repository, then assign agents to it."
          action={<button className="btn-primary" onClick={() => setOpen(true)}><Plus size={16} /> Create your first project</button>}
        />
      )}
      {data && data.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {data.map((p) => <ProjectCard key={p.id} p={p} />)}
        </div>
      )}
      <NewProjectDialog open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
