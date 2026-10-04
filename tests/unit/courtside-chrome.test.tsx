// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  OrganizerDraftStrip,
  OrganizerOfflineBanner,
} from "@/components/organizer/courtside-chrome";
import { COURTSIDE_OFFLINE_COPY } from "@/lib/courtside-action";

describe("courtside chrome", () => {
  it("offline banner uses the shared copy", () => {
    render(<OrganizerOfflineBanner />);
    expect(screen.getByRole("status")).toHaveTextContent(COURTSIDE_OFFLINE_COPY);
  });

  it("draft strip exposes Review and Clear as buttons", async () => {
    const user = userEvent.setup();
    const onReview = vi.fn();
    const onClear = vi.fn();
    render(
      <OrganizerDraftStrip
        message="2 unpublished drafts — review on Courts"
        showClear
        onReview={onReview}
        onClear={onClear}
      />
    );
    await user.click(screen.getByRole("button", { name: /review/i }));
    await user.click(screen.getByRole("button", { name: /clear unpublished/i }));
    expect(onReview).toHaveBeenCalledOnce();
    expect(onClear).toHaveBeenCalledOnce();
  });
});
