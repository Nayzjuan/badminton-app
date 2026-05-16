// ============================================================
// Web Audio API — Pocket Ping Sound Synthesizer
// ============================================================
// Generates notification tones in pure JavaScript — no MP3s,
// no network requests.
//
// Two tones:
//   playWarningBeep()  — triple chime (on-deck warning)
//   playCourtCall()    — punchy ascending arpeggio (court call)
//
// ANDROID CHROME NOTE:
//   AudioContext starts in "suspended" state and MUST be resumed
//   inside (or after) a user-gesture handler.  Both play functions
//   are async and explicitly await ctx.resume() before scheduling
//   any oscillators — this is the only reliable way to get audio
//   on Android Chrome.
// ============================================================

/** Singleton AudioContext — created once, reused across calls. */
let _ctx: AudioContext | null = null;

/**
 * Returns the AudioContext, creating it if needed.
 * Does NOT attempt to resume — callers must await resume themselves.
 */
function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!_ctx || _ctx.state === "closed") {
    _ctx = new (
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    )();
  }
  return _ctx;
}

/**
 * Attempt to resume a suspended AudioContext.
 * Returns true if the context is running after the attempt.
 *
 * On Android Chrome the context starts suspended and ctx.resume() MUST
 * be awaited before scheduling any oscillators — fire-and-forget is not
 * sufficient. Returns false if resume threw (no prior user gesture) or
 * if the context is still not running after the attempt.
 */
async function ensureAudioContextRunning(ctx: AudioContext): Promise<boolean> {
  try {
    // Calling resume() on an already-running context is a spec-defined no-op
    // (returns a resolved Promise). We always call it so TypeScript's
    // control-flow narrowing never concludes ctx.state ≠ "running" below.
    await ctx.resume();
  } catch {
    return false;
  }
  return ctx.state === "running";
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
  gainPeak = 0.7,
  type: OscillatorType = "sine"
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.type = type;
  osc.frequency.setValueAtTime(frequency, startTime);

  // Smooth attack / release to avoid harsh pops
  const attackTime = 0.015;
  const releaseTime = 0.06;
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(gainPeak, startTime + attackTime);
  gain.gain.setValueAtTime(gainPeak, startTime + duration - releaseTime);
  gain.gain.linearRampToValueAtTime(0, startTime + duration);

  osc.start(startTime);
  osc.stop(startTime + duration);
}

// ── playWarningBeep ──────────────────────────────────────────
/**
 * Triple chime — loud, clear, attention-grabbing.
 * Cue: "Your match is forming — head to the courts!"
 *
 * Pattern: ding (C5) → ding (E5) → ding (G5)  [3× ascending major triad]
 */
export async function playWarningBeep(): Promise<void> {
  const ctx = getAudioContext();
  if (!ctx || !(await ensureAudioContextRunning(ctx))) return;

  const now = ctx.currentTime;
  const noteLen = 0.3;
  const gap = 0.08;

  playTone(ctx, 523.25, now, noteLen, 0.75, "sine"); // C5
  playTone(ctx, 659.25, now + noteLen + gap, noteLen, 0.75, "sine"); // E5
  playTone(ctx, 783.99, now + (noteLen + gap) * 2, noteLen, 0.8, "sine"); // G5

  // Tactile: vibrate on mobile regardless of audio state
  if (typeof navigator !== "undefined" && navigator.vibrate) {
    navigator.vibrate([180, 80, 180, 80, 300]);
  }
}

// ── playCourtCall ────────────────────────────────────────────
/**
 * Punchy four-note arpeggio with a final held high note.
 * Cue: "Your court is ready — GO NOW!"
 *
 * Pattern: C5 → E5 → G5 → C6 (held, loud)
 * Repeated twice for maximum urgency.
 */
export async function playCourtCall(): Promise<void> {
  const ctx = getAudioContext();
  if (!ctx || !(await ensureAudioContextRunning(ctx))) return;

  const now = ctx.currentTime;
  const step = 0.1; // 100 ms between notes — snappy

  // First pass
  playTone(ctx, 523.25, now, 0.1, 0.7, "square"); // C5
  playTone(ctx, 659.25, now + step, 0.1, 0.75, "square"); // E5
  playTone(ctx, 783.99, now + step * 2, 0.1, 0.8, "square"); // G5
  playTone(ctx, 1046.5, now + step * 3, 0.4, 0.85, "square"); // C6 held

  // Short gap then repeat for urgency
  const pass2 = step * 3 + 0.5;
  playTone(ctx, 523.25, now + pass2, 0.1, 0.7, "square"); // C5
  playTone(ctx, 659.25, now + pass2 + step, 0.1, 0.75, "square"); // E5
  playTone(ctx, 783.99, now + pass2 + step * 2, 0.1, 0.8, "square"); // G5
  playTone(ctx, 1046.5, now + pass2 + step * 3, 0.55, 0.9, "square"); // C6 held longer

  // Tactile: aggressive double-pulse for court call
  if (typeof navigator !== "undefined" && navigator.vibrate) {
    navigator.vibrate([400, 150, 400, 150, 600]);
  }
}

// ── Unlock audio on first user gesture ──────────────────────
/**
 * Call this on any user interaction (click, touch) to ensure the
 * AudioContext is in a "running" state before the first notification
 * fires.  Must be called inside a user-gesture event handler.
 */
export function unlockAudio(): void {
  const ctx = getAudioContext();
  if (ctx && ctx.state === "suspended") {
    ctx.resume().catch(() => {
      // Ignore — if resume fails here, playWarningBeep/playCourtCall
      // will attempt it again at fire time.
    });
  }
}
