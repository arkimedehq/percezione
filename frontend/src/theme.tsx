import { useEffect, useState } from "react";
import { useT } from "./i18n/index.tsx";

/** "system" follows the device; the choice is per viewer, in this browser (index.html applies it before the first paint). */
export type Theme = "system" | "light" | "dark";
const KEY = "percezione.theme";

function saved(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function apply(theme: Theme): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

export function ThemePicker({ className = "" }: { className?: string }) {
  const t = useT();
  const [theme, setTheme] = useState<Theme>(saved);
  useEffect(() => {
    apply(theme);
    try {
      if (theme === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, theme);
    } catch {
      // not remembered: the choice still holds for this visit
    }
  }, [theme]);
  return (
    <label className={`flex items-center gap-2 text-[13px] text-muted ${className}`}>
      <span>{t.common.theme.label}</span>
      <select
        value={theme}
        onChange={(e) => setTheme(e.target.value as Theme)}
        className="min-h-9 rounded-lg border border-line-strong bg-ground px-2 text-[13px] text-ink"
      >
        {(["system", "light", "dark"] as const).map((v) => (
          <option key={v} value={v}>
            {t.common.theme[v]}
          </option>
        ))}
      </select>
    </label>
  );
}
