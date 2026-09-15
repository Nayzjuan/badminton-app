// @vitest-environment happy-dom
// ============================================================
// SkillLevelPicker — compact six-level native select
// ============================================================

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SkillLevelPicker } from "@/components/player/skill-level-picker";
import { SKILL_LEVELS } from "@/types/database";

describe("SkillLevelPicker compact", () => {
  it("exposes all six levels as a single skill_level field", () => {
    render(<SkillLevelPicker compact value="beginner" onChange={() => undefined} />);
    const select = screen.getByLabelText(/skill level — 6 choices/i);
    expect(select).toHaveAttribute("name", "skill_level");
    expect([...select.querySelectorAll("option")].map((o) => o.value)).toEqual(
      SKILL_LEVELS.map((l) => l.value)
    );
  });

  it("submits each enum value through onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SkillLevelPicker compact value="beginner" onChange={onChange} />);
    const select = screen.getByLabelText(/skill level — 6 choices/i);
    await user.selectOptions(select, "advanced");
    expect(onChange).toHaveBeenCalledWith("advanced");
  });

  it("lists all six descriptors without hover", async () => {
    const user = userEvent.setup();
    render(<SkillLevelPicker compact value="beginner" onChange={() => undefined} />);
    await user.click(screen.getByText(/what do the 6 levels mean/i));
    expect(screen.getAllByText(/just starting out/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/tournament level/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/not sure/i)).toBeInTheDocument();
  });

  it("disables the select while pending without losing the value", () => {
    render(<SkillLevelPicker compact value="intermediate" onChange={() => undefined} disabled />);
    expect(screen.getByLabelText(/skill level — 6 choices/i)).toBeDisabled();
    expect(screen.getByLabelText(/skill level — 6 choices/i)).toHaveValue("intermediate");
  });
});
