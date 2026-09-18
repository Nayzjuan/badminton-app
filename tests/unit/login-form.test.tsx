// @vitest-environment happy-dom
// ============================================================
// LoginForm — contextual CTAs, compact skill, returning form
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { replace, push } = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace, prefetch: vi.fn() }),
}));

vi.mock("@/app/actions/auth", () => ({
  signInAnonymously: vi.fn(),
  reconnectPlayer: vi.fn(),
}));

vi.mock("@/lib/registration-analytics", () => ({
  trackRegistration: vi.fn(),
}));

vi.mock("@/components/auth/google-sign-in-button", () => ({
  GoogleSignInButton: ({ next }: { next?: string }) => <div data-testid="google-next">{next}</div>,
}));

import { LoginForm } from "@/components/login-form";
import { signInAnonymously, reconnectPlayer } from "@/app/actions/auth";
import { trackRegistration } from "@/lib/registration-analytics";
import { sessionShare } from "@/lib/club-paths";

const SID = "00000000-0000-4000-8000-000000000001";

describe("LoginForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("LF-1: direct registration labels Create Player Profile and does not claim a queue join", () => {
    render(<LoginForm />);
    expect(screen.getByRole("button", { name: /create player profile/i })).toBeInTheDocument();
    expect(screen.getByText(/scan a session qr next to join the queue/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /join queue/i })).not.toBeInTheDocument();
  });

  it("LF-2: session QR uses Join Session and Google next is the share route", () => {
    render(<LoginForm sessionId={SID} clubSlug="chillax" />);
    expect(screen.getByRole("button", { name: /join session/i })).toBeInTheDocument();
    expect(screen.getByTestId("google-next")).toHaveTextContent(sessionShare(SID));
  });

  it("LF-3: compact picker lists all six levels without a second tap target", () => {
    render(<LoginForm />);
    const select = screen.getByLabelText(/^skill level$/i);
    expect(select.querySelectorAll("option")).toHaveLength(6);
    expect(screen.getByText(/not sure\? leave beginner/i)).toBeInTheDocument();
    expect(screen.queryByText(/what do the 6 levels mean/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/6 choices/i)).not.toBeInTheDocument();
  });

  it("LF-4: client validation shows persistent field errors and does not call the server", async () => {
    const user = userEvent.setup();
    render(<LoginForm />);
    await user.click(screen.getByRole("button", { name: /create player profile/i }));
    expect(await screen.findByText(/name must be at least 3 characters/i)).toBeInTheDocument();
    expect(signInAnonymously).not.toHaveBeenCalled();
    expect(trackRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ step: "validation_error", field: "name" })
    );
  });

  it("LF-5: taken name switches to Returning and focuses PIN", async () => {
    const user = userEvent.setup();
    vi.mocked(signInAnonymously).mockResolvedValue({
      success: false,
      error: "That name is already registered.",
      field: "name",
      code: "name_taken",
    });
    render(<LoginForm />);
    await user.type(screen.getByLabelText(/your name/i), "Miggy");
    await user.type(screen.getByLabelText(/choose a 4-digit pin/i), "1234");
    await user.click(screen.getByRole("button", { name: /create player profile/i }));
    expect(await screen.findByRole("button", { name: /^reconnect$/i })).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(screen.getByLabelText(/your pin/i)).toHaveFocus();
    });
    expect(screen.getByLabelText(/your name/i)).toHaveValue("Miggy");
  });

  it("LF-5b: name_taken focuses PIN when already on Returning", async () => {
    let resolveSignIn!: (value: {
      success: false;
      error: string;
      field: "name";
      code: "name_taken";
    }) => void;
    vi.mocked(signInAnonymously).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSignIn = resolve;
        })
    );
    const user = userEvent.setup();
    render(<LoginForm />);
    await user.type(screen.getByLabelText(/your name/i), "Miggy");
    await user.type(screen.getByLabelText(/choose a 4-digit pin/i), "1234");
    const submit = user.click(screen.getByRole("button", { name: /create player profile/i }));
    await user.click(screen.getByRole("tab", { name: /returning/i }));
    resolveSignIn({
      success: false,
      error: "That name is already registered.",
      field: "name",
      code: "name_taken",
    });
    await submit;
    await vi.waitFor(() => {
      expect(screen.getByLabelText(/your pin/i)).toHaveFocus();
    });
  });

  it("LF-6: Returning is a real form; Enter with incomplete input does not reconnect", async () => {
    const user = userEvent.setup();
    render(<LoginForm />);
    await user.click(screen.getByRole("tab", { name: /returning/i }));
    await user.type(screen.getByLabelText(/your name/i), "Al");
    await user.keyboard("{Enter}");
    expect(reconnectPlayer).not.toHaveBeenCalled();
    expect(await screen.findAllByRole("alert")).not.toHaveLength(0);
  });

  it("LF-6b: a PIN-only reconnect error focuses the PIN, not the valid name", async () => {
    const user = userEvent.setup();
    render(<LoginForm />);
    await user.click(screen.getByRole("tab", { name: /returning/i }));
    await user.type(screen.getByLabelText(/your name/i), "Miggy");
    await user.keyboard("{Enter}");
    expect(await screen.findByText(/pin must be exactly 4 digits/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/your pin/i)).toHaveFocus();
    expect(reconnectPlayer).not.toHaveBeenCalled();
  });

  it("LF-7: tabs expose aria-controls to matching tabpanels", () => {
    render(<LoginForm />);
    expect(screen.getByRole("tab", { name: /new player/i })).toHaveAttribute(
      "aria-controls",
      "panel-new"
    );
    expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "panel-new");
  });

  it("LF-8: mode tabs use a 12px gap so they are not a 4px fat-finger pair", () => {
    render(<LoginForm />);
    const tablist = screen.getByRole("tablist", { name: /login mode/i });
    expect(tablist.className).toMatch(/\bgap-3\b/);
    expect(tablist.className).not.toMatch(/\bgap-1\b/);
  });

  it("LF-9: primary CTAs use cc-amber tokens, not raw amber-500", async () => {
    const user = userEvent.setup();
    render(<LoginForm />);
    const create = screen.getByRole("button", { name: /create player profile/i });
    expect(create.className).toMatch(/\bbg-cc-amber\b/);
    expect(create.className).toMatch(/\btext-cc-btn-on-accent\b/);
    expect(create.className).not.toMatch(/bg-amber-500/);
    expect(create.className).not.toMatch(/#0E1C3A/);

    await user.click(screen.getByRole("tab", { name: /returning/i }));
    const reconnect = screen.getByRole("button", { name: /^reconnect$/i });
    expect(reconnect.className).toMatch(/\bbg-cc-amber\b/);
    expect(reconnect.className).toMatch(/\btext-cc-btn-on-accent\b/);
    expect(reconnect.className).not.toMatch(/bg-amber-500/);
  });

  it("LF-10: the unselected mode tab uses cc-t2, not muted-foreground", () => {
    render(<LoginForm />);
    const returning = screen.getByRole("tab", { name: /returning/i });
    expect(returning.getAttribute("aria-selected")).toBe("false");
    expect(returning.className).toMatch(/\btext-cc-t2\b/);
    expect(returning.className).not.toMatch(/text-muted-foreground/);
  });

  it("LF-11: a skill error focuses the compact select by name and announces the error only", async () => {
    const nativeGet = FormData.prototype.get;
    const spy = vi.spyOn(FormData.prototype, "get").mockImplementation(function (
      this: FormData,
      name
    ) {
      if (String(name) === "skill_level") return "not-a-level";
      return nativeGet.call(this, name);
    });
    const user = userEvent.setup();
    try {
      render(<LoginForm />);
      const select = screen.getByLabelText(/^skill level$/i);
      expect(select.id).not.toBe("skill_level");
      expect(select).toHaveAttribute("name", "skill_level");

      await user.type(screen.getByLabelText(/your name/i), "Miggy");
      await user.type(screen.getByLabelText(/choose a 4-digit pin/i), "1234");
      await user.click(screen.getByRole("button", { name: /create player profile/i }));

      expect(await screen.findByText(/please select a valid skill level/i)).toBeInTheDocument();
      expect(select).toHaveFocus();
      expect(select).toHaveAttribute("aria-invalid", "true");
      expect(select.getAttribute("aria-describedby")?.split(/\s+/)).toEqual(["skill_level_error"]);
      expect(signInAnonymously).not.toHaveBeenCalled();
      expect(trackRegistration).toHaveBeenCalledWith(
        expect.objectContaining({ step: "validation_error", field: "skill" })
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("LF-12: co-organizer next labels Join as Co-Organizer, omits session_id, and sends Google to /o/", () => {
    const tokenPath = "/o/abcdefghijklmnopqrstuvwxyz012345";
    render(<LoginForm next={tokenPath} clubSlug="chillax" />);
    expect(screen.getByRole("button", { name: /join as co-organizer/i })).toBeInTheDocument();
    expect(screen.getByTestId("google-next")).toHaveTextContent(tokenPath);
    const form = screen.getByRole("button", { name: /join as co-organizer/i }).closest("form");
    expect(form?.querySelector('input[name="next"]')).toHaveValue(tokenPath);
    expect(form?.querySelector('input[name="session_id"]')).toBeNull();
  });

  it("LF-13: reconnect with next=/o/ returns to the invite, not player /j/", async () => {
    const tokenPath = "/o/abcdefghijklmnopqrstuvwxyz012345";
    vi.mocked(reconnectPlayer).mockResolvedValue({ success: true });
    const user = userEvent.setup();
    render(<LoginForm next={tokenPath} />);
    await user.click(screen.getByRole("tab", { name: /returning/i }));
    await user.type(screen.getByLabelText(/your name/i), "Miggy");
    await user.type(screen.getByLabelText(/your pin/i), "1234");
    await user.click(screen.getByRole("button", { name: /^reconnect$/i }));
    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledWith(tokenPath);
    });
    expect(replace).not.toHaveBeenCalledWith(expect.stringContaining("/j/"));
    expect(push).not.toHaveBeenCalled();
  });
});
