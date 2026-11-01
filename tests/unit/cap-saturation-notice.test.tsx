// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CapSaturationNotice } from "@/components/organizer/sortable-card";
import { CRITICAL_WAIT_MINUTES } from "@/lib/constants";

describe("CapSaturationNotice — immediate rematch", () => {
  it("renders the rematch branch for general and Red Zone, and dismisses", async () => {
    const onDismiss = vi.fn();
    const { rerender } = render(
      <CapSaturationNotice
        capSaturation={{
          type: "general",
          anchorPlayerId: "a",
          anchorPlayerName: "Ana",
          reason: "immediate_rematch",
        }}
        onDismiss={onDismiss}
      />
    );
    expect(screen.getByLabelText("Immediate-rematch notice")).toBeTruthy();
    expect(screen.getByText("Immediate rematch blocked")).toBeTruthy();
    expect(screen.getByText(/every remaining group would repeat/i)).toBeTruthy();

    rerender(
      <CapSaturationNotice
        capSaturation={{
          type: "red_zone",
          anchorPlayerId: "a",
          anchorPlayerName: "Ana",
          reason: "immediate_rematch",
        }}
        onDismiss={onDismiss}
      />
    );
    expect(
      screen.getByText(new RegExp(`waiting over ${CRITICAL_WAIT_MINUTES} min`, "i"))
    ).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Dismiss immediate-rematch notice"));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
