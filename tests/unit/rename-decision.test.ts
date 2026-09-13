// ============================================================
// Suite RD — /rename admission + confirm keep-same (pure)
// ============================================================
//   RD-1  both flags false → bounce (the /rename bounce-out)
//   RD-2  confirm-pending is admitted in confirm mode with display_name
//   RD-3  confirm never prefills collided_name (that would fire R1)
//   RD-4  force uses collided_name when present
//   RD-5  both flags set → force wins (R1 must still apply)
//   RD-6  confirm + current name is NOT reused — keep-same is valid
//   RD-7  force + current name IS reused
//   RD-8  confirm + short name is still invalid
// ============================================================

import { describe, it, expect } from "vitest";
import { evaluateRenameSync, renamePageDecision } from "@/lib/rename-decision";

describe("RD: renamePageDecision", () => {
  it("RD-1: both flags false bounce the player off /rename", () => {
    expect(
      renamePageDecision({
        needs_rename: false,
        needs_name_confirm: false,
        collided_name: null,
        display_name: "Juan Cruz",
      })
    ).toEqual({ action: "bounce" });
  });

  it("RD-2: confirm-pending is admitted in confirm mode with the assigned name", () => {
    expect(
      renamePageDecision({
        needs_rename: false,
        needs_name_confirm: true,
        collided_name: null,
        display_name: "Juan Cruz",
      })
    ).toEqual({ action: "confirm", currentName: "Juan Cruz" });
  });

  it("RD-3: confirm never prefills collided_name", () => {
    expect(
      renamePageDecision({
        needs_rename: false,
        needs_name_confirm: true,
        collided_name: "Someone Else",
        display_name: "Juan Cruz",
      })
    ).toEqual({ action: "confirm", currentName: "Juan Cruz" });
  });

  it("RD-4: force uses collided_name when present", () => {
    expect(
      renamePageDecision({
        needs_rename: true,
        needs_name_confirm: false,
        collided_name: "Juan",
        display_name: "Player_abcd1234",
      })
    ).toEqual({ action: "force", currentName: "Juan" });
  });

  it("RD-5: both flags set → force wins so R1 still applies", () => {
    expect(
      renamePageDecision({
        needs_rename: true,
        needs_name_confirm: true,
        collided_name: "Juan",
        display_name: "Juan",
      })
    ).toEqual({ action: "force", currentName: "Juan" });
  });
});

describe("RD: evaluateRenameSync", () => {
  it("RD-6: confirm + the current name is not reused — keep-same is valid", () => {
    expect(evaluateRenameSync("Juan Cruz", { mode: "confirm", currentName: "Juan Cruz" })).toBe(
      "async"
    );
    expect(
      evaluateRenameSync("  juan   cruz  ", { mode: "confirm", currentName: "Juan Cruz" })
    ).toBe("async");
  });

  it("RD-7: force + the collided name is reused", () => {
    const r = evaluateRenameSync("Juan Cruz", { mode: "force", currentName: "Juan Cruz" });
    expect(r).not.toBe("async");
    if (r === "async") throw new Error("expected reused");
    expect(r.phase).toBe("reused");
  });

  it("RD-8: confirm still rejects a too-short name", () => {
    const r = evaluateRenameSync("ab", { mode: "confirm", currentName: "Juan Cruz" });
    expect(r).not.toBe("async");
    if (r === "async") throw new Error("expected invalid");
    expect(r.phase).toBe("invalid");
  });
});
