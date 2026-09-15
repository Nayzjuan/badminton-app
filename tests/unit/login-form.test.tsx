// @vitest-environment happy-dom
// ============================================================
// LoginForm — contextual CTAs, compact skill, returning form
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
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

  it("LF-3: compact picker lists all six levels", () => {
    render(<LoginForm />);
    const select = screen.getByLabelText(/skill level — 6 choices/i);
    expect(select.querySelectorAll("option")).toHaveLength(6);
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

  it("LF-6: Returning is a real form; Enter with incomplete input does not reconnect", async () => {
    const user = userEvent.setup();
    render(<LoginForm />);
    await user.click(screen.getByRole("tab", { name: /returning/i }));
    await user.type(screen.getByLabelText(/your name/i), "Al");
    await user.keyboard("{Enter}");
    expect(reconnectPlayer).not.toHaveBeenCalled();
    expect(await screen.findAllByRole("alert")).not.toHaveLength(0);
  });

  it("LF-7: tabs expose aria-controls to matching tabpanels", () => {
    render(<LoginForm />);
    expect(screen.getByRole("tab", { name: /new player/i })).toHaveAttribute(
      "aria-controls",
      "panel-new"
    );
    expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "panel-new");
  });
});
