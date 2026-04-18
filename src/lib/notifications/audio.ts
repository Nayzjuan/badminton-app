// ============================================================
// Web Audio API — Pocket Ping Sound Synthesizer
// ============================================================
// Generates notification tones in pure JavaScript — no MP3s,
// no network requests, no autoplay-policy issues triggered by
// background loads.  All functions are idempotent: calling them
// multiple times (e.g. from rapid real-time updates) is safe
// because each invocation creates a fresh AudioContext that is
// closed automatically after playback.
//
// Two tones:
//   playWarningBeep()  — gentle double-chime (on-deck warning)
//   playCourtCall()    — energetic ascending arpeggio (court call)
// ============================================================

/** Singleton AudioContext — created once, reused across calls. */
let _ctx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!_ctx || _ctx.state === "closed") {
    _ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  }
  // Resume if suspended (browser autoplay policy)
  if (_ctx.state === "suspended") {
    _ctx.resume();
  }
  return _ctx;
}

/**
 * Create an oscillator that plays for `duration` seconds at `frequency` Hz.
 * An envelope (attack + release) prevents clicks.
 */
function playTone(
  ctx: AudioContext,
  frequency: number,
  startTime: number,
  duration: number,
  gainPeak = 0.35,
  type: OscillatorType = "sine"
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.type = type;
  osc.frequency.setValueAtTime(frequency, startTime);

  // Smooth attack / release to avoid harsh pops
  const attackTime = 0.02;
  const releaseTime = 0.08;
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(gainPeak, startTime + attackTime);
  gain.gain.setValueAtTime(gainPeak, startTime + duration - releaseTime);
  gain.gain.linearRampToValueAtTime(0, startTime + duration);

  osc.start(startTime);
  osc.stop(startTime + duration);
}

// ── playWarningBeep ──────────────────────────────────────────
/**
 * Gentle double-chime: soft sine bell struck twice.
 * Cue: "Your match is forming — get ready."
 *
 * Pattern: ding (C5) → short gap → ding (E5)
 */
export function playWarningBeep(): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime;
  const noteLen = 0.35;
  const gap = 0.12;

  playTone(ctx, 523.25, now, noteLen, 0.28, "sine");           // C5
  playTone(ctx, 659.25, now + noteLen + gap, noteLen, 0.28, "sine"); // E5
}

// ── playCourtCall ────────────────────────────────────────────
/**
 * Energetic ascending arpeggio: three quick notes climbing the
 * major triad, ending on a held high tone.
 * Cue: "Your court is ready — go NOW!"
 *
 * Pattern: C5 → E5 → G5 → C6 (held)
 */
export function playCourtCall(): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime;
  const step = 0.13;  // Each note 130 ms apart for a snappy arpeggio

  playTone(ctx, 523.25, now,              0.12, 0.30, "triangle"); // C5
  playTone(ctx, 659.25, now + step,       0.12, 0.32, "triangle"); // E5
  playTone(ctx, 783.99, now + step * 2,   0.12, 0.35, "triangle"); // G5
  playTone(ctx, 1046.5, now + step * 3,   0.45, 0.38, "triangle"); // C6 (held)
}

// ── Unlock audio on first user gesture ──────────────────────
/**
 * Call this on any user interaction (click, touch) to ensure the
 * AudioContext is in a "running" state before the first notification
 * fires.  Safe to call multiple times.
 */
export function unlockAudio(): void {
  const ctx = getAudioContext();
  if (ctx && ctx.state === "suspended") {
    ctx.resume();
  }
}
