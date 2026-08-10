// sound.ts — the notification chime.
//
// Synthesised with the Web Audio API rather than shipped as an audio file: no
// asset to load, no CDN request (the published-artifact CSP and our own bundle
// both stay clean), and it works offline. Two short descending tones — recognisable
// without being alarming, which matters for something that fires all day.
//
// Browsers block audio until the user has interacted with the page, so the first
// unlock is wired to the first click/keypress. Preference is remembered per device.

const PREF_KEY = "vocera-sound";

let ctx: AudioContext | null = null;
let unlocked = false;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (ctx) return ctx;
  const Ctor = window.AudioContext || (window as any).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

/** Browsers require a user gesture before audio can play. Call once at app start. */
export function primeSound() {
  if (typeof window === "undefined" || unlocked) return;
  const unlock = () => {
    const c = audioContext();
    if (c?.state === "suspended") c.resume().catch(() => {});
    unlocked = true;
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock, { once: true });
  window.addEventListener("keydown", unlock, { once: true });
}

export function soundEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(PREF_KEY) !== "off";
  } catch {
    return true; // private mode — default to on
  }
}

export function setSoundEnabled(on: boolean) {
  try {
    localStorage.setItem(PREF_KEY, on ? "on" : "off");
  } catch {
    /* private mode — preference just won't persist */
  }
}

function tone(c: AudioContext, freq: number, startAt: number, duration: number, peak: number) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;

  // Ramped envelope — a raw start/stop on a gain node produces an audible click.
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
}

/** Play the chime. No-ops when muted, unsupported, or not yet unlocked. */
export function playNotificationSound() {
  if (!soundEnabled()) return;
  const c = audioContext();
  if (!c) return;
  if (c.state === "suspended") {
    // Not unlocked yet — try, but never block or throw.
    c.resume().catch(() => {});
    if (c.state === "suspended") return;
  }
  try {
    const now = c.currentTime;
    tone(c, 880, now, 0.11, 0.16); // A5
    tone(c, 660, now + 0.1, 0.16, 0.13); // E5
  } catch {
    /* audio is a nicety — never let it break the UI */
  }
}
