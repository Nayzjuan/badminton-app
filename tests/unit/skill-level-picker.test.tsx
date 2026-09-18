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
    const ids = selects.map((el) => el.id);
    const describedIds = selects.map((el) => el.getAttribute("aria-describedby"));
    expect(ids.every((id) => id && id !== "skill_level")).toBe(true);
    expect(new Set(ids).size).toBe(2);
    expect(describedIds.every((id) => id && id !== "skill_level_hint")).toBe(true);
    expect(new Set(describedIds).size).toBe(2);
    const hints = describedIds.map((id) => {
      const hint = document.getElementById(id!);
      expect(hint).not.toBeNull();
      expect(hint).toHaveTextContent(/not sure\? leave beginner/i);
      return hint;
    });
    expect(hints[0]).not.toBe(hints[1]);
  });

  it("describes a valid compact select with its own hint, not a static id", () => {
    render(<SkillLevelPicker compact value="beginner" onChange={() => undefined} />);
    const select = screen.getByLabelText(/^skill level$/i);
    expect(select).not.toHaveAttribute("aria-invalid");
    const hintId = select.getAttribute("aria-describedby");
    expect(hintId).toBeTruthy();
    expect(hintId).not.toBe("skill_level_hint");
    expect(document.getElementById(hintId!)).toHaveTextContent(/not sure\? leave beginner/i);
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
    const select = screen.getByLabelText(/^skill level$/i);
    expect(select).toHaveAttribute("aria-invalid", "true");
    expect(select.getAttribute("aria-describedby")?.split(/\s+/)).toEqual(["skill_level_error"]);
    const hint = screen.getByText(/not sure\? leave beginner/i);
    expect(hint.id).toBeTruthy();
    expect(hint.id).not.toBe("skill_level_error");
  });
});
