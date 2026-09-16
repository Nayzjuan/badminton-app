import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  classifyRoute,
  extractGotchas,
  normalizeChannelTemplate,
  parseSection9,
  resolveAppRoute,
} from "../scripts/extract-host.ts";
import {
  buildManifest,
  canonicalForCheck,
  computeDrift,
  extractCoverage,
} from "../scripts/extract.ts";
import type { LiveSnapshot } from "../scripts/extract.ts";
import { constByName } from "../src/lib/invariants.ts";

describe("resolveAppRoute", () => {
  it("strips route groups and keeps dynamic segments", () => {
    expect(resolveAppRoute("c/[clubSlug]/(full)/organizer/[sessionId]/page.tsx")).toBe(
      "/c/[clubSlug]/organizer/[sessionId]"
    );
    expect(resolveAppRoute("page.tsx")).toBe("/");
  });
});

describe("classifyRoute", () => {
  it("labels organizer, player, public, and dev surfaces", () => {
    expect(classifyRoute("/c/[clubSlug]/organizer")).toBe("organizer");
    expect(classifyRoute("/c/[clubSlug]/play/[sessionId]")).toBe("player");
    expect(classifyRoute("/welcome")).toBe("public");
    expect(classifyRoute("/sandbox/player-alert")).toBe("dev");
  });
});

describe("normalizeChannelTemplate", () => {
  it("rewrites sessionId placeholders", () => {
    expect(normalizeChannelTemplate("session-events:${sessionId}")).toBe(
      "session-events:{sessionId}"
    );
  });
});

describe("parseSection9 + sidecar", () => {
  it("parses every numbered §9 item including titles with text after the close-bold", () => {
    const md = `## 9. Known Gotchas

1. **Alpha** — first body.
2. **\`type\` not \`interface\`** for all DB row types — second body.

## 10. Digital Twin
`;
    const items = parseSection9(md);
    expect(items.map((i) => i.n)).toEqual([1, 2]);
    expect(items[1].title).toContain("type");
    expect(items[1].body).toContain("second body");
  });

  it("throws when a §9 item has no sidecar row", () => {
    const dir = mkdtempSync(join(tmpdir(), "gotcha-"));
    try {
      writeFileSync(
        join(dir, "APP_MANIFEST.md"),
        "## 9. Known Gotchas\n\n1. **Only** — body.\n\n## 10. X\n"
      );
      writeFileSync(join(dir, "sidecar.json"), JSON.stringify({ extras: [] }));
      expect(() => extractGotchas(join(dir, "APP_MANIFEST.md"), join(dir, "sidecar.json"))).toThrow(
        /item 1 has no sidecar row/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extract --check ignore keys", () => {
  it("ignores _lastExtracted and coverage", () => {
    const a = { _lastExtracted: "2026-01-01", coverage: { totals: { pct: 1 } }, tables: [1] };
    const b = { _lastExtracted: "2026-09-16", coverage: { totals: { pct: 99 } }, tables: [1] };
    expect(canonicalForCheck(a as never)).toBe(canonicalForCheck(b as never));
  });
});

describe("coverage preservation", () => {
  it("reuses the committed coverage block when lcov.info is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "cov-"));
    try {
      const manifestPath = join(dir, "manifest.json");
      writeFileSync(
        manifestPath,
        JSON.stringify({ coverage: { totals: { lines: 10, hit: 9, pct: 90, files: 1 } } })
      );
      const preserved = extractCoverage(join(dir, "no-such-lcov.info"), manifestPath);
      expect(preserved?.totals.pct).toBe(90);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("computeDrift GENERATED nullability", () => {
  it("does not count expected GENERATED columns as real drift", () => {
    const snap: LiveSnapshot = {
      capturedAt: "2026-09-16",
      tables: {
        matches: [
          ["id", "uuid", false],
          ["is_held", "boolean", true],
          ["final_classification", "text", true],
        ],
        session_wrapped_stats: [["point_diff", "integer", true]],
      },
      views: [],
      functions: [],
      policies: [],
    };
    const drift = computeDrift(
      snap,
      [
        {
          name: "matches",
          typeName: "Match",
          desc: "",
          columns: [
            { name: "id", type: "string", nullable: false, note: "" },
            { name: "is_held", type: "boolean", nullable: false, note: "" },
            { name: "final_classification", type: "string", nullable: false, note: "" },
          ],
        },
        {
          name: "session_wrapped_stats",
          typeName: "SessionWrappedStats",
          desc: "",
          columns: [{ name: "point_diff", type: "number", nullable: false, note: "" }],
        },
      ],
      [],
      []
    );
    expect(drift.columnNullabilityDrift).toEqual([]);
    expect(drift.columnNullabilityExpected.map((e) => `${e.table}.${e.column}`).sort()).toEqual([
      "matches.final_classification",
      "matches.is_held",
      "session_wrapped_stats.point_diff",
    ]);
  });
});

describe("constByName", () => {
  it("throws when the constant is missing", () => {
    expect(() => constByName({ constants: [] }, "CRITICAL_WAIT_MINUTES")).toThrow(
      /missing constant CRITICAL_WAIT_MINUTES/
    );
  });
});

describe("held-draft machine", () => {
  it("has HOLDING → RESTING → READY edges without hand-set terminal columns", () => {
    const machines = buildManifest().stateMachines;
    const held = machines.find((m) => m.name === "Held-draft lifecycle");
    expect(held?.states).toEqual(["HOLDING", "RESTING", "READY"]);
    expect(held?.edges.some((e) => e.from === "HOLDING" && e.to === "RESTING")).toBe(true);
    expect(held?.edges.some((e) => e.from === "RESTING" && e.to === "READY")).toBe(true);
  });
});
