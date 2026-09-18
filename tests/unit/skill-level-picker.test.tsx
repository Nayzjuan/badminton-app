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
    const select = screen.getByLabelText(/^skill level$/i);
    expect(select).toHaveAttribute("name", "skill_level");
    expect([...select.querySelectorAll("option")].map((o) => o.value)).toEqual(
      SKILL_LEVELS.map((l) => l.value)
    );
  });

  it("submits each enum value through onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SkillLevelPicker compact value="beginner" onChange={onChange} />);
    const select = screen.getByLabelText(/^skill level$/i);
    await user.selectOptions(select, "advanced");
    expect(onChange).toHaveBeenCalledWith("advanced");
  });

  it("puts descriptors on the options and a hint, not a second tap target", () => {
    const { container } = render(
      <SkillLevelPicker compact value="beginner" onChange={() => undefined} />
    );
    const select = screen.getByLabelText(/^skill level$/i);
    expect(select.textContent).toMatch(/just starting out/i);
    expect(select.textContent).toMatch(/tournament level/i);
    expect(screen.getByText(/not sure\? leave beginner/i)).toBeInTheDocument();
    expect(screen.queryByText(/what do the 6 levels mean/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(container.querySelector("summary")).toBeNull();
    expect(container.querySelector("details")).toBeNull();
  });

  it("disables the select while pending without losing the value", () => {
    render(<SkillLevelPicker compact value="intermediate" onChange={() => undefined} disabled />);
    expect(screen.getByLabelText(/^skill level$/i)).toBeDisabled();
    expect(screen.getByLabelText(/^skill level$/i)).toHaveValue("intermediate");
  });

  it("gives each compact picker unique ids so two can mount in one document", () => {
    render(
      <>
        <SkillLevelPicker compact value="beginner" onChange={() => undefined} />
        <SkillLevelPicker compact value="advanced" onChange={() => undefined} />
      </>
    );
    const selects = screen.getAllByLabelText(/^skill level$/i);
    expect(selects).toHaveLength(2);
    expect(selects[0].id).not.toBe(selects[1].id);
    expect(selects[0].getAttribute("aria-describedby")).not.toBe(
      selects[1].getAttribute("aria-describedby")
    );
    expect(document.querySelectorAll("[id$='-hint']")).toHaveLength(2);
  });

  it("points aria-describedby at the error only, not the hint as well", () => {
    render(
      <>
        <SkillLevelPicker
          compact
          value="beginner"
          onChange={() => undefined}
          invalid
          describedBy="skill_level_error"
        />
        <p id="skill_level_error">Pick a skill level</p>
      </>
    );
    expect(screen.getByLabelText(/^skill level$/i)).toHaveAttribute(
      "aria-describedby",
      "skill_level_error"
    );
  });
});
