// @vitest-environment happy-dom
// ============================================================
// CoOrganizerShareDialog — mint only when the dialog is open
// ============================================================
// IDs: CSD-*
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/app/actions/sessions", () => ({
  getOrCreateCoOrganizerInvite: vi.fn(),
}));

import { CoOrganizerShareDialog } from "@/components/organizer/co-organizer-share-dialog";
import { getOrCreateCoOrganizerInvite } from "@/app/actions/sessions";
import { sessionCoOrgShare } from "@/lib/club-paths";

const SID = "00000000-0000-4000-8000-000000000001";
const TOKEN = "abcdefghijklmnopqrstuvwxyz012345";

describe("CoOrganizerShareDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getOrCreateCoOrganizerInvite).mockResolvedValue({
      success: true,
      message: "Invite ready.",
      token: TOKEN,
      path: sessionCoOrgShare(TOKEN),
    });
  });

  it("CSD-1: a closed controlled dialog does not mint", () => {
    render(
      <CoOrganizerShareDialog
        sessionId={SID}
        sessionName="Friday Night"
        open={false}
        onOpenChange={() => {}}
        hideTrigger
      />
    );
    expect(getOrCreateCoOrganizerInvite).not.toHaveBeenCalled();
  });

  it("CSD-2: opening the dialog mints and encodes /o/[token], not /j/[sessionId]", async () => {
    render(
      <CoOrganizerShareDialog
        sessionId={SID}
        sessionName="Friday Night"
        open
        onOpenChange={() => {}}
        hideTrigger
      />
    );
    await vi.waitFor(() => {
      expect(getOrCreateCoOrganizerInvite).toHaveBeenCalledWith(SID);
    });
    expect(await screen.findByTitle(new RegExp(`/o/${TOKEN}`))).toBeInTheDocument();
    expect(screen.queryByTitle(new RegExp(`/j/${SID}`))).not.toBeInTheDocument();
  });

  it("CSD-3: an uncontrolled hub trigger does not mint until opened", async () => {
    const user = userEvent.setup();
    render(<CoOrganizerShareDialog sessionId={SID} sessionName="Friday Night" />);
    expect(getOrCreateCoOrganizerInvite).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /co-organizer qr/i }));
    await vi.waitFor(() => {
      expect(getOrCreateCoOrganizerInvite).toHaveBeenCalledWith(SID);
    });
  });

  it("CSD-4: a rejected mint surfaces an alert instead of hanging on Generating", async () => {
    vi.mocked(getOrCreateCoOrganizerInvite).mockRejectedValue(new Error("network"));
    render(
      <CoOrganizerShareDialog
        sessionId={SID}
        sessionName="Friday Night"
        open
        onOpenChange={() => {}}
        hideTrigger
      />
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/something went wrong/i);
    expect(screen.queryByText(/generating/i)).not.toBeInTheDocument();
  });
});
