import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Hand, Keyboard, Maximize2, Mic, MicOff, Minimize2, Phone, PhoneOff, Search, Send, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useMatch, useNavigate } from "react-router";
import { api } from "../api/client";
import { qk, useAgent, useSettings } from "../api/queries";
import type { Agent, Meeting, MeetingLine, Settings } from "../api/types";
import { Avatar } from "./Avatar";
import { RoleBadge } from "./Badges";
import { ErrorState, Loading, Spinner } from "./ui";
import { cn } from "../lib/format";
import { playHangUp, startRinging } from "../lib/sounds";
import {
  createListener,
  loadNaturalVoices,
  loadVoices,
  Speaker,
  speechRecognitionSupported,
  speechSynthesisSupported,
  voiceFor,
  type Listener,
  type VoiceProfile,
} from "../lib/voice";

const SPEEDS = [1, 1.15, 1.3, 1.45];

type Phase = "connecting" | "thinking" | "speaking" | "listening" | "idle" | "ending" | "ended" | "failed";

const PHASE_LABEL: Record<Phase, string> = {
  connecting: "Calling…",
  thinking: "Thinking…",
  speaking: "Speaking",
  listening: "Listening…",
  idle: "Your turn",
  ending: "Wrapping up — writing meeting notes…",
  ended: "Call ended",
  failed: "Call failed",
};

/**
 * The call in progress lives here, above the routes, so it keeps going while the manager browses.
 * On /team/:id/call it renders full size; anywhere else it shrinks to a box in the corner.
 */
interface ActiveCallState {
  agentId: number;
  /** Bumped on every new call so the call screen remounts fresh. */
  nonce: number;
  /** False once the call has ended or failed (a new call may replace it). */
  live: boolean;
}

interface ActiveCallApi {
  call: ActiveCallState | null;
  /** Start a call with an agent, unless another call is still live. */
  start: (agentId: number) => void;
  /** Forget the current call (it has to be over already, or it's hung up on unmount). */
  clear: () => void;
  setLive: (live: boolean) => void;
}

const ActiveCallContext = createContext<ActiveCallApi | null>(null);

export function useActiveCall(): ActiveCallApi {
  const c = useContext(ActiveCallContext);
  if (!c) throw new Error("useActiveCall outside ActiveCallProvider");
  return c;
}

export function ActiveCallProvider({ children }: { children: ReactNode }) {
  const [call, setCall] = useState<ActiveCallState | null>(null);
  const nonce = useRef(0);
  const start = useCallback((agentId: number) => {
    setCall((c) => (c?.live ? c : { agentId, nonce: ++nonce.current, live: true }));
  }, []);
  const clear = useCallback(() => setCall(null), []);
  const setLive = useCallback((live: boolean) => setCall((c) => (c && c.live !== live ? { ...c, live } : c)), []);
  const value = useMemo(() => ({ call, start, clear, setLive }), [call, start, clear, setLive]);
  return <ActiveCallContext.Provider value={value}>{children}</ActiveCallContext.Provider>;
}

/** Renders the active call: full size on its own route, minimised everywhere else. */
export function ActiveCallDock() {
  const { call, clear } = useActiveCall();
  const match = useMatch("/team/:id/call");
  const expanded = !!call && Number(match?.params.id) === call.agentId;

  // Leaving the notes of a finished call closes it.
  const wasExpanded = useRef(expanded);
  useEffect(() => {
    if (wasExpanded.current && !expanded && call && !call.live) clear();
    wasExpanded.current = expanded;
  }, [expanded, call, clear]);

  if (!call) return null;
  return <ActiveCallFor key={call.nonce} agentId={call.agentId} expanded={expanded} />;
}

function ActiveCallFor({ agentId, expanded }: { agentId: number; expanded: boolean }) {
  const agentQ = useAgent(agentId);
  if (agentQ.isPending) return expanded ? <Loading /> : null;
  if (agentQ.isError) return expanded ? <ErrorState error={agentQ.error} /> : null;
  return <CallScreen agent={agentQ.data} expanded={expanded} />;
}

function CallScreen({ agent, expanded }: { agent: Agent; expanded: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { clear, setLive: setCallLive } = useActiveCall();
  const qc = useQueryClient();
  const [phase, setPhase] = useState<Phase>("connecting");
  const [lines, setLines] = useState<MeetingLine[]>([]);
  const [live, setLive] = useState(""); // agent text streaming in
  const [interim, setInterim] = useState(""); // manager speech being recognized
  const [tool, setTool] = useState<string | null>(null);
  const [muted, setMuted] = useState(!speechRecognitionSupported());
  const [typing, setTyping] = useState(!speechRecognitionSupported());
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<Meeting | null>(null);
  const [seconds, setSeconds] = useState(0);

  const meetingId = useRef<number | null>(null);
  const settings = useSettings();
  const speed = settings.data?.voice_speed ?? 1.15;
  const voice = useRef<VoiceProfile>({ natural: null, voice: null, pitch: 1, rate: 1, speed });
  voice.current.speed = speed;
  const speaker = useRef<Speaker | null>(null);
  const listener = useRef<Listener | null>(null);
  const mutedRef = useRef(muted);
  const phaseRef = useRef(phase);
  const turn = useRef(0);
  const started = useRef(false);
  const transcriptEnd = useRef<HTMLDivElement>(null);
  mutedRef.current = muted;
  phaseRef.current = phase;

  const listen = useCallback(() => {
    if (["ending", "ended", "failed"].includes(phaseRef.current)) return;
    if (!mutedRef.current && listener.current) {
      setPhase("listening");
      listener.current.start();
    } else {
      setPhase("idle");
    }
  }, []);

  /** One exchange: send what the manager said (null = greeting) and voice the streamed reply. */
  const exchange = useCallback(async (text: string | null) => {
    const mid = meetingId.current;
    if (mid === null) return;
    const myTurn = ++turn.current;
    listener.current?.stop();
    speaker.current?.cancel();
    if (text) setLines((l) => [...l, { speaker: "manager", text, at: new Date().toISOString() }]);
    setPhase("thinking");
    setLive("");
    setTool(null);
    const sp = new Speaker(voice.current, {
      onStart: () => myTurn === turn.current && setPhase("speaking"),
      onIdle: () => myTurn === turn.current && listen(),
    });
    speaker.current = sp;
    let full = "";
    try {
      await api.say(mid, text, (e) => {
        if (myTurn !== turn.current) return; // superseded by an interruption
        if (e.type === "delta") {
          full += e.text;
          setLive(full);
          setTool(null);
          sp.push(e.text);
        } else if (e.type === "tool") {
          setTool(e.name);
        } else if (e.type === "done") {
          full = e.text || full;
        } else if (e.type === "error") {
          setError(e.message);
        }
      });
    } catch (e) {
      if (myTurn === turn.current) setError(e instanceof Error ? e.message : "The agent didn't answer.");
    }
    if (myTurn !== turn.current) return;
    setLive("");
    setTool(null);
    if (full.trim()) setLines((l) => [...l, { speaker: "agent", text: full.trim(), at: new Date().toISOString() }]);
    if ((voice.current.natural || speechSynthesisSupported()) && full.trim()) sp.end();
    else listen();
  }, [listen]);

  // Start the call once.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const [voices, natural] = await Promise.all([loadVoices(), loadNaturalVoices()]);
      voice.current = voiceFor(agent, voices, natural, voice.current.speed);
      listener.current = createListener({
        onInterim: setInterim,
        onFinal: (text) => void exchange(text),
        onError: (msg) => {
          setNotice(msg);
          setMuted(true);
          setTyping(true);
          setPhase((p) => (p === "listening" ? "idle" : p));
        },
      });
      try {
        const m = await api.startMeeting(agent.id);
        meetingId.current = m.id;
        await exchange(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not start the call.");
        setPhase("failed");
      }
    })();
  }, [agent.handle, agent.id, exchange]);

  // Ring until the agent picks up (first words or a failure); beep when the call fails.
  const ringing = phase === "connecting" || (phase === "thinking" && !lines.length && !live);
  useEffect(() => {
    if (ringing) return startRinging();
  }, [ringing]);
  useEffect(() => {
    if (phase === "failed") playHangUp();
    setCallLive(phase !== "ended" && phase !== "failed");
  }, [phase, setCallLive]);

  // Hang up if the tab closes; clean up audio when leaving the page.
  useEffect(() => {
    const beacon = () => {
      if (meetingId.current !== null && phaseRef.current !== "ended") {
        navigator.sendBeacon(`/api/meetings/${meetingId.current}/end`);
      }
    };
    window.addEventListener("pagehide", beacon);
    return () => {
      window.removeEventListener("pagehide", beacon);
      listener.current?.stop();
      speaker.current?.cancel();
      if (meetingId.current !== null && !["ending", "ended"].includes(phaseRef.current)) {
        void api.endMeeting(meetingId.current).catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    if (["ending", "ended", "failed", "connecting"].includes(phase)) return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [lines, live, interim]);

  const interrupt = useCallback(() => {
    if (meetingId.current === null) return;
    turn.current++;
    speaker.current?.cancel();
    void api.interruptMeeting(meetingId.current);
    setLive((l) => {
      if (l.trim()) setLines((x) => [...x, { speaker: "agent", text: l.trim() + " —", at: new Date().toISOString() }]);
      return "";
    });
    setTool(null);
    listen();
  }, [listen]);

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    mutedRef.current = next;
    if (next) {
      listener.current?.stop();
      if (phase === "listening") setPhase("idle");
    } else if (phase === "idle") {
      listen();
    }
  };

  const sendTyped = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void exchange(text);
  };

  const hangUp = async () => {
    turn.current++;
    listener.current?.stop();
    speaker.current?.cancel();
    playHangUp();
    if (meetingId.current === null) {
      clear();
      if (expanded) navigate(`/team/${agent.id}`);
      return;
    }
    setPhase("ending");
    try {
      const m = await api.endMeeting(meetingId.current);
      setResult(m);
      qc.invalidateQueries({ queryKey: ["meetings", agent.id] });
      qc.invalidateQueries({ queryKey: ["agents"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not end the call cleanly.");
    }
    setPhase("ended");
  };

  const minimise = () => {
    // Back to wherever the call was opened from, if that's inside the app.
    if (location.key !== "default") navigate(-1);
    else navigate(`/team/${agent.id}`);
  };
  const expand = () => navigate(`/team/${agent.id}/call`, { state: { resume: true } });

  // Space bar: interrupt while the agent talks (only on the call screen, so it doesn't hijack page scrolling).
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && (phase === "speaking" || phase === "thinking") && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        interrupt();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, phase, interrupt]);

  const talking = phase === "speaking";
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");

  if (!expanded) {
    const last = lines[lines.length - 1];
    return (
      <MiniCall
        agent={agent}
        phase={phase}
        tool={tool}
        clock={`${mm}:${ss}`}
        caption={interim || live || last?.text || ""}
        muted={muted}
        typing={typing}
        draft={draft}
        error={error}
        onDraft={setDraft}
        onSend={sendTyped}
        onMute={toggleMute}
        onInterrupt={interrupt}
        onHangUp={() => void hangUp()}
        onExpand={expand}
        onDismiss={clear}
      />
    );
  }

  if (phase === "ended" || phase === "ending") {
    return <CallSummary agent={agent} meeting={result} pending={phase === "ending"} error={error} seconds={seconds} />;
  }

  return (
    <div className="mx-auto max-w-3xl">
      <button className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg" onClick={minimise}>
        <Minimize2 size={15} /> Minimise — keep talking while you browse
      </button>
      <div className="card overflow-hidden">
        <div
          className="flex flex-col items-center gap-4 px-6 pt-10 pb-8 text-center"
          style={{ background: `radial-gradient(ellipse at top, color-mix(in srgb, ${agent.role.color} 30%, transparent), transparent 70%)` }}
        >
          <div className="relative grid place-items-center">
            <span
              className={cn("absolute inset-0 rounded-full transition", talking ? "animate-ping opacity-40" : "opacity-0")}
              style={{ background: agent.role.color }}
            />
            <span
              className={cn("absolute -inset-3 rounded-full border-2 transition", phase === "listening" ? "animate-pulse opacity-100" : "opacity-0")}
              style={{ borderColor: "var(--success)" }}
            />
            <div className={cn("relative transition-transform duration-300", talking && "scale-105")}>
              <Avatar agent={agent} size={128} />
            </div>
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{agent.name}</h1>
            <div className="mt-1 flex items-center justify-center gap-2 text-sm text-muted">
              <RoleBadge name={agent.role.name} color={agent.role.color} />
              <span className="tabular-nums">{mm}:{ss}</span>
            </div>
          </div>
          <div className="flex h-6 items-center gap-2 text-sm font-medium">
            {(phase === "connecting" || phase === "thinking") && <Spinner size={14} />}
            {phase === "listening" && <Mic size={15} className="text-success" />}
            {tool ? <span className="flex items-center gap-1.5 text-muted"><Search size={14} /> Looking that up…</span> : <span>{PHASE_LABEL[phase]}</span>}
          </div>
        </div>

        <div className="max-h-80 min-h-40 space-y-3 overflow-y-auto border-t border-border bg-surface-2/50 px-5 py-4 text-sm">
          {lines.map((l, i) => <Caption key={i} line={l} agent={agent} />)}
          {live && <Caption line={{ speaker: "agent", text: live, at: "" }} agent={agent} streaming />}
          {interim && <Caption line={{ speaker: "manager", text: interim, at: "" }} agent={agent} streaming />}
          {!lines.length && !live && !interim && <div className="py-6 text-center text-subtle">Captions appear here.</div>}
          <div ref={transcriptEnd} />
        </div>

        {(error || notice) && (
          <div className="border-t border-border px-5 py-2 text-xs">
            {error && <div className="text-danger">{error}</div>}
            {notice && <div className="text-muted">{notice}</div>}
          </div>
        )}

        {typing && phase !== "failed" && (
          <div className="flex gap-2 border-t border-border px-5 py-3">
            <input
              className="input flex-1"
              placeholder={`Say something to ${agent.name.split(" ")[0]}…`}
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendTyped()}
            />
            <button className="btn-primary" onClick={sendTyped} disabled={!draft.trim()}><Send size={15} /></button>
          </div>
        )}

        <div className="flex items-center justify-center gap-3 border-t border-border px-5 py-5">
          <RoundButton
            label={muted ? "Unmute" : "Mute"}
            onClick={toggleMute}
            disabled={!speechRecognitionSupported() || phase === "failed"}
            active={muted}
          >
            {muted ? <MicOff size={20} /> : <Mic size={20} />}
          </RoundButton>
          <RoundButton label="Interrupt (Space)" onClick={interrupt} disabled={!(phase === "speaking" || phase === "thinking")}>
            <Hand size={20} />
          </RoundButton>
          <button
            onClick={() => {
              const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length] ?? 1.15;
              qc.setQueryData<Settings>(qk.settings, (s) => (s ? { ...s, voice_speed: next } : s));
              void api.updateSettings({ voice_speed: next });
            }}
            title="Speaking speed (applies from the next sentence)"
            aria-label="Speaking speed"
            className="grid h-12 min-w-12 place-items-center rounded-full border border-border bg-surface-2 px-2 text-sm font-semibold tabular-nums hover:bg-surface-3"
          >
            {speed.toFixed(2).replace(/0$/, "")}×
          </button>
          <RoundButton label="Type" onClick={() => setTyping((t) => !t)} active={typing}>
            <Keyboard size={20} />
          </RoundButton>
          <button
            onClick={() => void hangUp()}
            className="grid h-14 w-14 place-items-center rounded-full bg-danger text-white shadow-lg transition hover:brightness-110"
            title="Hang up"
            aria-label="Hang up"
          >
            <PhoneOff size={22} />
          </button>
        </div>
      </div>
      {!speechRecognitionSupported() && (
        <p className="mt-3 text-center text-xs text-subtle">
          This browser can't do speech recognition, so type your side of the call. {agent.name.split(" ")[0]} still talks back. Chrome or Edge support voice both ways.
        </p>
      )}
    </div>
  );
}

function MiniCall({ agent, phase, tool, clock, caption, muted, typing, draft, error, onDraft, onSend, onMute, onInterrupt, onHangUp, onExpand, onDismiss }: {
  agent: Agent;
  phase: Phase;
  tool: string | null;
  clock: string;
  caption: string;
  muted: boolean;
  typing: boolean;
  draft: string;
  error: string | null;
  onDraft: (text: string) => void;
  onSend: () => void;
  onMute: () => void;
  onInterrupt: () => void;
  onHangUp: () => void;
  onExpand: () => void;
  onDismiss: () => void;
}) {
  const over = phase === "ending" || phase === "ended" || phase === "failed";
  return (
    <div
      role="region"
      aria-label={`Call with ${agent.name}`}
      className="card fixed bottom-4 left-4 z-30 w-[min(320px,calc(100vw-2rem))] animate-fade-in overflow-hidden shadow-xl md:left-[84px] lg:left-[256px]"
    >
      <div
        className="flex items-center gap-3 p-3"
        style={{ background: `linear-gradient(to right, color-mix(in srgb, ${agent.role.color} 18%, transparent), transparent)` }}
      >
        <button onClick={onExpand} className="relative grid shrink-0 place-items-center" title="Open call" aria-label="Open call">
          <span
            className={cn("absolute inset-0 rounded-full transition", phase === "speaking" ? "animate-ping opacity-40" : "opacity-0")}
            style={{ background: agent.role.color }}
          />
          <span
            className={cn("absolute -inset-1 rounded-full border-2 transition", phase === "listening" ? "animate-pulse opacity-100" : "opacity-0")}
            style={{ borderColor: "var(--success)" }}
          />
          <Avatar agent={agent} size={40} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{agent.name}</div>
          <div className="flex items-center gap-1.5 text-xs text-muted">
            {(phase === "connecting" || phase === "thinking" || phase === "ending") && <Spinner size={11} />}
            {phase === "listening" && <Mic size={12} className="text-success" />}
            <span className="truncate">
              {tool ? "Looking that up…" : phase === "ending" ? "Writing meeting notes…" : PHASE_LABEL[phase]}
            </span>
            {!over && <span className="ml-auto tabular-nums">{clock}</span>}
          </div>
        </div>
        {over && phase !== "ending" ? (
          <button className="btn-ghost p-1.5" onClick={onDismiss} title="Close" aria-label="Close">
            <X size={16} />
          </button>
        ) : (
          <button className="btn-ghost p-1.5" onClick={onExpand} title="Open call" aria-label="Open call">
            <Maximize2 size={16} />
          </button>
        )}
      </div>

      {error && <div className="border-t border-border px-3 py-1.5 text-xs text-danger">{error}</div>}

      {over ? (
        phase === "ended" && (
          <div className="border-t border-border p-2">
            <button className="btn-secondary btn-sm w-full" onClick={onExpand}>View meeting notes</button>
          </div>
        )
      ) : (
        <>
          {caption && <div className="line-clamp-2 border-t border-border px-3 py-2 text-xs text-muted">{caption}</div>}
          {typing && (
            <div className="flex gap-1.5 border-t border-border p-2">
              <input
                className="input min-w-0 flex-1 py-1 text-sm"
                placeholder={`Say something to ${agent.name.split(" ")[0]}…`}
                value={draft}
                onChange={(e) => onDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && onSend()}
              />
              <button className="btn-primary btn-sm" onClick={onSend} disabled={!draft.trim()} aria-label="Send"><Send size={13} /></button>
            </div>
          )}
          <div className="flex items-center justify-center gap-2 border-t border-border p-2">
            <RoundButton small label={muted ? "Unmute" : "Mute"} onClick={onMute} disabled={!speechRecognitionSupported()} active={muted}>
              {muted ? <MicOff size={16} /> : <Mic size={16} />}
            </RoundButton>
            <RoundButton small label="Interrupt" onClick={onInterrupt} disabled={!(phase === "speaking" || phase === "thinking")}>
              <Hand size={16} />
            </RoundButton>
            <button
              onClick={onHangUp}
              className="grid h-9 w-9 place-items-center rounded-full bg-danger text-white transition hover:brightness-110"
              title="Hang up"
              aria-label="Hang up"
            >
              <PhoneOff size={16} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function RoundButton({ label, onClick, disabled, active, small, children }: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  small?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        "grid place-items-center rounded-full border border-border transition disabled:opacity-40",
        small ? "h-9 w-9" : "h-12 w-12",
        active ? "bg-fg text-bg" : "bg-surface-2 hover:bg-surface-3",
      )}
    >
      {children}
    </button>
  );
}

function Caption({ line, agent, streaming }: { line: MeetingLine; agent: Agent; streaming?: boolean }) {
  const mine = line.speaker === "manager";
  return (
    <div className={cn("flex gap-2", mine && "justify-end")}>
      {!mine && <Avatar agent={agent} size={24} />}
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-3 py-2",
          mine ? "bg-accent text-accent-fg" : "bg-surface-3",
          streaming && "opacity-70",
        )}
      >
        {line.text}
      </div>
    </div>
  );
}

function CallSummary({ agent, meeting, pending, error, seconds }: {
  agent: Agent;
  meeting: Meeting | null;
  pending: boolean;
  error: string | null;
  seconds: number;
}) {
  const { clear, start } = useActiveCall();
  return (
    <div className="mx-auto max-w-2xl">
      <div className="card p-6">
        <div className="flex items-center gap-4">
          <Avatar agent={agent} size={56} />
          <div className="flex-1">
            <div className="text-xs font-medium tracking-wide text-muted uppercase">1:1 with</div>
            <h1 className="text-xl font-semibold">{agent.name}</h1>
            <div className="text-sm text-muted">{Math.max(1, Math.round(seconds / 60))} min call</div>
          </div>
          <Phone size={20} className="text-muted" />
        </div>
        {pending ? (
          <div className="mt-6 flex items-center gap-2 text-sm text-muted"><Spinner size={14} /> Writing meeting notes…</div>
        ) : (
          <>
            {error && <div className="mt-4 text-sm text-danger">{error}</div>}
            {meeting?.summary && (
              <div className="mt-6">
                <h2 className="mb-1.5 text-sm font-semibold">Summary</h2>
                <p className="text-sm text-muted">{meeting.summary}</p>
              </div>
            )}
            {meeting && meeting.action_items.length > 0 && (
              <div className="mt-5">
                <h2 className="mb-2 text-sm font-semibold">Action items for {agent.name.split(" ")[0]}</h2>
                <ul className="space-y-1.5">
                  {meeting.action_items.map((a) => (
                    <li key={a} className="flex items-start gap-2 text-sm"><CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" />{a}</li>
                  ))}
                </ul>
                <p className="mt-3 text-xs text-subtle">{agent.name.split(" ")[0]} has been asked to follow up on these and email you a recap.</p>
              </div>
            )}
            {meeting && !meeting.summary && !meeting.transcript.some((t) => t.speaker === "manager") && (
              <p className="mt-6 text-sm text-muted">You hung up before saying anything, so there are no notes.</p>
            )}
          </>
        )}
        <div className="mt-6 flex gap-2">
          <Link to={`/team/${agent.id}`} className="btn-secondary">Back to profile</Link>
          <button className="btn-ghost" disabled={pending} onClick={() => { clear(); start(agent.id); }}><Phone size={15} /> Call again</button>
        </div>
      </div>
    </div>
  );
}
