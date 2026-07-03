"use client";

// ============================================================
// CreateClubForm — name + live slug preview → createClub action
// ============================================================
// The slug is derived from the name as you type (editable). Client-side
// validation mirrors the DB CHECK via isValidClubSlug so the user gets
// immediate feedback; the server re-validates and owns uniqueness.
// ============================================================

import { useState, useTransition, useId } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { createClub } from "@/app/actions/clubs";
import { slugifyClubName, isValidClubSlug, CLUB_SLUG_MAX } from "@/lib/club-slug";

export function CreateClubForm() {
  const router = useRouter();
  const nameId = useId();
  const slugId = useId();

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Slug auto-follows the name until the user edits the slug field directly.
  const effectiveSlug = slugEdited ? slug : slugifyClubName(name);
  const slugValid = isValidClubSlug(effectiveSlug);
  const canSubmit = name.trim().length > 0 && slugValid && !isPending;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!canSubmit) return;

    startTransition(async () => {
      const result = await createClub({ name: name.trim(), slug: effectiveSlug });
      if (result.success && result.slug) {
        router.push(`/c/${result.slug}`);
      } else {
        setError(result.message);
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Name */}
      <div className="space-y-1.5">
        <label
          htmlFor={nameId}
          className="block font-command text-xs font-bold uppercase tracking-wide text-cc-t2"
        >
          Club name
        </label>
        <input
          id={nameId}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          autoFocus
          placeholder="Chillax Badminton"
          className="clip-cut-sm w-full border border-cc-border bg-cc-bg-2 px-3.5 py-2.5 text-sm text-cc-t1 outline-none transition-colors placeholder:text-cc-t3 focus:border-cc-accent focus:ring-2 focus:ring-cc-accent/30"
        />
      </div>

      {/* Slug */}
      <div className="space-y-1.5">
        <label
          htmlFor={slugId}
          className="block font-command text-xs font-bold uppercase tracking-wide text-cc-t2"
        >
          Club link
        </label>
        <div className="clip-cut-sm flex items-center gap-1.5 border border-cc-border bg-cc-bg-2 px-3.5 py-2.5 focus-within:border-cc-accent focus-within:ring-2 focus-within:ring-cc-accent/30">
          <span className="select-none font-mono text-sm text-cc-t3">/c/</span>
          <input
            id={slugId}
            type="text"
            value={effectiveSlug}
            onChange={(e) => {
              setSlugEdited(true);
              setSlug(e.target.value.toLowerCase());
            }}
            maxLength={CLUB_SLUG_MAX}
            spellCheck={false}
            autoCapitalize="none"
            placeholder="chillax-badminton"
            className="w-full bg-transparent font-mono text-sm text-cc-t1 outline-none placeholder:text-cc-t3"
          />
        </div>
        <p className="text-[11px] text-cc-t3">
          {effectiveSlug && !slugValid
            ? "3–50 characters: lowercase letters, numbers, single hyphens."
            : "This is your club's permanent URL."}
        </p>
      </div>

      {error && (
        <p
          role="alert"
          className="clip-cut-sm border border-cc-red/30 bg-cc-red-dim px-3 py-2 text-xs font-medium text-cc-red"
        >
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={!canSubmit}
        className="clip-cut-sm inline-flex w-full items-center justify-center gap-2 bg-cc-accent px-4 py-2.5 text-sm font-bold uppercase tracking-wide text-cc-btn-on-accent transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
        {isPending ? "Creating…" : "Create club"}
      </button>
    </form>
  );
}
