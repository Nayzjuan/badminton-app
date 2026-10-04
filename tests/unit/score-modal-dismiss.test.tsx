// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

describe("ScoreModal dismiss while pending", () => {
  it("SM-1: Cancel stays enabled while Saving…", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const hanging = new Promise<{ error?: string }>((resolve) => {
      release = () => resolve({});
    });
    render(<ScoreModal open match={MATCH} onSubmit={() => hanging} onClose={vi.fn()} />);
    const inputs = screen.getAllByRole("spinbutton");
    await user.type(inputs[0], "21");
    await user.type(inputs[1], "18");
    await user.click(screen.getByRole("button", { name: /end match/i }));
    expect(await screen.findByRole("button", { name: /saving/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeEnabled();
    expect(screen.getByText(/you can close this/i)).toBeInTheDocument();
    release();
  });
});
