import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runCourtsideAction } from "@/lib/courtside-action";

describe("runCourtsideAction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("CA-1: resolves ok with the value", async () => {
    const pending = runCourtsideAction(Promise.resolve({ ok: true }), { timeoutMs: 1_000 });
    await expect(pending).resolves.toEqual({ status: "ok", value: { ok: true } });
  });

  it("CA-2: maps a throw to error", async () => {
    const pending = runCourtsideAction(Promise.reject(new Error("boom")), { timeoutMs: 1_000 });
    await expect(pending).resolves.toEqual({ status: "error", error: "boom" });
  });

  it("CA-3: timer win is timeout, not ok", async () => {
    const pending = runCourtsideAction(new Promise<string>(() => {}), { timeoutMs: 50 });
    const assertion = expect(pending).resolves.toEqual({ status: "timeout" });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it("CA-4: onSlow fires before timeout and is cleared on success", async () => {
    const onSlow = vi.fn();
    let resolve!: (v: string) => void;
    const promise = new Promise<string>((r) => {
      resolve = r;
    });
    const pending = runCourtsideAction(promise, { timeoutMs: 12_000, onSlow });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onSlow).toHaveBeenCalledOnce();
    resolve("done");
    await expect(pending).resolves.toEqual({ status: "ok", value: "done" });
  });
});
