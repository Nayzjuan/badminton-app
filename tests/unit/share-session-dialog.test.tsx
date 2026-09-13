// ============================================================
// ShareSessionDialog — the URL that actually gets copied / QR'd
// ============================================================
// IDs: SSD-*
// ============================================================

// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ShareSessionDialog } from "@/components/organizer/share-session-dialog";

const SID = "00000000-0000-4000-8000-000000000001";

describe("ShareSessionDialog", () => {
  it("SSD-1: the displayed share URL is /j/<sessionId> with no query string", async () => {
    render(
      <ShareSessionDialog
        sessionId={SID}
        sessionName="Thursday Night"
        open
        onOpenChange={() => {}}
      />
    );

    const expected = `${window.location.origin}/j/${SID}`;
    await waitFor(() => {
      expect(screen.getByTitle(expected)).toBeInTheDocument();
    });
    expect(expected).not.toContain("?");
    expect(expected).toMatch(/\/j\/[0-9a-f-]{36}$/i);
  });
});
