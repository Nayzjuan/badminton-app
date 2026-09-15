// ============================================================
// Privacy-safe registration funnel helpers
// ============================================================
// Client-safe (imported from LoginForm / JoinFinalizer / Analytics).
// Never send names, PINs, emails, IDs, slugs, skill values, raw errors,
// raw URLs, or high-cardinality attempt IDs.

export const REGISTRATION_EVENT = "registration";

export const REGISTRATION_STEPS = [
  "viewed",
  "started",
  "validation_error",
  "identity_ready",
  "membership_transition",
  "queue_transition",
  "completed",
] as const;

export type RegistrationStep = (typeof REGISTRATION_STEPS)[number];
export type RegistrationEntry = "direct" | "qr_session" | "qr_club";
export type RegistrationMethod = "anonymous" | "pin" | "google";
export type RegistrationOutcome =
  | "profile_only"
  | "club_joined"
  | "queue_joined"
  | "already_joined";
export type RegistrationField = "name" | "pin" | "skill" | "form";

export type RegistrationProps = {
  step: RegistrationStep;
  entry?: RegistrationEntry;
  method?: RegistrationMethod;
  outcome?: RegistrationOutcome;
  field?: RegistrationField;
};

const STEPS = new Set<string>(REGISTRATION_STEPS);
const ENTRIES = new Set(["direct", "qr_session", "qr_club"]);
const METHODS = new Set(["anonymous", "pin", "google"]);
const OUTCOMES = new Set(["profile_only", "club_joined", "queue_joined", "already_joined"]);
const FIELDS = new Set(["name", "pin", "skill", "form"]);

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Strip query/fragment and template every dynamic path segment. */
export function canonicalizeAnalyticsPath(raw: string): string {
  let pathname = raw;
  try {
    const u =
      raw.startsWith("http://") || raw.startsWith("https://")
        ? new URL(raw)
        : new URL(raw, "https://analytics.invalid");
    pathname = u.pathname;
  } catch {
    pathname = raw.split("?")[0]?.split("#")[0] ?? "";
  }
  return (
    pathname
      .replace(UUID_RE, "[id]")
      .replace(/^\/c\/[^/]+/, "/c/[clubSlug]")
      .replace(/\/play\/join.*/, "/play/join")
      .replace(/\/+$/, "") || "/"
  );
}

export function sanitizeRegistrationProps(input: unknown): RegistrationProps | null {
  if (!input || typeof input !== "object") return null;
  const rec = input as Record<string, unknown>;
  if (typeof rec.step !== "string" || !STEPS.has(rec.step)) return null;
  const out: RegistrationProps = { step: rec.step as RegistrationStep };
  if (typeof rec.entry === "string" && ENTRIES.has(rec.entry)) {
    out.entry = rec.entry as RegistrationEntry;
  }
  if (typeof rec.method === "string" && METHODS.has(rec.method)) {
    out.method = rec.method as RegistrationMethod;
  }
  if (typeof rec.outcome === "string" && OUTCOMES.has(rec.outcome)) {
    out.outcome = rec.outcome as RegistrationOutcome;
  }
  if (typeof rec.field === "string" && FIELDS.has(rec.field)) {
    out.field = rec.field as RegistrationField;
  }
  return out;
}

function storageKey(step: RegistrationStep, extra: string): string {
  return `reg:${step}:${extra}`;
}

function alreadyEmitted(key: string): boolean {
  try {
    return sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function markEmitted(key: string): void {
  try {
    sessionStorage.setItem(key, "1");
  } catch {
    // private mode / disabled storage — skip dedupe, still try to emit
  }
}

export function isRegistrationAnalyticsEnabled(): boolean {
  return process.env["NEXT_PUBLIC_VERCEL_ANALYTICS"] === "true";
}

import { track } from "@vercel/analytics";

export function trackRegistration(raw: RegistrationProps): void {
  try {
    if (!isRegistrationAnalyticsEnabled()) return;
    const props = sanitizeRegistrationProps(raw);
    if (!props) return;

    if (props.step === "viewed" && props.entry) {
      const key = storageKey("viewed", props.entry);
      if (alreadyEmitted(key)) return;
      markEmitted(key);
    }
    if (props.step === "identity_ready") {
      const key = storageKey("identity_ready", "once");
      if (alreadyEmitted(key)) return;
      markEmitted(key);
    }
    if (props.step === "completed" && props.outcome) {
      const key = storageKey("completed", props.outcome);
      if (alreadyEmitted(key)) return;
      markEmitted(key);
    }

    const payload: Record<string, string> = { step: props.step };
    if (props.entry) payload.entry = props.entry;
    if (props.method) payload.method = props.method;
    if (props.outcome) payload.outcome = props.outcome;
    if (props.field) payload.field = props.field;

    track(REGISTRATION_EVENT, payload);
  } catch {
    // Swallow — analytics must never affect registration.
  }
}
