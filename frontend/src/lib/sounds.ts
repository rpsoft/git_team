/** Call sounds, synthesized with Web Audio so there are no audio assets to ship. */

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined" || !("AudioContext" in window)) return null;
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/** Schedule a soft-edged tone made of one or more sine frequencies. */
function tone(ac: AudioContext, freqs: number[], start: number, duration: number, volume = 0.08) {
  const gain = ac.createGain();
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(volume, start + 0.02);
  gain.gain.setValueAtTime(volume, start + duration - 0.03);
  gain.gain.linearRampToValueAtTime(0, start + duration);
  gain.connect(ac.destination);
  for (const f of freqs) {
    const osc = ac.createOscillator();
    osc.frequency.value = f;
    osc.connect(gain);
    osc.start(start);
    osc.stop(start + duration);
  }
}

/** Ringback tone (two short rings every 3 s) until the returned stop function is called. */
export function startRinging(): () => void {
  const ac = audio();
  if (!ac) return () => undefined;
  const ring = () => {
    const t = ac.currentTime + 0.05;
    tone(ac, [440, 480], t, 0.4);
    tone(ac, [440, 480], t + 0.6, 0.4);
  };
  ring();
  const timer = setInterval(ring, 3000);
  return () => clearInterval(timer);
}

/** Three falling beeps. */
export function playHangUp() {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime + 0.05;
  [660, 520, 400].forEach((f, i) => tone(ac, [f], t + i * 0.18, 0.14, 0.1));
}
