"use client";

import { SKILL_LEVELS, type SkillLevel } from "@/types/database";
import { SKILL_COLORS } from "@/lib/skill-picker-styles";

interface SkillLevelPickerProps {
  value: SkillLevel;
  onChange: (level: SkillLevel) => void;
  disabled?: boolean;
  /** Native <select> for registration; cards remain the default elsewhere. */
  compact?: boolean;
  describedBy?: string;
  invalid?: boolean;
}

export function SkillLevelPicker({
  value,
  onChange,
  disabled,
  compact,
  describedBy,
  invalid,
}: SkillLevelPickerProps) {
  if (compact) {
    const hintId = "skill_level_hint";
    const described = [describedBy, hintId].filter(Boolean).join(" ");
    return (
      <div className="space-y-1.5">
        <label htmlFor="skill_level" className="block text-sm font-semibold text-foreground">
          Skill level
        </label>
        <select
          id="skill_level"
          name="skill_level"
          value={value}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={described}
          onChange={(e) => onChange(e.target.value as SkillLevel)}
          className="min-h-11 w-full rounded-lg border border-input bg-background px-3 py-2
                     text-base focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2
                     disabled:opacity-50"
        >
          {SKILL_LEVELS.map((level) => (
            <option key={level.value} value={level.value}>
              {level.label}: {SKILL_COLORS[level.value].descriptor}
            </option>
          ))}
        </select>
        <p id={hintId} className="text-xs text-cc-t2">
          Not sure? Leave Beginner. You can change this later.
        </p>
      </div>
    );
  }

  return (
    <fieldset className="space-y-2 border-0 p-0 m-0">
      <legend className="block text-sm font-semibold text-foreground">Skill level</legend>
      <div className={`grid grid-cols-2 gap-2 ${disabled ? "pointer-events-none opacity-50" : ""}`}>
        {SKILL_LEVELS.map((level) => {
          const colors = SKILL_COLORS[level.value];
          const isSelected = value === level.value;
          return (
            <label
              key={level.value}
              className={`relative flex min-h-[56px] cursor-pointer flex-col justify-center
                          gap-0.5 rounded-lg border-2 px-3 py-2.5 transition-colors
                          ${isSelected ? colors.active : colors.idle}`}
            >
              <input
                type="radio"
                name="skill_level_radio"
                value={level.value}
                checked={isSelected}
                onChange={() => onChange(level.value)}
                disabled={disabled}
                className="sr-only"
              />
              <span
                className={`absolute right-2.5 top-2.5 h-1.5 w-1.5 rounded-full ${colors.dot}`}
                aria-hidden="true"
              />
              <span className="text-sm font-semibold leading-tight text-foreground">
                {level.label}
              </span>
              <span className="text-xs leading-snug text-muted-foreground">
                {colors.descriptor}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
