/** Browser speech helpers for 1:1 calls: speech recognition in, speech synthesis out. */

// ---- speech recognition (Chrome/Edge/Safari expose it, Firefox doesn't) -----------------
interface RecognitionResult { isFinal: boolean; 0: { transcript: string } }
interface RecognitionEvent { resultIndex: number; results: ArrayLike<RecognitionResult> }
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const speechRecognitionSupported = () => recognitionCtor() !== null;
export const speechSynthesisSupported = () => typeof window !== "undefined" && "speechSynthesis" in window;

export interface Listener {
  start(): void;
  stop(): void;
}

/**
 * Listens for one utterance at a time. `onInterim` shows live captions; `onFinal` fires once the
 * speaker pauses. Silence timeouts restart listening automatically while `active` is true.
 */
export function createListener(opts: {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (message: string) => void;
}): Listener | null {
  const Ctor = recognitionCtor();
  if (!Ctor) return null;
  let active = false;
  let rec: Recognition | null = null;

  const spawn = () => {
    rec = new Ctor();
    rec.lang = navigator.language || "en-US";
    rec.continuous = false;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const text = r[0].transcript.trim();
          if (text) {
            active = false;
            opts.onInterim("");
            opts.onFinal(text);
          }
          return;
        }
        interim += r[0].transcript;
      }
      opts.onInterim(interim);
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        active = false;
        opts.onError("Microphone access was blocked. Allow it in the browser's address bar, or type instead.");
      } else if (e.error === "network") {
        active = false;
        opts.onError("Speech recognition needs an internet connection in this browser. You can type instead.");
      }
      // "no-speech" / "aborted" just end this round; onend restarts if still active.
    };
    rec.onend = () => {
      if (active) setTimeout(() => active && spawn(), 150);
    };
    try {
      rec.start();
    } catch {
      /* already started */
    }
  };

  return {
    start() {
      if (active) return;
      active = true;
      spawn();
    },
    stop() {
      active = false;
      opts.onInterim("");
      try {
        rec?.abort();
      } catch {
        /* ignore */
      }
    },
  };
}

// ---- speech synthesis --------------------------------------------------------------------
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!speechSynthesisSupported()) return Promise.resolve([]);
  const now = speechSynthesis.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener("voiceschanged", done, { once: true });
    setTimeout(done, 1500);
  });
}

export type VoiceKind = "feminine" | "masculine";

// Browsers don't expose a voice's gender, but most voice names reveal it.
const FEMININE = /\b(female|woman|zira|samantha|victoria|karen|moira|tessa|fiona|susan|hazel|aria|jenny|sonia|libby|emma|ava|allison|serena|kate|joanna|salli|kimberly|ivy|natasha|clara|michelle|elsa|zoe|catherine|heera|veena|amelie|anna|paulina|monica|sara|helena|alice|ellen|laura|nora|heather|kendra|olivia|isabella|amy|nicole|jessa|ana|luciana|joana|mei-jia|sin-ji|ting-ting|yuna|kyoko|milena|mariska|ioana|zuzana|yelda|carmit|lekha|damayanti|sora|f\d)\b/i;
const MASCULINE = /\b(male|man|david|mark|daniel|alex|fred|tom|george|ryan|guy|christopher|eric|brian|matthew|thomas|oliver|arthur|james|liam|roger|ravi|rishi|aaron|gordon|lee|jorge|diego|juan|luca|xander|yuri|maged|otoya|reed|rocko|grandpa|ralph|bruce|junior|albert|m\d)\b/i;

export function classifyVoice(v: SpeechSynthesisVoice): VoiceKind | null {
  const name = v.name.replace(/[()+_-]/g, " ");
  // "Female"/"Male" wording wins over first names (e.g. "Google UK English Male").
  if (/(^|[^a-z])female/i.test(name)) return "feminine"; // also "+female2" (Linux espeak variants)
  if (/(^|[^a-z])male/i.test(name)) return "masculine";
  if (FEMININE.test(name)) return "feminine";
  if (MASCULINE.test(name)) return "masculine";
  // Chrome's default "Google US English" voice is feminine.
  if (/^google (us|español|français|deutsch|italiano)/i.test(v.name)) return "feminine";
  return null;
}

export interface VoiceSettings {
  handle: string;
  voice_type?: "feminine" | "masculine" | "any";
  voice_name?: string | null;
}

export interface VoiceProfile {
  /** Kokoro voice id (natural, server-side) — preferred when set. */
  natural: string | null;
  /** Browser voice: used when natural voices are unavailable, or as a per-sentence fallback. */
  voice: SpeechSynthesisVoice | null;
  pitch: number;
  rate: number;
  /** Overall speaking speed multiplier (1.0 = normal). */
  speed: number;
}

// ---- natural (Kokoro) voices ------------------------------------------------------------
export interface NaturalVoice {
  id: string;
  label: string;
  kind: VoiceKind;
  lang: string;
  language: string;
  preferred: number | null;
}

export const NATURAL_PREFIX = "kokoro:";
let naturalVoices: Promise<NaturalVoice[]> | null = null;

/** Natural voices from the studio's TTS service (empty if it isn't running). Cached per page load. */
export function loadNaturalVoices(): Promise<NaturalVoice[]> {
  naturalVoices ??= fetch("/api/tts/voices", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : { available: false, voices: [] }))
    .then((d: { available: boolean; voices: NaturalVoice[] }) => (d.available ? d.voices : []))
    .catch(() => []);
  return naturalVoices;
}

/** Natural voices in the user's language (English as a fallback), optionally of one kind. */
export function naturalOfKind(all: NaturalVoice[], kind: "feminine" | "masculine" | "any"): NaturalVoice[] {
  const lang = (navigator.language || "en-US").slice(0, 2).toLowerCase();
  let pool = all.filter((v) => v.lang.toLowerCase().startsWith(lang));
  if (!pool.length) pool = all.filter((v) => v.lang.startsWith("en"));
  return kind === "any" ? pool : pool.filter((v) => v.kind === kind);
}

/** Voices in the user's language, optionally of one kind (falls back to all if none match). */
export function voicesOfKind(voices: SpeechSynthesisVoice[], kind: "feminine" | "masculine" | "any"): SpeechSynthesisVoice[] {
  const lang = (navigator.language || "en-US").slice(0, 2).toLowerCase();
  const local = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
  const pool = local.length ? local : voices;
  if (kind === "any") return pool;
  return pool.filter((v) => classifyVoice(v) === kind);
}

/**
 * An agent's voice. Order: their pinned voice (natural or browser) if available here; otherwise a
 * stable pick among the best natural voices of their type; otherwise a browser voice of their type
 * (with pitch nudged toward the type if this browser has none).
 */
export function voiceFor(agent: VoiceSettings, voices: SpeechSynthesisVoice[], natural: NaturalVoice[] = [], speed = 1): VoiceProfile {
  const kind = agent.voice_type ?? "any";
  const h = hash(agent.handle);
  const pinnedNatural = agent.voice_name?.startsWith(NATURAL_PREFIX)
    ? natural.find((v) => v.id === agent.voice_name!.slice(NATURAL_PREFIX.length)) : undefined;
  const pinnedBrowser = agent.voice_name && !agent.voice_name.startsWith(NATURAL_PREFIX)
    ? voices.find((v) => v.name === agent.voice_name) : undefined;

  let naturalId: string | null = pinnedNatural?.id ?? null;
  if (!naturalId && !pinnedBrowser && natural.length) {
    const ofKind = naturalOfKind(natural, kind);
    const best = ofKind.filter((v) => v.preferred !== null);
    const pool = best.length ? best : ofKind;
    naturalId = pool.length ? pool[h % pool.length].id : null;
  }

  const matching = voicesOfKind(voices, kind);
  const pool = matching.length ? matching : voicesOfKind(voices, "any");
  const voice = pinnedBrowser ?? (pool.length ? pool[h % pool.length] : null);
  const fallbackShift = !pinnedBrowser && kind !== "any" && !matching.length ? (kind === "feminine" ? 0.25 : -0.25) : 0;
  return {
    natural: naturalId,
    voice,
    // Browser voices get a subtle per-agent variation; natural voices are used as recorded.
    pitch: Math.min(2, Math.max(0.1, 0.92 + ((h >> 8) % 16) / 100 + fallbackShift)),
    rate: 0.98 + ((h >> 16) % 14) / 100,
    speed,
  };
}

function browserUtterance(text: string, profile: VoiceProfile): SpeechSynthesisUtterance {
  const u = new SpeechSynthesisUtterance(text);
  if (profile.voice) u.voice = profile.voice;
  u.pitch = profile.pitch;
  u.rate = Math.min(2, profile.rate * profile.speed);
  return u;
}

async function fetchNatural(text: string, voice: string, speed: number, signal?: AbortSignal): Promise<string> {
  const r = await fetch("/api/tts/speech", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice, speed }),
    signal,
  });
  if (!r.ok) throw new Error(`TTS ${r.status}`);
  return URL.createObjectURL(await r.blob());
}

function playUrl(url: string, onPlaying: () => void, register: (a: HTMLAudioElement) => void): Promise<void> {
  return new Promise((resolve) => {
    const audio = new Audio(url);
    register(audio);
    audio.onplaying = onPlaying;
    audio.onended = () => resolve();
    audio.onerror = () => resolve();
    audio.onpause = () => audio.ended || resolve();
    audio.play().catch(() => resolve());
  });
}

let previewAudio: HTMLAudioElement | null = null;

/** Say a short line with a given voice profile (used by the voice picker's preview). */
export async function preview(text: string, profile: VoiceProfile) {
  previewAudio?.pause();
  if (speechSynthesisSupported()) speechSynthesis.cancel();
  if (profile.natural) {
    try {
      const url = await fetchNatural(text, profile.natural, profile.speed);
      await playUrl(url, () => undefined, (a) => (previewAudio = a));
      URL.revokeObjectURL(url);
      return;
    } catch {
      /* fall back to the browser voice */
    }
  }
  if (speechSynthesisSupported()) speechSynthesis.speak(browserUtterance(text, profile));
}

/**
 * Turns streamed text into speech as soon as each sentence is complete. With a natural voice, each
 * sentence is synthesized as soon as it's complete (in parallel) and played back in order.
 */
export class Speaker {
  private buffer = "";
  private pending = 0;
  private closed = false;
  private cancelled = false;
  private started = false;
  private chain: Promise<void> = Promise.resolve();
  private abort = new AbortController();
  private audio: HTMLAudioElement | null = null;
  private urls: string[] = [];

  constructor(
    private profile: VoiceProfile,
    private hooks: { onStart?: () => void; onIdle?: () => void } = {},
  ) {}

  push(text: string) {
    if (this.cancelled) return;
    this.buffer += text;
    const re = /^([\s\S]*?[.!?…:;](?:["')\]]*)?)(\s+)/;
    let m: RegExpMatchArray | null;
    while ((m = this.buffer.match(re))) {
      this.say(m[1]);
      this.buffer = this.buffer.slice(m[0].length);
    }
    // Long first clause with natural voices: start speaking at a comma rather than waiting.
    if (this.profile.natural && !this.started && this.pending === 0 && this.buffer.length > 90) {
      const cut = this.buffer.lastIndexOf(", ", 120);
      if (cut > 30) {
        this.say(this.buffer.slice(0, cut + 1));
        this.buffer = this.buffer.slice(cut + 2);
      }
    }
  }

  /** The reply is complete: speak whatever is left. */
  end() {
    if (this.cancelled) return;
    this.say(this.buffer);
    this.buffer = "";
    this.closed = true;
    if (this.pending === 0) this.hooks.onIdle?.();
  }

  cancel() {
    this.cancelled = true;
    this.buffer = "";
    this.abort.abort();
    this.audio?.pause();
    this.urls.forEach((u) => URL.revokeObjectURL(u));
    this.urls = [];
    if (speechSynthesisSupported()) speechSynthesis.cancel();
  }

  private begin() {
    if (!this.started) {
      this.started = true;
      this.hooks.onStart?.();
    }
  }

  private finish = () => {
    this.pending = Math.max(0, this.pending - 1);
    if (this.pending === 0 && this.closed && !this.cancelled) this.hooks.onIdle?.();
  };

  private say(raw: string) {
    const text = raw.replace(/[*_`#>~]/g, "").replace(/\s+/g, " ").trim();
    if (!text || !/[\p{L}\p{N}]/u.test(text)) return;
    this.pending++;
    const natural = this.profile.natural;
    // Kick off synthesis immediately so it overlaps with playback of earlier sentences.
    const audioUrl = natural ? fetchNatural(text, natural, this.profile.speed, this.abort.signal).catch(() => null) : null;
    this.chain = this.chain.then(async () => {
      if (this.cancelled) return this.finish();
      const url = audioUrl ? await audioUrl : null;
      if (this.cancelled) {
        if (url) URL.revokeObjectURL(url);
        return this.finish();
      }
      if (url) {
        this.urls.push(url);
        await playUrl(url, () => this.begin(), (a) => (this.audio = a));
        URL.revokeObjectURL(url);
      } else if (speechSynthesisSupported()) {
        await new Promise<void>((resolve) => {
          const u = browserUtterance(text, this.profile);
          u.onstart = () => this.begin();
          u.onend = () => resolve();
          u.onerror = () => resolve();
          speechSynthesis.speak(u);
        });
      }
      this.finish();
    });
  }
}
