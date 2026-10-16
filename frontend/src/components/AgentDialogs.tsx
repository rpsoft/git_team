import { useQueryClient } from "@tanstack/react-query";
import { FolderPlus, Heart, Megaphone, UserMinus } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { qk, useAgents, useFeatures, useMeta, useProjects, useRoles } from "../api/queries";
import type { Agent, AgentUpdate, FireOut } from "../api/types";
import { AgentSelect } from "./AgentSelect";
import { AvatarPicker, EffortPicker, ModelPicker, ResponsibilitiesEditor, TraitPicker, VoicePicker } from "./AgentFields";
import { Avatar } from "./Avatar";
import { Modal } from "./Modal";
import { useToast } from "./Toasts";
import { Field, FormError, Spinner } from "./ui";

interface DialogProps {
  agent: Agent;
  open: boolean;
  onClose: () => void;
}

function useAgentInvalidation() {
  const qc = useQueryClient();
  return (agentId: number) => {
    qc.invalidateQueries({ queryKey: qk.agentsAll });
    qc.invalidateQueries({ queryKey: qk.agent(agentId) });
    qc.invalidateQueries({ queryKey: qk.projects });
    qc.invalidateQueries({ queryKey: ["project"] });
    qc.invalidateQueries({ queryKey: qk.overview });
    qc.invalidateQueries({ queryKey: ["activity"] });
  };
}

export function FireDialog({ agent, open, onClose, onFired }: DialogProps & { onFired?: (r: FireOut) => void }) {
  const { data: active } = useAgents("active");
  const invalidate = useAgentInvalidation();
  const qc = useQueryClient();
  const [successor, setSuccessor] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<FireOut | null>(null);

  useEffect(() => {
    if (open) {
      setSuccessor(null);
      setReason("");
      setError(null);
      setResult(null);
    }
  }, [open]);

  const candidates = (active ?? []).filter((a) => a.id !== agent.id);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.fire(agent.id, { reassign_to: successor, reason });
      setResult(r);
      invalidate(agent.id);
      qc.invalidateQueries({ queryKey: qk.directory });
      onFired?.(r);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    const succ = candidates.find((c) => c.id === successor);
    return (
      <Modal open={open} onClose={onClose} title={`${agent.name} has left the team`} footer={<button className="btn-primary" onClick={onClose}>Done</button>}>
        <div className="flex items-center gap-3">
          <Avatar agent={agent} size={48} dimmed />
          <p className="text-sm text-muted">
            Their Gitea account was deactivated and they’re now listed as alumni.
            {succ && <> Open work was handed over to <strong className="text-fg">{succ.name}</strong>.</>}
          </p>
        </div>
        <div className="mt-4">
          <div className="label">Handed over ({result.handed_over.length})</div>
          {result.handed_over.length ? (
            <ul className="flex flex-wrap gap-1.5">
              {result.handed_over.map((h) => <li key={h} className="chip font-mono">{h}</li>)}
            </ul>
          ) : (
            <div className="text-sm text-muted">No open issues or PRs needed reassignment.</div>
          )}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Let ${agent.name} go?`}
      description="They’ll stop working immediately and lose repository access. History is kept."
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-danger" onClick={submit} disabled={busy}>
            {busy ? <Spinner className="text-white" /> : <UserMinus size={15} />} Fire {agent.name.split(" ")[0]}
          </button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Hand over open work to" hint="Their open issues and PRs will be reassigned, and the successor gets a handover email.">
          <AgentSelect agents={candidates} value={successor} onChange={setSuccessor} allowNone noneLabel="Nobody — leave unassigned" />
        </Field>
        <Field label="Reason (optional)">
          <textarea className="input min-h-20" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Consistently missing review deadlines" />
        </Field>
      </div>
      <FormError error={error} />
    </Modal>
  );
}

export function NudgeDialog({ agent, open, onClose }: DialogProps) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (open) {
      setText("");
      setError(null);
    }
  }, [open]);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.nudge(agent.id, text);
      toast.success(`${agent.name} got your nudge`, "A task has been queued.");
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
      title={`Nudge ${agent.name}`}
      description="Give a direct instruction. The agent starts a task right away."
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={busy || !text.trim()}>
            {busy ? <Spinner className="text-accent-fg" /> : <Megaphone size={15} />} Send nudge
          </button>
        </>
      }
    >
      <textarea
        autoFocus
        className="input min-h-32"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. Please triage the open bugs and pick the most urgent one."
      />
      <FormError error={error} />
    </Modal>
  );
}

export function KudosDialog({ agent, open, onClose }: DialogProps) {
  const toast = useToast();
  const invalidate = useAgentInvalidation();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (open) {
      setText("");
      setError(null);
    }
  }, [open]);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.kudos(agent.id, text);
      toast.push({ title: `Kudos sent to ${agent.name}`, message: text || undefined, kind: "celebrate", icon: "heart" });
      invalidate(agent.id);
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
      title={`Give ${agent.name} kudos`}
      description="Recognition boosts XP and morale. A message is emailed to them."
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={busy}>
            {busy ? <Spinner className="text-accent-fg" /> : <Heart size={15} />} Send kudos
          </button>
        </>
      }
    >
      <textarea
        autoFocus
        className="input min-h-24"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Great work on the auth refactor — clean and well tested!"
      />
      <FormError error={error} />
    </Modal>
  );
}

export function AssignDialog({ agent, open, onClose }: DialogProps) {
  const toast = useToast();
  const invalidate = useAgentInvalidation();
  const { data: projects } = useProjects();
  const [projectId, setProjectId] = useState<number | null>(null);
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const available = (projects ?? []).filter((p) => p.status === "active" && !agent.projects.some((m) => m.project_id === p.id));
  useEffect(() => {
    if (open) {
      setProjectId(null);
      setRole("");
      setError(null);
    }
  }, [open]);
  const submit = async () => {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      await api.addMember(projectId, { agent_id: agent.id, project_role: role });
      toast.success(`${agent.name} joined ${available.find((p) => p.id === projectId)?.name ?? "the project"}`);
      invalidate(agent.id);
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
      title={`Assign ${agent.name} to a project`}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={busy || !projectId}>
            {busy ? <Spinner className="text-accent-fg" /> : <FolderPlus size={15} />} Assign
          </button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Project">
          <select className="input" value={projectId ?? ""} onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{available.length ? "Select a project…" : "No other active projects"}</option>
            {available.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Project role (optional)" hint="e.g. Lead, Backend owner, Reviewer">
          <input className="input" value={role} onChange={(e) => setRole(e.target.value)} />
        </Field>
      </div>
      <FormError error={error} />
    </Modal>
  );
}

export function EditAgentDialog({ agent, open, onClose }: DialogProps) {
  const { data: meta } = useMeta();
  const { data: roles } = useRoles();
  const features = useFeatures();
  const toast = useToast();
  const invalidate = useAgentInvalidation();
  const [form, setForm] = useState<Required<AgentUpdate>>(() => fromAgent(agent));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (open) {
      setForm(fromAgent(agent));
      setError(null);
    }
  }, [open, agent]);

  const set = <K extends keyof AgentUpdate>(k: K, v: Required<AgentUpdate>[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(agent.id, form);
      toast.success("Profile updated");
      invalidate(agent.id);
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
      title="Edit profile"
      size="xl"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={busy || !form.name.trim()}>
            {busy && <Spinner className="text-accent-fg" />} Save changes
          </button>
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="grid content-start gap-4">
          <Field label="Name"><input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} /></Field>
          <Field label="Role">
            <select className="input" value={form.role_id} onChange={(e) => set("role_id", Number(e.target.value))}>
              {roles?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </Field>
          <Field label="Bio"><textarea className="input min-h-20" value={form.bio} onChange={(e) => set("bio", e.target.value)} /></Field>
          <div>
            <span className="label">Voice (for 1:1 calls)</span>
            <VoicePicker handle={agent.handle} name={form.name} type={form.voice_type} voiceName={form.voice_name}
              onChange={(t, v) => setForm((f) => ({ ...f, voice_type: t, voice_name: v }))} />
          </div>
          {meta && (
            <div>
              <span className="label">Generated avatar</span>
              <AvatarPicker styles={meta.avatar_styles} style={form.avatar_style} seed={form.avatar_seed} onChange={(s, seed) => setForm((f) => ({ ...f, avatar_style: s, avatar_seed: seed }))} />
              {agent.avatar_url && <div className="mt-1.5 text-xs text-subtle">An uploaded photo is set and takes precedence. Remove it from the profile header to use this.</div>}
            </div>
          )}
        </div>
        <div className="grid content-start gap-4">
          {meta && (
            <div>
              <span className="label">Seniority</span>
              <ModelPicker models={meta.models} value={form.model} onChange={(v) => set("model", v)} />
            </div>
          )}
          {meta && (
            <div>
              <span className="label">Effort</span>
              <EffortPicker efforts={meta.efforts} value={form.effort} onChange={(v) => set("effort", v)} />
            </div>
          )}
          {features.morale && meta && (
            <div>
              <span className="label">Traits</span>
              <TraitPicker traits={meta.traits} value={form.traits} onChange={(v) => set("traits", v)} />
            </div>
          )}
          <div>
            <span className="label">Responsibilities</span>
            <ResponsibilitiesEditor value={form.responsibilities} onChange={(v) => set("responsibilities", v)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Max turns / task">
              <input type="number" min={1} max={500} className="input" value={form.max_turns} onChange={(e) => set("max_turns", Number(e.target.value))} />
            </Field>
            <Field label="Daily budget (USD)">
              <input type="number" min={0} step={0.5} className="input" value={form.daily_budget_usd} onChange={(e) => set("daily_budget_usd", Number(e.target.value))} />
            </Field>
          </div>
        </div>
      </div>
      <FormError error={error} />
    </Modal>
  );
}

function fromAgent(a: Agent): Required<AgentUpdate> {
  return {
    name: a.name,
    bio: a.bio,
    role_id: a.role.id,
    responsibilities: [...a.responsibilities],
    traits: [...a.traits],
    model: a.model,
    effort: a.effort,
    avatar_style: a.avatar_style,
    avatar_seed: a.avatar_seed,
    voice_type: a.voice_type,
    voice_name: a.voice_name,
    max_turns: a.max_turns,
    daily_budget_usd: a.daily_budget_usd,
  };
}
