import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity as ActivityIcon,
  ArrowLeft,
  Bot,
  Briefcase,
  Camera,
  ClipboardCheck,
  Coins,
  ExternalLink,
  FolderPlus,
  Heart,
  Mail,
  Megaphone,
  Pencil,
  Phone,
  Sparkles,
  Trash2,
  User,
  UserMinus,
} from "lucide-react";
import { useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api/client";
import { qk, useAgent, useCostLabels, useFeatures, useMeta } from "../api/queries";
import type { Agent, MailFolder } from "../api/types";
import { AchievementGrid } from "../components/Achievements";
import { ActivityFeed } from "../components/ActivityFeed";
import { tierFor } from "../components/AgentFields";
import { AssignDialog, EditAgentDialog, FireDialog, KudosDialog, NudgeDialog } from "../components/AgentDialogs";
import { Avatar } from "../components/Avatar";
import { LevelBadge, RoleBadge, StatusBadge } from "../components/Badges";
import { ComposeDialog, ThreadList, ThreadView } from "../components/Mail";
import { MoraleMeter, XPBar } from "../components/Meters";
import { ReviewCard } from "../components/ReviewCard";
import { Segmented, Tabs, type TabDef } from "../components/Tabs";
import { TaskDrawer, TaskList } from "../components/Tasks";
import { useToast } from "../components/Toasts";
import { EmptyState, ErrorState, Loading, Section, Spinner } from "../components/ui";
import { dateOnly, titleCase, usd } from "../lib/format";

type Tab = "overview" | "activity" | "tasks" | "mailbox" | "meetings" | "reviews";
type DialogKind = "edit" | "nudge" | "kudos" | "assign" | "fire" | "mail" | null;

function AvatarUpload({ agent, editable }: { agent: Agent; editable: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const upload = async (file: File) => {
    if (file.size > 2_000_000) {
      toast.error("Image too large", "Avatars must be under 2 MB.");
      return;
    }
    setBusy(true);
    try {
      const a = await api.uploadAvatar(agent.id, file);
      qc.setQueryData(qk.agent(agent.id), a);
      qc.invalidateQueries({ queryKey: qk.agentsAll });
      qc.invalidateQueries({ queryKey: qk.projects });
      toast.success("Photo updated");
    } catch (e) {
      toast.error("Upload failed", e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      const a = await api.removeAvatar(agent.id);
      qc.setQueryData(qk.agent(agent.id), a);
      qc.invalidateQueries({ queryKey: qk.agentsAll });
      toast.success("Photo removed");
    } catch (e) {
      toast.error("Could not remove photo", e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="group relative shrink-0">
      <Avatar agent={agent} size={112} working={agent.working} dimmed={agent.status === "fired"} ring={agent.status === "fired" ? undefined : agent.role.color} />
      {editable && (
        <>
          <button
            onClick={() => ref.current?.click()}
            className="absolute inset-0 flex items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition group-hover:opacity-100 focus:opacity-100"
            title="Upload photo"
            disabled={busy}
          >
            {busy ? <Spinner className="text-white" /> : <Camera size={22} />}
          </button>
          {agent.avatar_url && (
            <button onClick={remove} className="absolute -right-1 -bottom-1 rounded-full border border-border bg-surface p-1.5 text-muted opacity-0 shadow transition group-hover:opacity-100 hover:text-danger" title="Remove photo">
              <Trash2 size={13} />
            </button>
          )}
          <input
            ref={ref}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload(f);
              e.target.value = "";
            }}
          />
        </>
      )}
    </div>
  );
}

function Mailbox({ agent }: { agent: Agent }) {
  const [folder, setFolder] = useState<MailFolder>("inbox");
  const [selected, setSelected] = useState<number | null>(null);
  const threads = useQuery({
    queryKey: qk.threads(folder, agent.email),
    queryFn: () => api.threads(folder, agent.email),
  });
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Segmented<MailFolder>
          value={folder}
          onChange={(f) => { setFolder(f); setSelected(null); }}
          options={[{ value: "inbox", label: "Inbox" }, { value: "sent", label: "Sent" }, { value: "archived", label: "Archived" }]}
        />
        <span className="text-xs text-subtle">Read-only view of {agent.email}</span>
      </div>
      <div className="card grid min-h-[480px] overflow-hidden md:grid-cols-[minmax(260px,340px)_1fr]">
        <div className="max-h-[640px] overflow-y-auto border-b border-border md:border-r md:border-b-0">
          {threads.isError ? <div className="p-3"><ErrorState error={threads.error} /></div> : (
            <ThreadList threads={threads.data} selected={selected} onSelect={setSelected} folder={folder} mailbox={agent.email} />
          )}
        </div>
        <div className="max-h-[640px] min-w-0 overflow-y-auto bg-bg/40">
          {selected ? <ThreadView threadId={selected} readOnly /> : (
            <div className="flex h-full items-center justify-center p-8 text-sm text-subtle">Select a thread to read it.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function Meetings({ agent }: { agent: Agent }) {
  const q = useQuery({ queryKey: qk.meetings(agent.id), queryFn: () => api.meetings(agent.id) });
  const [open, setOpen] = useState<number | null>(null);
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} />;
  if (!q.data.length) {
    return (
      <EmptyState
        icon={<Phone size={20} />}
        title="No 1:1s yet"
        description={`Hop on a voice call with ${agent.name.split(" ")[0]} to check in, give feedback or agree on next steps.`}
        action={agent.status === "active" ? <Link to={`/team/${agent.id}/call`} className="btn-primary"><Phone size={15} /> Start a 1:1</Link> : undefined}
      />
    );
  }
  return (
    <div className="space-y-3">
      {q.data.map((m) => (
        <article key={m.id} className="card p-4">
          <div className="flex items-center gap-2 text-sm">
            <Phone size={15} className="text-muted" />
            <span className="font-medium">{dateOnly(m.started_at)}</span>
            {m.ended_at && <span className="text-muted">· {Math.max(1, Math.round((Date.parse(m.ended_at + "Z") - Date.parse(m.started_at + "Z")) / 60000))} min</span>}
            {m.live && <span className="chip">Live</span>}
            <button className="btn-ghost btn-sm ml-auto" onClick={() => setOpen(open === m.id ? null : m.id)}>
              {open === m.id ? "Hide transcript" : "Transcript"}
            </button>
          </div>
          {m.summary && <p className="mt-2 text-sm text-muted">{m.summary}</p>}
          {m.action_items.length > 0 && (
            <ul className="mt-2 space-y-1">
              {m.action_items.map((x) => <li key={x} className="flex gap-2 text-sm"><span className="text-success">✓</span>{x}</li>)}
            </ul>
          )}
          {open === m.id && (
            <div className="mt-3 space-y-1.5 rounded-lg bg-surface-2 p-3 text-sm">
              {m.transcript.map((t, i) => (
                <div key={i}><span className="font-medium">{t.speaker === "agent" ? agent.name.split(" ")[0] : "You"}:</span> <span className="text-muted">{t.text}</span></div>
              ))}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

export default function AgentProfile() {
  const costLabels = useCostLabels();
  const id = Number(useParams().id);
  const features = useFeatures();
  const { data: meta } = useMeta();
  const agentQ = useAgent(id);
  const [tab, setTab] = useState<Tab>("overview");
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [taskId, setTaskId] = useState<number | null>(null);

  const activity = useQuery({
    queryKey: qk.activity({ agent_id: id, limit: 100 }),
    queryFn: () => api.activity({ agent_id: id, limit: 100 }),
    enabled: tab === "activity" || tab === "overview",
  });
  const tasks = useQuery({ queryKey: qk.agentTasks(id), queryFn: () => api.agentTasks(id), enabled: tab === "tasks" });
  const reviews = useQuery({ queryKey: qk.reviews(id), queryFn: () => api.reviews(id), enabled: tab === "reviews" && features.leaderboard });

  if (agentQ.isPending) return <Loading />;
  if (agentQ.isError) return <ErrorState error={agentQ.error} onRetry={() => agentQ.refetch()} />;
  const a = agentQ.data;
  const active = a.status === "active";
  const canKudos = features.xp || features.morale;

  const tabs: TabDef<Tab>[] = [
    { id: "overview", label: "Overview", icon: <User size={15} /> },
    { id: "activity", label: "Activity", icon: <ActivityIcon size={15} /> },
    { id: "tasks", label: "Tasks", icon: <Bot size={15} /> },
    { id: "mailbox", label: "Mailbox", icon: <Mail size={15} /> },
    { id: "meetings", label: "1:1s", icon: <Phone size={15} /> },
    ...(features.leaderboard ? [{ id: "reviews" as const, label: "Reviews", icon: <ClipboardCheck size={15} /> }] : []),
  ];
  const currentTab = tabs.some((t) => t.id === tab) ? tab : "overview";

  return (
    <div>
      <Link to="/team" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={15} /> Team
      </Link>

      {!active && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm text-muted">
          <UserMinus size={16} /> {a.name} is an alumnus — left the team on {dateOnly(a.fired_at)}. Their history is kept for reference.
        </div>
      )}

      <div className="card relative overflow-hidden">
        <div
          className="h-24"
          style={{ background: active ? `linear-gradient(120deg, color-mix(in srgb, ${a.role.color} 55%, transparent), color-mix(in srgb, ${a.role.color} 10%, transparent))` : "var(--surface-3)" }}
        />
        <div className="px-5 pb-5 sm:px-6">
          <div className="-mt-14 flex flex-col gap-4 sm:flex-row sm:items-end">
            <AvatarUpload agent={a} editable={active} />
            <div className="min-w-0 flex-1 sm:pb-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight">{a.name}</h1>
                {features.xp && active && <LevelBadge level={a.level} size="lg" />}
                <StatusBadge status={a.status} />
                {a.working && (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-success" /> Working now
                    {a.working_project && <span className="font-normal text-success/80">({a.working_project})</span>}
                  </span>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
                <span>@{a.handle}</span>
                <RoleBadge name={a.role.name} color={active ? a.role.color : "#94a3b8"} />
                <span className="chip">{tierFor(meta?.models, a.model)}</span>
                <span className="inline-flex items-center gap-1 font-mono text-xs"><Mail size={12} /> {a.email}</span>
                {a.gitea_url && (
                  <a href={a.gitea_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
                    Gitea profile <ExternalLink size={11} />
                  </a>
                )}
              </div>
            </div>
            {active && (
              <div className="flex flex-wrap gap-2">
                <Link to={`/team/${a.id}/call`} className="btn-primary btn-sm"><Phone size={14} /> 1:1 call</Link>
                <button className="btn-secondary btn-sm" onClick={() => setDialog("mail")}><Mail size={14} /> Email</button>
                <button className="btn-secondary btn-sm" onClick={() => setDialog("nudge")}><Megaphone size={14} /> Nudge</button>
                {canKudos && <button className="btn-secondary btn-sm" onClick={() => setDialog("kudos")}><Heart size={14} /> Kudos</button>}
                <button className="btn-secondary btn-sm" onClick={() => setDialog("assign")}><FolderPlus size={14} /> Assign</button>
                <button className="btn-secondary btn-sm" onClick={() => setDialog("edit")}><Pencil size={14} /> Edit</button>
                <button className="btn-ghost btn-sm text-danger hover:text-danger" onClick={() => setDialog("fire")}><UserMinus size={14} /> Fire</button>
              </div>
            )}
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {features.xp && (
              <div className="rounded-xl border border-border bg-surface-2 p-3.5">
                <XPBar xp={a.xp} level={a.level} progress={a.level_progress} nextLevelXp={a.next_level_xp} />
              </div>
            )}
            {features.morale && (
              <div className="rounded-xl border border-border bg-surface-2 p-3.5">
                <MoraleMeter morale={a.morale} band={a.morale_band} />
              </div>
            )}
            <div className="rounded-xl border border-border bg-surface-2 p-3.5">
              <div className="mb-1.5 flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5 font-medium"><Coins size={14} className="text-xp" /> {costLabels.cost} today</span>
                <span className="text-muted tabular-nums">{usd(a.cost_today_usd)} / {usd(a.daily_budget_usd)}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-surface-3">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.min(100, (a.cost_today_usd / Math.max(0.01, a.daily_budget_usd)) * 100)}%`,
                    background: a.cost_today_usd >= a.daily_budget_usd ? "var(--danger)" : "var(--accent)",
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <Tabs className="mt-6" tabs={tabs} value={currentTab} onChange={setTab} />
      <div className="mt-5">
        {currentTab === "overview" && (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <div className="space-y-5">
              <Section title="About">
                <p className="text-sm whitespace-pre-wrap text-muted">{a.bio || "No bio yet."}</p>
                {features.morale && a.traits.length > 0 && (
                  <div className="mt-4 flex flex-wrap items-center gap-1.5">
                    <Sparkles size={14} className="text-xp" />
                    {a.traits.map((t) => (
                      <span key={t} className="chip" title={meta?.traits.find((x) => x.key === t)?.description}>{titleCase(t)}</span>
                    ))}
                  </div>
                )}
              </Section>
              <Section title="Responsibilities">
                {a.responsibilities.length ? (
                  <ul className="space-y-2">
                    {a.responsibilities.map((r) => (
                      <li key={r} className="flex items-start gap-2.5 text-sm">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: a.role.color }} />
                        {r}
                      </li>
                    ))}
                  </ul>
                ) : <div className="text-sm text-muted">Uses the {a.role.name} role defaults.</div>}
              </Section>
              {features.xp && (
                <Section title={`Achievements (${a.achievements.length}/${meta?.achievements.length ?? a.achievements.length})`}>
                  <AchievementGrid unlocked={a.achievements} />
                </Section>
              )}
            </div>
            <div className="space-y-5">
              <Section title="Projects" actions={active && <button className="btn-ghost btn-sm" onClick={() => setDialog("assign")}><FolderPlus size={13} /> Assign</button>}>
                {a.projects.length ? (
                  <ul className="-mx-2 space-y-0.5">
                    {a.projects.map((p) => (
                      <li key={p.project_id}>
                        <Link to={`/projects/${p.project_id}`} className="flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm hover:bg-surface-2">
                          <Briefcase size={15} className="text-muted" />
                          <span className="flex-1 font-medium">{p.project_name}</span>
                          {p.project_role && <span className="text-xs text-muted">{p.project_role}</span>}
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : <div className="text-sm text-muted">Not on any project yet.</div>}
              </Section>
              <Section title="Contract">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                  <div><dt className="text-xs text-muted">Seniority</dt><dd className="font-medium">{tierFor(meta?.models, a.model)}</dd></div>
                  <div><dt className="text-xs text-muted">Model</dt><dd className="truncate font-mono text-xs">{a.model}</dd></div>
                  <div><dt className="text-xs text-muted">Effort</dt><dd className="font-medium">{titleCase(a.effort)}</dd></div>
                  <div><dt className="text-xs text-muted">Max turns</dt><dd className="font-medium">{a.max_turns}</dd></div>
                  <div><dt className="text-xs text-muted">Daily budget</dt><dd className="font-medium">{usd(a.daily_budget_usd)}</dd></div>
                  <div><dt className="text-xs text-muted">Hired</dt><dd className="font-medium">{dateOnly(a.hired_at)}</dd></div>
                </dl>
              </Section>
              <Section title="Recent activity">
                {activity.isPending ? <Loading /> : <ActivityFeed items={activity.data?.slice(0, 8)} compact className="-mx-2" />}
              </Section>
            </div>
          </div>
        )}
        {currentTab === "activity" && (
          <div className="card p-3">
            {activity.isPending ? <Loading /> : <ActivityFeed items={activity.data} emptyText={`${a.name} hasn’t done anything yet.`} />}
          </div>
        )}
        {currentTab === "tasks" && (tasks.isError ? <ErrorState error={tasks.error} /> : <TaskList tasks={tasks.data} onOpen={setTaskId} />)}
        {currentTab === "mailbox" && <Mailbox agent={a} />}
        {currentTab === "meetings" && <Meetings agent={a} />}
        {currentTab === "reviews" && (
          reviews.isPending ? <Loading /> : reviews.isError ? <ErrorState error={reviews.error} /> : reviews.data.length ? (
            <div className="space-y-4">
              {reviews.data.map((r) => (
                <ReviewCard key={r.id} review={r} agent={a} showAgent={false} canKudos={canKudos} onFire={() => setDialog("fire")} onKudos={() => setDialog("kudos")} />
              ))}
            </div>
          ) : <EmptyState icon={<ClipboardCheck size={20} />} title="No reviews yet" description="Performance reviews are written periodically by HR. You can trigger them from the Reviews page." />
        )}
      </div>

      <TaskDrawer taskId={taskId} onClose={() => setTaskId(null)} />
      {active && (
        <>
          <EditAgentDialog agent={a} open={dialog === "edit"} onClose={() => setDialog(null)} />
          <NudgeDialog agent={a} open={dialog === "nudge"} onClose={() => setDialog(null)} />
          <KudosDialog agent={a} open={dialog === "kudos"} onClose={() => setDialog(null)} />
          <AssignDialog agent={a} open={dialog === "assign"} onClose={() => setDialog(null)} />
          <ComposeDialog open={dialog === "mail"} onClose={() => setDialog(null)} initialTo={[a.email]} />
        </>
      )}
      <FireDialog agent={a} open={dialog === "fire"} onClose={() => setDialog(null)} />
    </div>
  );
}
