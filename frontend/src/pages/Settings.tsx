import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ExternalLink,
  Gamepad2,
  HeartPulse,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Server,
  Sparkles,
  Settings as SettingsIcon,
  ShieldCheck,
  Trophy,
  Volume2,
  XCircle,
  Zap,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api/client";
import { qk, useMeta, useRoles, useSettings, useStatus } from "../api/queries";
import type { Role, RoleIn, Settings } from "../api/types";
import { ResponsibilitiesEditor } from "../components/AgentFields";
import { RoleBadge } from "../components/Badges";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toasts";
import { ErrorState, Field, FormError, Loading, PageHeader, Section, Spinner, Switch } from "../components/ui";
import { cn } from "../lib/format";

const COLORS = ["#6366f1", "#8b5cf6", "#ec4899", "#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#06b6d4", "#3b82f6", "#64748b"];

const EMPTY_ROLE: RoleIn = { name: "", description: "", responsibilities: [], prompt: "", builtin_tools: [], can_merge: false, color: "#6366f1" };

function RoleDialog({ role, open, onClose }: { role: Role | null; open: boolean; onClose: () => void }) {
  const { data: meta } = useMeta();
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<RoleIn>(EMPTY_ROLE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (open) {
      setForm(role ? {
        name: role.name, description: role.description, responsibilities: [...role.responsibilities], prompt: role.prompt,
        builtin_tools: [...role.builtin_tools], can_merge: role.can_merge, color: role.color,
      } : EMPTY_ROLE);
      setError(null);
    }
  }, [open, role]);

  const set = <K extends keyof RoleIn>(k: K, v: RoleIn[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (role) await api.updateRole(role.id, form);
      else await api.createRole(form);
      qc.invalidateQueries({ queryKey: qk.roles });
      qc.invalidateQueries({ queryKey: qk.agentsAll });
      toast.success(role ? "Role updated" : "Role created", form.name);
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
      size="xl"
      title={role ? `Edit role · ${role.name}` : "New role"}
      description="Roles are templates: new hires inherit responsibilities, tools and permissions."
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={busy || !form.name.trim()}>
            {busy && <Spinner className="text-accent-fg" />} {role ? "Save role" : "Create role"}
          </button>
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="grid content-start gap-4">
          <Field label="Name"><input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Backend Engineer" /></Field>
          <Field label="Description"><textarea className="input min-h-20" value={form.description} onChange={(e) => set("description", e.target.value)} /></Field>
          <div>
            <span className="label">Color</span>
            <div className="flex flex-wrap items-center gap-2">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => set("color", c)}
                  className={cn("h-7 w-7 rounded-full border-2 transition", form.color === c ? "scale-110 border-fg" : "border-transparent")}
                  style={{ background: c }}
                  aria-label={c}
                />
              ))}
              <input type="color" value={form.color} onChange={(e) => set("color", e.target.value)} className="h-7 w-9 cursor-pointer rounded border border-border bg-transparent" />
              <RoleBadge name={form.name || "Preview"} color={form.color} />
            </div>
          </div>
          <div>
            <span className="label">Built-in tools</span>
            <div className="flex flex-wrap gap-2">
              {(meta?.builtin_tools ?? []).map((t) => {
                const on = form.builtin_tools.includes(t);
                return (
                  <label key={t} className={cn("flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 font-mono text-xs", on ? "border-accent bg-accent-soft" : "border-border bg-surface-2 text-muted")}>
                    <input
                      type="checkbox"
                      className="accent-[var(--accent)]"
                      checked={on}
                      onChange={() => set("builtin_tools", on ? form.builtin_tools.filter((x) => x !== t) : [...form.builtin_tools, t])}
                    />
                    {t}
                  </label>
                );
              })}
            </div>
            <div className="mt-1.5 text-xs text-subtle">File-system and shell tools available inside the agent’s workspace. Email and Gitea tools are always on.</div>
          </div>
          <label className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface-2 p-3">
            <span>
              <span className="flex items-center gap-1.5 text-sm font-medium"><ShieldCheck size={15} /> Can merge pull requests</span>
              <span className="text-xs text-muted">Grants merge rights on project repositories.</span>
            </span>
            <Switch checked={form.can_merge} onChange={(v) => set("can_merge", v)} label="Can merge" />
          </label>
        </div>
        <div className="grid content-start gap-4">
          <div>
            <span className="label">Default responsibilities</span>
            <ResponsibilitiesEditor value={form.responsibilities} onChange={(v) => set("responsibilities", v)} />
          </div>
          <Field label="Role prompt" hint="Instructions added to every agent with this role (how they work, what to prioritize).">
            <textarea className="input min-h-56 font-mono text-xs" value={form.prompt} onChange={(e) => set("prompt", e.target.value)} />
          </Field>
        </div>
      </div>
      <FormError error={error} />
    </Modal>
  );
}

function ToggleRow({ icon, title, description, checked, onChange, disabled }: {
  icon: ReactNode; title: string; description: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <div className="flex items-start gap-4 py-3.5">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">{icon}</span>
      <div className="flex-1">
        <div className="text-sm font-medium">{title}</div>
        <div className="mt-0.5 text-sm text-muted">{description}</div>
      </div>
      <Switch checked={checked} onChange={onChange} disabled={disabled} label={title} />
    </div>
  );
}

function StatusRow({ ok, label, detail }: { ok: boolean; label: string; detail?: ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2.5">
      {ok ? <CheckCircle2 size={17} className="mt-0.5 text-success" /> : <XCircle size={17} className="mt-0.5 text-danger" />}
      <div className="flex-1">
        <div className="text-sm font-medium">{label}</div>
        {detail && <div className="text-xs text-muted">{detail}</div>}
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const settings = useSettings();
  const status = useStatus();
  const roles = useRoles();
  const qc = useQueryClient();
  const toast = useToast();
  const [saving, setSaving] = useState<keyof Settings | null>(null);
  const [period, setPeriod] = useState<number | "">("");
  const [speedDraft, setSpeedDraft] = useState(1.15);
  const [editing, setEditing] = useState<Role | null>(null);
  const [roleOpen, setRoleOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const restoreMorale = async () => {
    setRestoring(true);
    try {
      const r = await api.restoreMorale();
      qc.invalidateQueries({ queryKey: ["agents"] });
      toast.success(r.restored ? `Morale restored for ${r.restored} agent${r.restored === 1 ? "" : "s"}` : `Everyone is already at ${r.morale}+ morale`);
    } catch (e) {
      toast.error("Could not restore morale", e instanceof Error ? e.message : undefined);
    } finally {
      setRestoring(false);
    }
  };

  useEffect(() => {
    if (settings.data) {
      setPeriod(settings.data.review_period_days);
      setSpeedDraft(settings.data.voice_speed);
    }
  }, [settings.data]);

  const update = async (patch: Partial<Settings>) => {
    const key = Object.keys(patch)[0] as keyof Settings;
    setSaving(key);
    const prev = qc.getQueryData<Settings>(qk.settings);
    if (prev) qc.setQueryData(qk.settings, { ...prev, ...patch });
    try {
      const s = await api.updateSettings(patch);
      qc.setQueryData(qk.settings, s);
      qc.invalidateQueries({ queryKey: ["leaderboard"] });
    } catch (e) {
      if (prev) qc.setQueryData(qk.settings, prev);
      toast.error("Could not save setting", e instanceof Error ? e.message : undefined);
    } finally {
      setSaving(null);
    }
  };

  if (settings.isPending) return <Loading />;
  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => settings.refetch()} />;
  const s = settings.data;

  return (
    <div>
      <PageHeader icon={<SettingsIcon size={20} />} title="Settings" subtitle="Tune the game, control the team, and check the plumbing." />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <Section title={<span className="flex items-center gap-2"><Gamepad2 size={16} /> Gamification</span>}>
            <p className="-mt-1 mb-1 text-sm text-muted">Each module can be switched off. Disabled modules disappear from the dashboard and from agents’ prompts.</p>
            <div className="divide-y divide-border">
              <ToggleRow
                icon={<Zap size={17} />}
                title="XP, levels & achievements"
                description="Agents earn XP for merged PRs, reviews and closed issues, level up and unlock badges."
                checked={s.feature_xp}
                disabled={saving === "feature_xp"}
                onChange={(v) => update({ feature_xp: v })}
              />
              <ToggleRow
                icon={<Trophy size={17} />}
                title="Leaderboards & performance reviews"
                description="Rank the team by output and get periodic HR reviews with recommendations."
                checked={s.feature_leaderboard}
                disabled={saving === "feature_leaderboard"}
                onChange={(v) => update({ feature_leaderboard: v })}
              />
              <ToggleRow
                icon={<HeartPulse size={17} />}
                title="Morale & traits"
                description="Agents have personality traits and a morale level that reacts to praise, criticism and workload."
                checked={s.feature_morale}
                disabled={saving === "feature_morale"}
                onChange={(v) => update({ feature_morale: v })}
              />
            </div>
            {s.feature_morale && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
                <p className="text-sm text-muted">Team running on empty? Bring everyone below the starting morale back up to it.</p>
                <button className="btn-secondary" onClick={() => void restoreMorale()} disabled={restoring}>
                  {restoring ? <Spinner /> : <Sparkles size={15} />} Restore team morale
                </button>
              </div>
            )}
            {s.feature_leaderboard && (
              <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-border pt-4">
                <Field label="Review period (days)" className="w-44">
                  <input type="number" min={1} max={90} className="input" value={period} onChange={(e) => setPeriod(e.target.value ? Number(e.target.value) : "")} />
                </Field>
                <button
                  className="btn-secondary"
                  disabled={period === "" || period === s.review_period_days || saving === "review_period_days"}
                  onClick={() => period !== "" && update({ review_period_days: period })}
                >
                  {saving === "review_period_days" && <Spinner />} Save
                </button>
              </div>
            )}
          </Section>

          <Section title={<span className="flex items-center gap-2"><ShieldCheck size={16} /> Roles</span>} actions={<button className="btn-secondary btn-sm" onClick={() => { setEditing(null); setRoleOpen(true); }}><Plus size={14} /> New role</button>}>
            {roles.isPending ? <Loading /> : roles.isError ? <ErrorState error={roles.error} /> : (
              <ul className="-mx-2 divide-y divide-border">
                {roles.data.map((r) => (
                  <li key={r.id} className="flex items-start gap-3 px-2 py-3">
                    <span className="mt-1.5 h-3 w-3 shrink-0 rounded-full" style={{ background: r.color }} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{r.name}</span>
                        {r.can_merge && <span className="chip"><ShieldCheck size={11} /> merge</span>}
                        {r.builtin_tools.map((t) => <span key={t} className="chip font-mono text-[10px]">{t}</span>)}
                      </div>
                      <div className="mt-0.5 line-clamp-2 text-sm text-muted">{r.description}</div>
                    </div>
                    <button className="btn-ghost btn-sm" onClick={() => { setEditing(r); setRoleOpen(true); }}><Pencil size={13} /> Edit</button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        <div className="space-y-6">
          <Section title={<span className="flex items-center gap-2"><Volume2 size={16} /> 1:1 calls</span>}>
            <Field label={`Speaking speed · ${speedDraft.toFixed(2)}×`} hint="How fast agents talk in voice calls. 1.00× is a normal pace.">
              <input
                type="range"
                min={0.8}
                max={1.5}
                step={0.05}
                value={speedDraft}
                className="w-full accent-[var(--accent)]"
                onChange={(e) => setSpeedDraft(Number(e.target.value))}
                onPointerUp={() => speedDraft !== s.voice_speed && update({ voice_speed: speedDraft })}
                onKeyUp={() => speedDraft !== s.voice_speed && update({ voice_speed: speedDraft })}
              />
            </Field>
            <div className="mt-1 flex justify-between text-xs text-subtle"><span>Slower</span><span>Faster</span></div>
          </Section>

          <section className={cn("card overflow-hidden", s.agents_paused && "border-warning/50")}>
            <div className="flex items-start gap-4 p-4">
              <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", s.agents_paused ? "bg-warning/15 text-warning" : "bg-danger/10 text-danger")}>
                {s.agents_paused ? <Pause size={20} /> : <Play size={20} />}
              </span>
              <div className="flex-1">
                <div className="font-semibold">Pause all agents</div>
                <div className="mt-0.5 text-sm text-muted">
                  Kill switch. No new agent runs start while paused; running tasks finish. Mail and webhooks still queue up.
                </div>
              </div>
              <Switch checked={s.agents_paused} onChange={(v) => update({ agents_paused: v })} disabled={saving === "agents_paused"} label="Pause all agents" />
            </div>
            {s.agents_paused && <div className="border-t border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning">Agents are paused.</div>}
          </section>

          <Section
            title={<span className="flex items-center gap-2"><Server size={16} /> System status</span>}
            actions={<button className="btn-ghost btn-sm" onClick={() => status.refetch()}><RefreshCw size={13} className={status.isFetching ? "animate-spin" : ""} /> Check</button>}
          >
            {status.isPending ? <Loading /> : status.isError ? <ErrorState error={status.error} /> : (
              <div className="divide-y divide-border">
                <StatusRow ok={status.data.gitea_reachable} label="Gitea reachable" detail={<a className="inline-flex items-center gap-1 hover:text-fg" href={status.data.gitea_url} target="_blank" rel="noreferrer">{status.data.gitea_url} <ExternalLink size={11} /></a>} />
                <StatusRow ok={status.data.gitea_bootstrapped} label="Gitea bootstrapped" detail={status.data.gitea_bootstrapped ? <>Organization <span className="font-mono">{status.data.gitea_org}</span></> : <>Run <code className="font-mono">make bootstrap</code></>} />
                <StatusRow ok={status.data.claude_auth !== "local"} label="Claude credentials" detail={status.data.claude_auth === "subscription" ? "Claude subscription (CLAUDE_CODE_OAUTH_TOKEN)" : status.data.claude_auth === "api_key" ? "API key (ANTHROPIC_API_KEY)" : <>Local Claude Code login — set <code className="font-mono">CLAUDE_CODE_OAUTH_TOKEN</code> for Docker</>} />
              </div>
            )}
          </Section>
        </div>
      </div>
      <RoleDialog role={editing} open={roleOpen} onClose={() => setRoleOpen(false)} />
    </div>
  );
}
