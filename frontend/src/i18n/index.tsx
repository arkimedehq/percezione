import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { en, type Messages } from "./en/index.ts";
import { it } from "./it/index.ts";

/**
 * The interface's languages. English is the source: every other dictionary has its exact shape (the type checker
 * reports a missing or extra key). Adding a language: copy `it/`, translate it, register it here.
 */
export const LOCALES = {
  en: { name: "English", messages: en },
  it: { name: "Italiano", messages: it },
} satisfies Record<string, { name: string; messages: Messages }>;

export type Locale = keyof typeof LOCALES;
export type { Messages };

const STORAGE_KEY = "percezione.locale";

const isLocale = (l: string | null | undefined): l is Locale => !!l && l in LOCALES;

/** The saved choice, else the first browser language we have, else English. */
function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    // storage blocked: fall through to the browser's languages
  }
  for (const l of navigator.languages ?? [navigator.language]) {
    const base = l.toLowerCase().split("-")[0];
    if (isLocale(base)) return base;
  }
  return "en";
}

interface I18n {
  locale: Locale;
  setLocale(l: Locale): void;
  t: Messages;
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, set] = useState<Locale>(initialLocale);
  const setLocale = useCallback((l: Locale) => {
    set(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // not remembered: the choice still holds for this visit
    }
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const value = useMemo(() => ({ locale, setLocale, t: LOCALES[locale].messages }), [locale, setLocale]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The messages of the current language: `const t = useT(); t.nav.cameras`. */
export function useT(): Messages {
  return useContext(Ctx)!.t;
}

export function useLocale(): Pick<I18n, "locale" | "setLocale"> {
  const { locale, setLocale } = useContext(Ctx)!;
  return { locale, setLocale };
}

/** A language picker: one entry per registered dictionary, each in its own language. */
export function LocalePicker({ className = "" }: { className?: string }) {
  const { locale, setLocale } = useLocale();
  const t = useT();
  return (
    <label className={`flex items-center gap-2 text-[13px] text-muted ${className}`}>
      <span>{t.common.language}</span>
      <select
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
        className="min-h-9 rounded-lg border border-line-strong bg-ground px-2 text-[13px] text-ink"
      >
        {(Object.keys(LOCALES) as Locale[]).map((l) => (
          <option key={l} value={l}>
            {LOCALES[l].name}
          </option>
        ))}
      </select>
    </label>
  );
}
