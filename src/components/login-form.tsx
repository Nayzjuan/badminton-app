"use client";

// ============================================================
// Login Form — Name + Skill Level + PIN entry for anonymous auth
// ============================================================
// Two modes toggled by a segmented control at the top:
//   NEW PLAYER   — name + skill level + PIN → contextual CTA
//   RETURNING    — name + PIN → Reconnect (native form)
// ============================================================

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, UserPlus, RotateCcw } from "lucide-react";
import { signInAnonymously, reconnectPlayer } from "@/app/actions/auth";
import type { SkillLevel } from "@/types/database";
import { Spinner } from "./reconnect-modal";
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";
import { clubPlay, clubBase, sessionShare, clubJoin } from "@/lib/club-paths";
import { SkillLevelPicker } from "@/components/player/skill-level-picker";
import { displayNameSchema, pinSchema, skillLevelSchema } from "@/lib/schemas/auth";
import { trackRegistration, type RegistrationEntry } from "@/lib/registration-analytics";

interface LoginFormProps {
  sessionId?: string;
  clubSlug?: string;
}

type LoginMode = "new" | "returning";
type FieldKey = "name" | "pin" | "skill" | "form";

function entryContext(sessionId?: string, clubSlug?: string): RegistrationEntry {
  if (sessionId) return "qr_session";
  if (clubSlug) return "qr_club";
  return "direct";
}

function oauthNext(sessionId?: string, clubSlug?: string): string {
  if (sessionId) return sessionShare(sessionId);
  if (clubSlug) return clubJoin(clubSlug);
  return "/play";
}

function submitLabel(entry: RegistrationEntry): string {
  if (entry === "qr_session") return "Join Session";
  if (entry === "qr_club") return "Join Club";
  return "Create Player Profile";
}

function pendingLabel(entry: RegistrationEntry): string {
  return entry === "direct" ? "Creating…" : "Joining…";
}

function FieldError({ id, message }: { id: string; message: string }) {
  return (
    <p id={id} role="alert" className="text-sm text-destructive">
      {message}
    </p>
  );
}

export function LoginForm({ sessionId, clubSlug }: LoginFormProps = {}) {
  const router = useRouter();
  const entry = entryContext(sessionId, clubSlug);

  const [mode, setMode] = useState<LoginMode>("new");

  const [newErrors, setNewErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [newIsPending, startNewTransition] = useTransition();
  const [nameValue, setNameValue] = useState("");
  const [skillLevel, setSkillLevel] = useState<SkillLevel>("beginner");
  const [pinValue, setPinValue] = useState("");
  const [showPin, setShowPin] = useState(false);
  const newFocused = useRef(false);

  const [reconnectName, setReconnectName] = useState("");
  const [reconnectPin, setReconnectPin] = useState("");
  const [reconnectErrors, setReconnectErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [reconnectIsPending, startReconnectTransition] = useTransition();
  const [googleHint, setGoogleHint] = useState(false);
  const reconnectFocused = useRef(false);

  useEffect(() => {
    trackRegistration({ step: "viewed", entry });
  }, [entry]);

  useEffect(() => {
    router.prefetch(
      sessionId ? sessionShare(sessionId) : clubSlug ? clubJoin(clubSlug) : "/welcome"
    );
  }, [router, sessionId, clubSlug]);

  function focusFirstInvalid(ids: string[]) {
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) {
        el.focus();
        return;
      }
    }
  }

  function handleNewPlayerSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const formData = new FormData(form);
    setNewErrors({});
    newFocused.current = false;

    const nameParsed = displayNameSchema.safeParse(formData.get("display_name") ?? "");
    const skillParsed = skillLevelSchema.safeParse(formData.get("skill_level"));
    const pinParsed = pinSchema.safeParse(formData.get("pin") ?? "");
    const next: Partial<Record<FieldKey, string>> = {};
    if (!nameParsed.success) next.name = nameParsed.error.issues[0].message;
    if (!skillParsed.success) next.skill = skillParsed.error.issues[0].message;
    if (!pinParsed.success) next.pin = pinParsed.error.issues[0].message;
    if (Object.keys(next).length > 0) {
      setNewErrors(next);
      const firstField = next.name ? "name" : next.skill ? "skill" : "pin";
      trackRegistration({
        step: "validation_error",
        entry,
        method: "anonymous",
        field: firstField,
      });
      if (!newFocused.current) {
        newFocused.current = true;
        focusFirstInvalid(["display_name", "skill_level", "pin"]);
      }
      return;
    }

    trackRegistration({ step: "started", entry, method: "anonymous" });
    startNewTransition(async () => {
      const result = await signInAnonymously(formData);
      if (result?.error) {
        const field = result.field ?? "form";
        setNewErrors({ [field]: result.error });
        if (result.code === "name_taken") {
          setReconnectName(nameValue.trim());
          handleModeSwitch("returning", { keepName: true });
          window.setTimeout(() => document.getElementById("reconnect_pin")?.focus(), 0);
          return;
        }
        trackRegistration({ step: "validation_error", entry, method: "anonymous", field });
        if (!newFocused.current) {
          newFocused.current = true;
          focusFirstInvalid(
            field === "name"
              ? ["display_name"]
              : field === "skill"
                ? ["skill_level"]
                : field === "pin"
                  ? ["pin"]
                  : []
          );
        }
      }
    });
  }

  function handleReconnectSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (reconnectIsPending) return;
    setReconnectErrors({});
    setGoogleHint(false);
    reconnectFocused.current = false;

    const nameParsed = displayNameSchema.safeParse(reconnectName);
    const pinParsed = pinSchema.safeParse(reconnectPin);
    const next: Partial<Record<FieldKey, string>> = {};
    if (!nameParsed.success) next.name = nameParsed.error.issues[0].message;
    if (!pinParsed.success) next.pin = pinParsed.error.issues[0].message;
    if (Object.keys(next).length > 0) {
      setReconnectErrors(next);
      trackRegistration({
        step: "validation_error",
        entry,
        method: "pin",
        field: next.name ? "name" : "pin",
      });
      if (!reconnectFocused.current) {
        reconnectFocused.current = true;
        focusFirstInvalid(["reconnect_name", "reconnect_pin"]);
      }
      return;
    }

    trackRegistration({ step: "started", entry, method: "pin" });
    startReconnectTransition(async () => {
      const result = await reconnectPlayer(reconnectName.trim(), reconnectPin, clubSlug);
      if (!result.success) {
        setReconnectErrors({ [result.field ?? "form"]: result.error ?? "Reconnect failed." });
        if (result.useGoogleSignIn) setGoogleHint(true);
        return;
      }
      if (result.requiresRename) {
        const nextPath = sessionId
          ? sessionShare(sessionId)
          : clubSlug
            ? clubJoin(clubSlug)
            : "/play";
        router.replace(`/rename?next=${encodeURIComponent(nextPath)}`);
        return;
      }
      if (sessionId) {
        router.replace(sessionShare(sessionId));
        return;
      }
      if (result.wrappedUrl) {
        router.push(result.wrappedUrl);
      } else if (result.sessionId) {
        router.push(clubSlug ? clubPlay(clubSlug, result.sessionId) : `/play/${result.sessionId}`);
      } else {
        router.push(clubSlug ? clubBase(clubSlug) : "/play");
      }
    });
  }

  function handleModeSwitch(next: LoginMode, opts?: { keepName?: boolean }) {
    setMode(next);
    setNewErrors({});
    setReconnectErrors({});
    setGoogleHint(false);
    if (opts?.keepName) {
      setReconnectName(nameValue.trim());
    }
  }

  function handleTabKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      handleModeSwitch("returning");
      document.getElementById("tab-returning")?.focus();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      handleModeSwitch("new");
      document.getElementById("tab-new")?.focus();
    }
  }

  const newNameErr = newErrors.name;
  const newSkillErr = newErrors.skill;
  const newPinErr = newErrors.pin;
  const newFormErr = newErrors.form;

  return (
    <div className="w-full max-w-sm sm:max-w-md space-y-3">
      <GoogleSignInButton
        next={oauthNext(sessionId, clubSlug)}
        clubSlug={clubSlug}
        dividerPosition="below"
      />

      <div
        role="tablist"
        aria-label="Login mode"
        className="grid grid-cols-2 rounded-xl border border-border bg-muted/40 p-1 gap-1"
      >
        <button
          role="tab"
          aria-selected={mode === "new"}
          aria-controls="panel-new"
          id="tab-new"
          type="button"
          tabIndex={mode === "new" ? 0 : -1}
          onClick={() => handleModeSwitch("new")}
          onKeyDown={handleTabKeyDown}
          className={`flex min-h-11 cursor-pointer flex-col items-center gap-0.5 rounded-lg px-3 py-2
                      text-sm font-semibold transition-all duration-150
                      ${
                        mode === "new"
                          ? "bg-background text-foreground shadow-sm ring-1 ring-border/50"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
        >
          <UserPlus className="h-4 w-4" aria-hidden="true" />
          <span>NEW PLAYER</span>
        </button>

        <button
          role="tab"
          aria-selected={mode === "returning"}
          aria-controls="panel-returning"
          id="tab-returning"
          type="button"
          tabIndex={mode === "returning" ? 0 : -1}
          onClick={() => handleModeSwitch("returning")}
          onKeyDown={handleTabKeyDown}
          className={`flex min-h-11 cursor-pointer flex-col items-center gap-0.5 rounded-lg px-3 py-2
                      text-sm font-semibold transition-all duration-150
                      ${
                        mode === "returning"
                          ? "bg-background text-foreground shadow-sm ring-1 ring-border/50"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
        >
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          <span>RETURNING</span>
        </button>
      </div>

      {mode === "new" && (
        <form
          id="panel-new"
          role="tabpanel"
          aria-labelledby="tab-new"
          onSubmit={handleNewPlayerSubmit}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <label htmlFor="display_name" className="block text-sm font-semibold text-foreground">
              Your Name
            </label>
            <input
              id="display_name"
              name="display_name"
              type="text"
              autoFocus
              disabled={newIsPending}
              maxLength={30}
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              placeholder="e.g. Miggy, Stelle, Carlo B"
              autoComplete="nickname"
              aria-invalid={newNameErr ? true : undefined}
              aria-describedby={newNameErr ? "display_name_error" : "display_name_hint"}
              className="min-h-11 w-full rounded-lg border border-input bg-background px-4 py-2.5
                         text-base placeholder:text-muted-foreground focus:outline-none focus:ring-2
                         focus:ring-ring focus:ring-offset-2 disabled:opacity-50"
            />
            {newNameErr ? (
              <FieldError id="display_name_error" message={newNameErr} />
            ) : (
              <p id="display_name_hint" className="text-xs text-muted-foreground">
                Letters, numbers, and spaces. 3–30 characters.
              </p>
            )}
          </div>

          <SkillLevelPicker
            compact
            value={skillLevel}
            onChange={setSkillLevel}
            disabled={newIsPending}
            invalid={Boolean(newSkillErr)}
            describedBy={newSkillErr ? "skill_level_error" : undefined}
          />
          {newSkillErr && <FieldError id="skill_level_error" message={newSkillErr} />}

          <div className="space-y-1.5">
            <label htmlFor="pin" className="block text-sm font-semibold text-foreground">
              Choose a 4-Digit PIN
            </label>
            <div className="relative">
              <input
                id="pin"
                name="pin"
                type={showPin ? "tel" : "password"}
                inputMode="numeric"
                maxLength={4}
                disabled={newIsPending}
                value={pinValue}
                onChange={(e) => setPinValue(e.target.value.replace(/\D/g, "").slice(0, 4))}
                placeholder="1 2 3 4"
                autoComplete="off"
                aria-invalid={newPinErr ? true : undefined}
                aria-describedby={newPinErr ? "pin_error" : "pin_hint"}
                className="min-h-11 w-full rounded-lg border border-input bg-background px-4 py-2.5 pr-12
                           text-base tracking-[0.3em] text-center font-mono
                           placeholder:text-muted-foreground placeholder:tracking-normal
                           focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2
                           disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => setShowPin((v) => !v)}
                aria-label={showPin ? "Hide PIN" : "Show PIN"}
                aria-pressed={showPin}
                aria-controls="pin"
                disabled={newIsPending}
                className="absolute right-0 top-0 flex h-full min-w-[44px] cursor-pointer
                           items-center justify-center px-3 text-muted-foreground
                           hover:text-foreground disabled:pointer-events-none"
              >
                {showPin ? (
                  <EyeOff className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </div>
            {newPinErr ? (
              <FieldError id="pin_error" message={newPinErr} />
            ) : (
              <p id="pin_hint" className="text-xs text-muted-foreground">
                You&apos;ll use this PIN to sign back in.
              </p>
            )}
          </div>

          {sessionId && <input type="hidden" name="session_id" value={sessionId} />}
          {clubSlug && <input type="hidden" name="club_slug" value={clubSlug} />}

          {newFormErr && (
            <p role="alert" className="text-sm text-destructive">
              {newFormErr}
            </p>
          )}

          <button
            type="submit"
            disabled={newIsPending}
            className="flex min-h-[44px] w-full cursor-pointer items-center justify-center
                       gap-2 rounded-lg bg-amber-500 px-4 py-3 text-base font-semibold
                       text-[#0E1C3A] hover:bg-amber-600 disabled:cursor-not-allowed
                       disabled:opacity-70"
          >
            {newIsPending && <Spinner />}
            {newIsPending ? pendingLabel(entry) : submitLabel(entry)}
          </button>
          {entry === "direct" && (
            <p className="text-center text-xs text-muted-foreground">
              This creates your profile. Scan a session QR next to join the queue.
            </p>
          )}
        </form>
      )}

      {mode === "returning" && (
        <form
          id="panel-returning"
          role="tabpanel"
          aria-labelledby="tab-returning"
          onSubmit={handleReconnectSubmit}
          className="space-y-3"
        >
          <p className="text-sm text-muted-foreground">Enter the name and PIN you used before.</p>

          <div className="space-y-1.5">
            <label htmlFor="reconnect_name" className="block text-sm font-semibold text-foreground">
              Your Name
            </label>
            <input
              id="reconnect_name"
              type="text"
              value={reconnectName}
              onChange={(e) => setReconnectName(e.target.value)}
              disabled={reconnectIsPending}
              maxLength={30}
              placeholder="e.g. Miggy"
              autoComplete="nickname"
              aria-invalid={reconnectErrors.name ? true : undefined}
              aria-describedby={reconnectErrors.name ? "reconnect_name_error" : undefined}
              className="min-h-11 w-full rounded-lg border border-input bg-background px-4 py-2.5
                         text-base placeholder:text-muted-foreground focus:outline-none focus:ring-2
                         focus:ring-ring focus:ring-offset-2 disabled:opacity-50"
            />
            {reconnectErrors.name && (
              <FieldError id="reconnect_name_error" message={reconnectErrors.name} />
            )}
          </div>

          <div className="space-y-1.5">
            <label htmlFor="reconnect_pin" className="block text-sm font-semibold text-foreground">
              Your PIN
            </label>
            <input
              id="reconnect_pin"
              type="tel"
              inputMode="numeric"
              maxLength={4}
              value={reconnectPin}
              onChange={(e) => setReconnectPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
              disabled={reconnectIsPending}
              placeholder="1 2 3 4"
              autoComplete="off"
              aria-invalid={reconnectErrors.pin ? true : undefined}
              aria-describedby={reconnectErrors.pin ? "reconnect_pin_error" : undefined}
              className="min-h-11 w-full rounded-lg border border-input bg-background px-4 py-2.5
                         text-base tracking-[0.3em] text-center font-mono
                         placeholder:text-muted-foreground placeholder:tracking-normal
                         focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2
                         disabled:opacity-50"
            />
            {reconnectErrors.pin && (
              <FieldError id="reconnect_pin_error" message={reconnectErrors.pin} />
            )}
          </div>

          {googleHint && (
            <p role="status" className="text-sm text-sky-700 dark:text-sky-300">
              This account uses Google sign-in. Use <strong>Continue with Google</strong> above.
            </p>
          )}

          {reconnectErrors.form && !googleHint && (
            <p role="alert" className="text-sm text-destructive">
              {reconnectErrors.form}
            </p>
          )}

          <button
            type="submit"
            disabled={reconnectIsPending}
            className="flex min-h-[44px] w-full cursor-pointer items-center justify-center
                       gap-2 rounded-lg bg-amber-500 px-4 py-3 text-base font-semibold
                       text-[#0E1C3A] hover:bg-amber-600 disabled:cursor-not-allowed
                       disabled:opacity-70"
          >
            {reconnectIsPending && <Spinner />}
            {reconnectIsPending ? "Reconnecting…" : "Reconnect"}
          </button>
        </form>
      )}
    </div>
  );
}
