import { Check, Dices, GripVertical, Plus, Trash2, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useSettings } from "../api/queries";
import type { ModelInfo, TraitInfo, VoiceType } from "../api/types";
import {
  classifyVoice,
  loadNaturalVoices,
  loadVoices,
  NATURAL_PREFIX,
  naturalOfKind,
  preview,
  speechSynthesisSupported,
  voiceFor,
  voicesOfKind,
  type NaturalVoice,
} from "../lib/voice";
import { DicebearImg } from "./Avatar";
import { cn, randomSeed, titleCase } from "../lib/format";

export function ResponsibilitiesEditor({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    onChange([...value, v]);
    setDraft("");
  };
  return (
    <div className="space-y-1.5">
      {value.map((r, i) => (
        <div key={i} className="group flex items-center gap-2">
          <GripVertical size={14} className="shrink-0 text-subtle" />
          <input
            className="input py-1.5"
            value={r}
            onChange={(e) => onChange(value.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <button type="button" className="btn-ghost p-1.5" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label="Remove">
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Plus size={14} className="shrink-0 text-subtle" />
        <input
          className="input py-1.5"
          placeholder="Add a responsibility and press Enter…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="btn-secondary btn-sm" onClick={add} disabled={!draft.trim()}>
          Add
        </button>
      </div>
    </div>
  );
}

export function TraitPicker({ traits, value, onChange, max = 3 }: {
  traits: TraitInfo[];
  value: string[];
  onChange: (v: string[]) => void;
  max?: number;
}) {
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {traits.map((t) => {
          const on = value.includes(t.key);
          const disabled = !on && value.length >= max;
          return (
            <button
              key={t.key}
              type="button"
              title={t.description}
              disabled={disabled}
              onClick={() => onChange(on ? value.filter((x) => x !== t.key) : [...value, t.key])}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition disabled:opacity-40",
                on ? "border-accent bg-accent-soft text-fg" : "border-border bg-surface-2 text-muted hover:text-fg",
              )}
            >
              {on && <Check size={13} className="text-accent" />}
              {titleCase(t.key)}
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 text-xs text-subtle">Pick up to {max}. Traits shape personality and working style.</div>
    </div>
  );
}

const TIER_STYLE: Record<string, string> = {
  Senior: "from-amber-400 to-orange-500",
  "Mid-level": "from-sky-400 to-indigo-500",
  Junior: "from-emerald-400 to-teal-500",
};

export function tierFor(models: ModelInfo[] | undefined, modelId: string): string {
  return models?.find((m) => m.id === modelId)?.tier ?? modelId;
}

export function ModelPicker({ models, value, onChange }: { models: ModelInfo[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {models.map((m) => {
        const on = m.id === value;
        return (
          <button
            key={m.id}
            type="button"
            onClick={() => onChange(m.id)}
            className={cn(
              "relative rounded-xl border p-3 text-left transition",
              on ? "border-accent bg-accent-soft ring-2 ring-accent-soft" : "border-border bg-surface-2 hover:border-border-strong",
            )}
          >
            <span className={cn("inline-block rounded-md bg-gradient-to-r px-2 py-0.5 text-xs font-bold text-white", TIER_STYLE[m.tier] ?? "from-slate-400 to-slate-500")}>
              {m.tier}
            </span>
            <div className="mt-2 text-sm font-medium">{m.name}</div>
            <div className="text-xs text-subtle">{m.id}</div>
            {on && <Check size={16} className="absolute top-3 right-3 text-accent" />}
          </button>
        );
      })}
    </div>
  );
}

export function EffortPicker({ efforts, value, onChange }: { efforts: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="inline-flex flex-wrap rounded-lg border border-border bg-surface-2 p-0.5">
      {efforts.map((e) => (
        <button
          key={e}
          type="button"
          onClick={() => onChange(e)}
          className={cn(
            "rounded-md px-3 py-1.5 text-xs font-medium transition",
            e === value ? "bg-accent text-accent-fg" : "text-muted hover:text-fg",
          )}
        >
          {titleCase(e)}
        </button>
      ))}
    </div>
  );
}

export function AvatarPicker({ styles, style, seed, onChange }: {
  styles: string[];
  style: string;
  seed: string;
  onChange: (style: string, seed: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
      <div className="flex flex-col items-center gap-2">
        <DicebearImg styleName={style} seed={seed} alt="Avatar preview" className="h-28 w-28 rounded-2xl border border-border bg-surface-3" />
        <button type="button" className="btn-secondary btn-sm" onClick={() => onChange(style, randomSeed())}>
          <Dices size={14} /> Reroll
        </button>
      </div>
      <div className="grid flex-1 grid-cols-4 gap-2">
        {styles.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onChange(s, seed)}
            title={titleCase(s)}
            className={cn(
              "flex flex-col items-center gap-1 rounded-xl border p-2 transition",
              s === style ? "border-accent bg-accent-soft" : "border-border bg-surface-2 hover:border-border-strong",
            )}
          >
            <DicebearImg styleName={s} seed={seed} className="h-11 w-11 rounded-lg" />
            <span className="truncate text-[11px] text-muted">{titleCase(s)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const VOICE_TYPES: { id: VoiceType; label: string }[] = [
  { id: "feminine", label: "Feminine" },
  { id: "masculine", label: "Masculine" },
  { id: "any", label: "Any" },
];

/** Voice for 1:1 calls: a voice type, optionally pinned to a natural (Kokoro) or browser voice. */
export function VoicePicker({ handle, name, type, voiceName, onChange }: {
  handle: string;
  name: string;
  type: VoiceType;
  voiceName: string | null;
  onChange: (type: VoiceType, voiceName: string | null) => void;
}) {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [natural, setNatural] = useState<NaturalVoice[]>([]);
  const [playing, setPlaying] = useState(false);
  const settings = useSettings();
  useEffect(() => {
    void loadVoices().then(setVoices);
    void loadNaturalVoices().then(setNatural);
  }, []);
  const naturalOptions = naturalOfKind(natural, type);
  const browserOptions = voicesOfKind(voices, type);
  const known = (v: string) => v.startsWith(NATURAL_PREFIX)
    ? natural.some((n) => NATURAL_PREFIX + n.id === v) : voices.some((b) => b.name === v);
  const pinnedMissing = !!voiceName && (voices.length > 0 || natural.length > 0) && !known(voiceName);
  const fits = (v: string, t: VoiceType) => {
    if (t === "any") return true;
    if (v.startsWith(NATURAL_PREFIX)) return natural.find((n) => NATURAL_PREFIX + n.id === v)?.kind === t;
    const b = voices.find((x) => x.name === v);
    return !!b && classifyVoice(b) === t;
  };
  const first = name.trim().split(/\s+/)[0] || "your new teammate";
  const listen = async () => {
    setPlaying(true);
    try {
      await preview(`Hi, I'm ${first}. Really looking forward to working with you!`,
        voiceFor({ handle: handle || name || "agent", voice_type: type, voice_name: voiceName }, voices, natural, settings.data?.voice_speed ?? 1.15));
    } finally {
      setPlaying(false);
    }
  };
  if (!speechSynthesisSupported() && !natural.length) {
    return <p className="text-xs text-subtle">No voices available in this browser.</p>;
  }
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-border bg-surface-2 p-0.5">
          {VOICE_TYPES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onChange(t.id, voiceName && fits(voiceName, t.id) ? voiceName : null)}
              className={cn("rounded-md px-3 py-1 text-sm transition", type === t.id ? "bg-surface-3 font-medium text-fg shadow-sm" : "text-muted hover:text-fg")}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button type="button" className="btn-ghost btn-sm" onClick={() => void listen()} disabled={playing}>
          <Volume2 size={14} /> {playing ? "Playing…" : "Preview"}
        </button>
        {natural.length > 0 && <span className="chip">Natural voices on</span>}
      </div>
      <select className="input" value={voiceName ?? ""} onChange={(e) => onChange(type, e.target.value || null)}>
        <option value="">
          Automatic ({natural.length ? "natural " : ""}{type === "any" ? "voice" : `${type} voice`})
        </option>
        {naturalOptions.length > 0 && (
          <optgroup label="Natural voices (Kokoro)">
            {naturalOptions.map((v) => (
              <option key={v.id} value={NATURAL_PREFIX + v.id}>
                {v.label} · {v.language}{v.preferred !== null ? " ★" : ""}
              </option>
            ))}
          </optgroup>
        )}
        {browserOptions.length > 0 && (
          <optgroup label="Browser voices">
            {browserOptions.map((v) => (
              <option key={v.name} value={v.name}>{v.name}{v.lang ? ` · ${v.lang}` : ""}</option>
            ))}
          </optgroup>
        )}
        {pinnedMissing && <option value={voiceName!}>{voiceName} (not available here)</option>}
      </select>
    </div>
  );
}
