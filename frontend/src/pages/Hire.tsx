import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Bot, Check, FileSignature, Hammer, ShieldCheck, Sparkles, UserPlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useSession } from "../App";
import { api } from "../api/client";
import { qk, useFeatures, useMeta, useRoles } from "../api/queries";
import type { HireIn, Role, VoiceType } from "../api/types";
import { AvatarPicker, EffortPicker, ModelPicker, ResponsibilitiesEditor, TraitPicker, VoicePicker, tierFor } from "../components/AgentFields";
import { DicebearImg } from "../components/Avatar";
import { RoleBadge } from "../components/Badges";
import { useToast } from "../components/Toasts";
import { ErrorState, Field, FormError, Loading, PageHeader, Spinner } from "../components/ui";
import { cn, randomSeed, normalizeHandle, titleCase, usd } from "../lib/format";

const STEPS = ["Role", "Identity", "Skills", "Offer"] as const;

interface Draft {
  role: Role | null;
  name: string;
  handle: string;
  handleTouched: boolean;
  bio: string;
  avatar_style: string;
  avatar_seed: string;
  voice_type: VoiceType;
  voice_name: string | null;
  model: string;
  effort: string;
  traits: string[];
  responsibilities: string[];
  max_turns: number;
  daily_budget_usd: number;
}

const HANDLE_RE = /^[a-z0-9][a-z0-9.]{1,39}$/;

function Stepper({ step, onJump, maxReached }: { step: number; onJump: (i: number) => void; maxReached: number }) {
  return (
    <ol className="mb-8 flex items-center gap-2">
      {STEPS.map((s, i) => {
        const done = i < step;
        const current = i === step;
        return (
          <li key={s} className="flex flex-1 items-center gap-2">
            <button
              disabled={i > maxReached}
              onClick={() => onJump(i)}
              className={cn(
                "flex items-center gap-2 text-sm font-medium whitespace-nowrap transition disabled:cursor-not-allowed",
                current ? "text-fg" : done ? "text-accent" : "text-subtle",
              )}
            >
              <span
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-bold",
                  current ? "border-accent bg-accent text-accent-fg" : done ? "border-accent bg-accent-soft text-accent" : "border-border-strong",
                )}
              >
                {done ? <Check size={14} /> : i + 1}
              </span>
              <span className="hidden sm:inline">{s}</span>
            </button>
            {i < STEPS.length - 1 && <span className={cn("h-px flex-1", i < step ? "bg-accent" : "bg-border")} />}
          </li>
        );
      })}
    </ol>
  );
}

export default function Hire() {
  const { data: roles, isPending, isError, error } = useRoles();
  const { data: meta } = useMeta();
  const features = useFeatures();
  const { me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [maxReached, setMaxReached] = useState(0);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<unknown>(null);
  const [d, setD] = useState<Draft>({
    role: null,
    name: "",
    handle: "",
    handleTouched: false,
    bio: "",
    voice_type: "any",
    voice_name: null,
    avatar_style: "notionists",
    avatar_seed: randomSeed(),
    model: "",
    effort: "high",
    traits: [],
    responsibilities: [],
    max_turns: 60,
    daily_budget_usd: 10,
  });

  useEffect(() => {
    if (meta && !d.model) {
      setD((x) => ({ ...x, model: meta.models[1]?.id ?? meta.models[0]?.id ?? "", avatar_style: meta.avatar_styles[0] ?? x.avatar_style }));
    }
  }, [meta, d.model]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  const pickRole = (r: Role) => {
    setD((x) => ({ ...x, role: r, responsibilities: [...r.responsibilities] }));
    go(1);
  };

  const go = (i: number) => {
    setStep(i);
    setMaxReached((m) => Math.max(m, i));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const identityValid = d.name.trim().length > 0 && HANDLE_RE.test(d.handle);
  const generateProfile = async () => {
    if (!d.role) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const p = await api.generateProfile(d.role.id, d.traits);
      setD((x) => ({ ...x, name: p.name, bio: p.bio, handle: normalizeHandle(p.name), handleTouched: false, avatar_seed: p.name, voice_type: p.voice_type, voice_name: null }));
    } catch (e) {
      setGenerateError(e);
    } finally {
      setGenerating(false);
    }
  };

  const canNext = [!!d.role, identityValid, !!d.model, true][step];

  const payload = useMemo<HireIn | null>(() => {
    if (!d.role) return null;
    return {
      name: d.name.trim(),
      handle: normalizeHandle(d.handle),
      role_id: d.role.id,
      bio: d.bio,
      responsibilities: d.responsibilities.filter((r) => r.trim()),
      traits: d.traits,
      model: d.model || null,
      effort: d.effort,
      avatar_style: d.avatar_style,
      avatar_seed: d.avatar_seed,
      voice_type: d.voice_type,
      voice_name: d.voice_name,
      max_turns: d.max_turns,
      daily_budget_usd: d.daily_budget_usd,
    };
  }, [d]);

  const hire = async () => {
    if (!payload) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const agent = await api.hire(payload);
      qc.invalidateQueries({ queryKey: qk.agentsAll });
      qc.invalidateQueries({ queryKey: qk.directory });
      qc.invalidateQueries({ queryKey: qk.overview });
      toast.push({ title: `Welcome aboard, ${agent.name}!`, message: `${agent.email} is ready to work.`, kind: "celebrate", icon: "sparkles" });
      navigate(`/team/${agent.id}`);
    } catch (e) {
      setSubmitError(e);
    } finally {
      setBusy(false);
    }
  };

  if (isPending) return <Loading />;
  if (isError) return <ErrorState error={error} />;

  return (
    <div className="mx-auto max-w-4xl">
      <Link to="/team" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={15} /> Team
      </Link>
      <PageHeader icon={<UserPlus size={20} />} title="Hire a new team member" subtitle="Find the right person for the job — in four steps." />
      <Stepper step={step} onJump={go} maxReached={maxReached} />

      {step === 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          {roles.map((r) => (
            <button
              key={r.id}
              onClick={() => pickRole(r)}
              className={cn(
                "card group relative overflow-hidden p-5 text-left transition hover:-translate-y-0.5 hover:border-border-strong",
                d.role?.id === r.id && "ring-2 ring-accent",
              )}
            >
              <span className="absolute inset-x-0 top-0 h-1" style={{ background: r.color }} />
              <div className="flex items-center justify-between">
                <RoleBadge name={r.name} color={r.color} />
                {r.can_merge && <span className="chip"><ShieldCheck size={12} /> Can merge</span>}
              </div>
              <p className="mt-3 text-sm text-muted">{r.description || "No description."}</p>
              {r.responsibilities.length > 0 && (
                <ul className="mt-3 space-y-1">
                  {r.responsibilities.slice(0, 4).map((x) => (
                    <li key={x} className="flex items-start gap-2 text-xs text-muted">
                      <Check size={13} className="mt-0.5 shrink-0" style={{ color: r.color }} /> {x}
                    </li>
                  ))}
                  {r.responsibilities.length > 4 && <li className="pl-5 text-xs text-subtle">+{r.responsibilities.length - 4} more</li>}
                </ul>
              )}
              <div className="mt-4 flex items-center gap-1 text-sm font-medium text-accent opacity-0 transition group-hover:opacity-100">
                Hire a {r.name} <ArrowRight size={14} />
              </div>
            </button>
          ))}
          {!roles.length && <div className="text-sm text-muted">No roles defined. Create one in <Link className="text-accent" to="/settings">Settings</Link>.</div>}
        </div>
      )}

      {step === 1 && meta && (
        <div className="card grid gap-6 p-6 lg:grid-cols-2">
          <div className="grid content-start gap-4">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2">
              <p className="text-xs text-muted">Not feeling creative? Let Claude invent a {d.role?.name ?? "new hire"}.</p>
              <button type="button" className="btn-ghost shrink-0" onClick={generateProfile} disabled={generating} title="Generate a name and bio">
                {generating ? <Spinner /> : <Bot size={16} />}
                {generating ? "Inventing…" : "Generate"}
              </button>
            </div>
            {generateError != null && <FormError error={generateError} />}
            <Field label="Full name">
              <input
                className="input"
                autoFocus
                value={d.name}
                placeholder="Ada Lovelace"
                onChange={(e) => {
                  const name = e.target.value;
                  setD((x) => ({ ...x, name, handle: x.handleTouched ? x.handle : normalizeHandle(name) }));
                }}
              />
            </Field>
            <Field
              label="Handle"
              hint={d.handle && !HANDLE_RE.test(d.handle) ? <span className="text-danger">2–40 chars: lowercase letters, numbers and dots</span> : <>Email: <span className="font-mono">{d.handle || "handle"}@{meta.mail_domain}</span> · Gitea: @{(d.handle || "handle").replace(/\./g, "-")}</>}
            >
              <div className="relative">
                <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-subtle">@</span>
                <input
                  className="input pl-7 font-mono"
                  value={d.handle}
                  onChange={(e) => setD((x) => ({ ...x, handle: e.target.value.toLowerCase().replace(/[^a-z0-9.]+/g, "."), handleTouched: true }))}
                  onBlur={() => setD((x) => ({ ...x, handle: normalizeHandle(x.handle) }))}
                />
              </div>
            </Field>
            <Field label="Bio" hint="A short backstory. Shapes how they introduce themselves.">
              <textarea className="input min-h-28" value={d.bio} onChange={(e) => set("bio", e.target.value)} placeholder="Former systems engineer who loves clean APIs and thorough tests." />
            </Field>
          </div>
          <div>
            <span className="label">Avatar</span>
            <AvatarPicker styles={meta.avatar_styles} style={d.avatar_style} seed={d.avatar_seed} onChange={(s, seed) => setD((x) => ({ ...x, avatar_style: s, avatar_seed: seed }))} />
            <p className="mt-3 text-xs text-subtle">You can upload a photo from their profile after hiring.</p>
            <div className="mt-5">
              <span className="label">Voice (for 1:1 calls)</span>
              <VoicePicker handle={d.handle} name={d.name} type={d.voice_type} voiceName={d.voice_name}
                onChange={(t, v) => setD((x) => ({ ...x, voice_type: t, voice_name: v }))} />
            </div>
          </div>
        </div>
      )}

      {step === 2 && meta && (
        <div className="card grid gap-6 p-6">
          <div>
            <span className="label">Seniority</span>
            <ModelPicker models={meta.models} value={d.model} onChange={(v) => set("model", v)} />
          </div>
          <div className="grid gap-6 md:grid-cols-2">
            <div>
              <span className="label">Effort</span>
              <EffortPicker efforts={meta.efforts} value={d.effort} onChange={(v) => set("effort", v)} />
              <p className="mt-1.5 text-xs text-subtle">Higher effort = deeper thinking, higher cost.</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Max turns / task"><input type="number" min={1} max={500} className="input" value={d.max_turns} onChange={(e) => set("max_turns", Number(e.target.value))} /></Field>
              <Field label="Daily budget (USD)"><input type="number" min={0} step={0.5} className="input" value={d.daily_budget_usd} onChange={(e) => set("daily_budget_usd", Number(e.target.value))} /></Field>
            </div>
          </div>
          {features.morale && (
            <div>
              <span className="label">Personality traits</span>
              <TraitPicker traits={meta.traits} value={d.traits} onChange={(v) => set("traits", v)} />
            </div>
          )}
          <div>
            <span className="label">Responsibilities</span>
            <p className="mb-2 text-xs text-subtle">Prefilled from the {d.role?.name} role. Tailor them to this person.</p>
            <ResponsibilitiesEditor value={d.responsibilities} onChange={(v) => set("responsibilities", v)} />
          </div>
        </div>
      )}

      {step === 3 && d.role && meta && (
        <div className="card relative overflow-hidden">
          <div className="h-1.5" style={{ background: `linear-gradient(90deg, ${d.role.color}, #22d3ee)` }} />
          <div className="p-6 sm:p-10">
            <div className="flex items-center gap-2 text-xs font-semibold tracking-[0.2em] text-muted uppercase">
              <FileSignature size={14} /> Offer letter
            </div>
            <div className="mt-6 flex flex-col gap-6 sm:flex-row sm:items-start">
              <DicebearImg styleName={d.avatar_style} seed={d.avatar_seed} className="h-24 w-24 rounded-2xl border border-border bg-surface-3" />
              <div className="flex-1 space-y-4 text-sm leading-relaxed">
                <p>Dear <strong>{d.name}</strong>,</p>
                <p>
                  We’re delighted to offer you the position of <RoleBadge name={d.role.name} color={d.role.color} /> on the team,
                  at a <strong>{tierFor(meta.models, d.model)}</strong> level ({meta.models.find((m) => m.id === d.model)?.name ?? d.model}).
                  You’ll be known as <span className="font-mono">@{d.handle}</span> and reachable at <span className="font-mono">{d.handle}@{meta.mail_domain}</span>.
                </p>
                {d.bio && <p className="text-muted italic">“{d.bio}”</p>}
                <div>
                  <div className="mb-1.5 font-medium">Your responsibilities</div>
                  <ul className="space-y-1">
                    {d.responsibilities.filter(Boolean).map((r) => (
                      <li key={r} className="flex items-start gap-2 text-muted"><Check size={14} className="mt-0.5 shrink-0 text-success" />{r}</li>
                    ))}
                    {!d.responsibilities.length && <li className="text-subtle">Role defaults apply.</li>}
                  </ul>
                </div>
                <div className="grid grid-cols-2 gap-3 rounded-xl border border-border bg-surface-2 p-4 sm:grid-cols-4">
                  <div><div className="text-xs text-muted">Effort</div><div className="font-semibold">{titleCase(d.effort)}</div></div>
                  <div><div className="text-xs text-muted">Daily budget</div><div className="font-semibold">{usd(d.daily_budget_usd)}</div></div>
                  <div><div className="text-xs text-muted">Max turns</div><div className="font-semibold">{d.max_turns}</div></div>
                  <div><div className="text-xs text-muted">Merge rights</div><div className="font-semibold">{d.role.can_merge ? "Yes" : "No"}</div></div>
                </div>
                {features.morale && d.traits.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Sparkles size={14} className="text-xp" />
                    {d.traits.map((t) => <span key={t} className="chip">{titleCase(t)}</span>)}
                  </div>
                )}
                <p>On your first day you’ll get a Gitea account and a welcome email. We look forward to working with you.</p>
                <p className="pt-2">
                  Sincerely,<br />
                  <span className="text-lg font-semibold italic" style={{ fontFamily: "cursive" }}>{me.name || me.username}</span><br />
                  <span className="text-xs text-muted">Engineering Manager</span>
                </p>
              </div>
            </div>
            <FormError error={submitError} />
          </div>
        </div>
      )}

      <div className="mt-6 flex items-center justify-between">
        <button className="btn-ghost" onClick={() => go(step - 1)} disabled={step === 0}>
          <ArrowLeft size={15} /> Back
        </button>
        {step < 3 ? (
          <button className="btn-primary" onClick={() => go(step + 1)} disabled={!canNext}>
            Next <ArrowRight size={15} />
          </button>
        ) : (
          <button className="btn-primary px-5" onClick={hire} disabled={busy || !payload}>
            {busy ? <Spinner className="text-accent-fg" /> : <Hammer size={15} />} {busy ? "Onboarding…" : "Sign & send offer"}
          </button>
        )}
      </div>
    </div>
  );
}
