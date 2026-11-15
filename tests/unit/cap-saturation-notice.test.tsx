// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CapSaturationNotice } from "@/components/organizer/sortable-card";
import { capSaturationCopy } from "@/lib/cap-saturation-copy";
import { CRITICAL_WAIT_MINUTES, MAX_PARTNERSHIP_REPEATS } from "@/lib/constants";

describe("capSaturationCopy — pinned strings", () => {
  it("keeps the rematch / consecutive / session_cap wording", () => {
    expect(
      capSaturationCopy({
        reason: "immediate_rematch",
        zone: "general",
        anchorPlayerName: "Ana",
      })
    ).toEqual({
      heading: "Immediate rematch blocked",
      noticeLabel: "Immediate-rematch notice",
      body: "Could not form a match for Ana — every remaining group would repeat someone's last game. Assign manually or wait for a court to finish.",
    });
    expect(
      capSaturationCopy({
        reason: "immediate_rematch",
        zone: "red_zone",
        anchorPlayerName: "Ana",
      }).body
    ).toBe(
      `Ana has been waiting over ${CRITICAL_WAIT_MINUTES} min, but every available group would put someone back with a player from their last game. Manual assignment needed.`
    );
    expect(
      capSaturationCopy({
        reason: "consecutive",
        zone: "general",
        anchorPlayerName: "Ana",
      }).heading
    ).toBe("Last partnership blocked");
    expect(
      capSaturationCopy({
        reason: "session_cap",
        zone: "red_zone",
        anchorPlayerName: "Ana",
      }).body
    ).toBe(
      `Ana has been waiting over ${CRITICAL_WAIT_MINUTES} min but all available teammates have already hit the ${MAX_PARTNERSHIP_REPEATS}-game partner cap. Manual assignment needed.`
    );
    expect(
      capSaturationCopy({
        reason: undefined,
        zone: "general",
        anchorPlayerName: "Ana",
      }).heading
    ).toBe("Partner-pair cap reached");
  });
});

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
    expect(screen.getByLabelText("Immediate-rematch notice").getAttribute("aria-live")).toBe(
      "polite"
    );

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
    expect(screen.getByLabelText("Immediate-rematch notice").getAttribute("aria-live")).toBe(
      "assertive"
    );

    fireEvent.click(screen.getByLabelText("Dismiss immediate-rematch notice"));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

describe("CapSaturationNotice — consecutive and session cap", () => {
  it("renders consecutive and session_cap headings from the copy map", () => {
    const { rerender } = render(
      <CapSaturationNotice
        capSaturation={{
          type: "general",
          anchorPlayerId: "a",
          anchorPlayerName: "Ana",
          reason: "consecutive",
        }}
      />
    );
    expect(screen.getByLabelText("Last-partnership notice")).toBeTruthy();
    expect(screen.getByText("Last partnership blocked")).toBeTruthy();
    expect(screen.getByText(/reuse last game's teammates/i)).toBeTruthy();

    rerender(
      <CapSaturationNotice
        capSaturation={{
          type: "red_zone",
          anchorPlayerId: "a",
          anchorPlayerName: "Ana",
          reason: "session_cap",
        }}
      />
    );
    expect(screen.getByLabelText("Partner-pair cap notice")).toBeTruthy();
    expect(screen.getByText("Partner-pair cap reached")).toBeTruthy();
    expect(
      screen.getByText(new RegExp(`${MAX_PARTNERSHIP_REPEATS}-game partner cap`, "i"))
    ).toBeTruthy();
  });
});
