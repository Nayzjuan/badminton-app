"use client";

import { useState } from "react";
import {
  OrganizerDraftStrip,
  OrganizerOfflineBanner,
} from "@/components/organizer/courtside-chrome";
import { ScoreModal } from "@/components/organizer/score-modal";
import type { EnrichedMatch } from "@/hooks/use-organizer-data";

const MATCH = {
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  court: { name: "Court 1" },
  players: [
    { team: "a", profile: { display_name: "Ada" } },
    { team: "a", profile: { display_name: "Bea" } },
    { team: "b", profile: { display_name: "Cam" } },
    { team: "b", profile: { display_name: "Dee" } },
  ],
} as unknown as EnrichedMatch;

export default function SandboxCourtsideChromePage() {
  const [scoreOpen, setScoreOpen] = useState(false);
  const hanging = () => new Promise<{ error?: string }>(() => {});

  return (
    <div className="min-h-screen bg-cc-bg text-cc-t1">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-3 py-6 lg:px-6">
        <h1 className="font-command text-lg uppercase tracking-[0.12em]">Courtside chrome</h1>
        <OrganizerOfflineBanner />
        <OrganizerDraftStrip
          message="2 unpublished drafts — review on Courts"
          showClear
          onReview={() => undefined}
          onClear={() => undefined}
        />
        <OrganizerDraftStrip
          message="1 held draft waiting on a live court"
          showClear={false}
          onReview={() => undefined}
          onClear={() => undefined}
        />
        <div className="flex flex-col gap-2 min-[480px]:flex-row min-[480px]:items-stretch">
          <input
            type="text"
            defaultValue=""
            placeholder="Court name (e.g. Court 3)"
            className="min-h-[44px] min-w-0 w-full flex-1 clip-cut border border-cc-border bg-cc-bg-2 px-4
                       font-command text-sm text-cc-t1 placeholder:text-cc-t3"
          />
          <button
            type="button"
            className="min-h-[44px] w-full shrink-0 whitespace-nowrap clip-cut-sm bg-cc-accent px-5
                       font-command text-[10px] uppercase tracking-[0.12em] text-cc-btn-on-accent
                       min-[480px]:w-auto"
          >
            + Add Court
          </button>
        </div>
        <button
          type="button"
          onClick={() => setScoreOpen(true)}
          className="inline-flex min-h-[44px] items-center justify-center clip-cut-sm bg-cc-accent px-4 font-command text-[10px] uppercase tracking-[0.10em] text-cc-btn-on-accent"
        >
          Open score modal
        </button>
      </div>
      <ScoreModal
        open={scoreOpen}
        match={MATCH}
        onSubmit={hanging}
        onClose={() => setScoreOpen(false)}
      />
    </div>
  );
}
