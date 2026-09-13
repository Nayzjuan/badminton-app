"use client";

import { SKILL_LEVELS, type SkillLevel } from "@/types/database";
import { SKILL_COLORS } from "@/lib/skill-picker-styles";

interface SkillLevelPickerProps {
  value: SkillLevel;
  onChange: (level: SkillLevel) => void;
  disabled?: boolean;
}

export function SkillLevelPicker({ value, onChange, disabled }: SkillLevelPickerProps) {
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
