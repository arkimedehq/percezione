import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { useT } from "./i18n/index.tsx";
import { playMse, supportsMse } from "./mse.ts";

/** Shared components, in the prototype's style (dark theme, 44 px targets). */

type Variant = "primary" | "secondary" | "ghost" | "danger" | "soft";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-on-accent font-semibold hover:bg-accent-strong",
  secondary: "border border-line-strong text-ink hover:bg-raised",
  ghost: "text-muted hover:bg-raised hover:text-ink",
  danger: "border border-ko/60 text-ko-ink hover:bg-ko-soft",
  soft: "border border-accent bg-accent-soft text-accent-ink hover:bg-accent-soft-strong",
};

export function Button({ variant = "secondary", className = "", ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...p}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] px-4 text-[15px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
    />
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`flex h-7 w-12 shrink-0 rounded-full p-[3px] transition-colors ${checked ? "justify-end bg-accent" : "justify-start bg-line-strong"}`}
    >
      <span className="h-[22px] w-[22px] rounded-full bg-[#f5f7fa]" />
    </button>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-line bg-surface ${className}`}>{children}</div>;
}

const inputCls = "min-h-11 w-full rounded-[10px] border border-line-strong bg-ground px-3 text-[15px] text-ink placeholder:text-dim";

/** A form field: label, control, an optional one-line hint and an optional help popover for the details. */
export function Field({ label, hint, help, children }: { label: string; hint?: string; help?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-[13px] text-muted">
      <span className="flex items-center gap-1.5">
        {label}
        {help && <Help label={label}>{help}</Help>}
      </span>
      {children}
      {hint && <span className="text-xs text-dim">{hint}</span>}
    </label>
  );
}

export function TextInput(p: Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange"> & { onChange: (v: string) => void }) {
  const { onChange, className = "", ...rest } = p;
  return <input {...rest} className={`${inputCls} ${className}`} onChange={(e) => onChange(e.target.value)} />;
}

export function NumberInput({
  value,
  onChange,
  min,
  step = 1,
  placeholder,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  min?: number;
  step?: number;
  placeholder?: string;
}) {
  return (
    <input
      type="number"
      className={inputCls}
      value={value ?? ""}
      min={min}
      step={step}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
    />
  );
}

export function Select<T extends string>({ value, options, onChange }: { value: T; options: readonly (T | [T, string])[]; onChange: (v: T) => void }) {
  return (
    <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => {
        const [v, l] = Array.isArray(o) ? o : [o, o];
        return (
          <option key={v} value={v}>
            {l}
          </option>
        );
      })}
    </select>
  );
}

/** Multiple choice as chips. */
export function Chips({ options, value, onChange, label, labels }: { options: readonly string[]; value: string[]; onChange: (v: string[]) => void; label: string; labels?: Record<string, string> }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((o) => {
        const on = value.includes(o);
        return (
          <button
            key={o}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== o) : [...value, o])}
            className={`min-h-10 rounded-full border px-3.5 text-sm ${on ? "border-accent bg-accent-soft text-accent-ink" : "border-line-strong text-muted hover:text-ink"}`}
          >
            {labels?.[o] ?? o.replaceAll("_", " ")}
          </button>
        );
      })}
    </div>
  );
}

export function Dot({ color }: { color: "ok" | "ko" | "amber" | "dim" }) {
  const c = { ok: "bg-ok", ko: "bg-ko", amber: "bg-amber", dim: "bg-dim" }[color];
  return <span aria-hidden="true" className={`inline-block h-2 w-2 shrink-0 rounded-full ${c}`} />;
}

export function Icon({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
export const ICONS = {
  plus: "M12 5v14M5 12h14",
  close: "M6 6l12 12M18 6L6 18",
  back: "M15 5l-7 7 7 7",
  up: "M6 15l6-6 6 6",
  down: "M6 9l6 6 6-6",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  home: "M3 11l9-7 9 7M5 10v10h5v-6h4v6h5V10",
  live: "M4.9 19.1a10 10 0 010-14.2M19.1 4.9a10 10 0 010 14.2M7.8 16.2a6 6 0 010-8.4M16.2 7.8a6 6 0 010 8.4M12 12h.01",
  camera: "M3 7h12v10H3zM15 10l6-3v10l-6-3",
  people: "M9 11a4 4 0 100-8 4 4 0 000 8zM2 21v-1a6 6 0 0112 0v1M16 3.5a4 4 0 010 7M22 21v-1a6 6 0 00-4-5.6",
  sources: "M4 6h16v5H4zM4 13h16v5H4zM7 8.5h.01M7 15.5h.01M11 8.5h6M11 15.5h6",
  cameraOff: "M3 3l18 18M15 10l6-3v10l-6-3M9 7h6v6M3 7h2v10h10",
  rules: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4",
  analyzers: "M8 8h8v8H8zM4 10h2M4 14h2M18 10h2M18 14h2M10 4v2M14 4v2M10 18v2M14 18v2",
  outputs: "M4 12h10M10 6l6 6-6 6M20 4v16",
  agents: "M12 3v3M7 8h10a2 2 0 012 2v7a2 2 0 01-2 2H7a2 2 0 01-2-2v-7a2 2 0 012-2zM9.5 13h.01M14.5 13h.01M9 16.5h6",
  usage: "M4 20h16M7 16V10M12 16V5M17 16v-4",
  tuning: "M4 6h8M16 6h4M4 12h2M10 12h10M4 18h12M20 18h0M14 4v4M8 10v4M18 16v4",
  versions: "M12 8v4l3 2M3.5 12a8.5 8.5 0 101.8-5.2M3 4v4h4",
  menu: "M4 7h16M4 12h16M4 17h16",
};

/**
 * A "?" next to a title or a field: the explanation opens on demand instead of filling the page. Closes on a second
 * tap, a tap elsewhere or Escape; opens towards the side with more room.
 */
export function Help({ children, label }: { children: ReactNode; label?: string }) {
  const t = useT();
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState<null | "left" | "right">(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(null);
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <span ref={ref} className="relative inline-flex align-middle">
      <button
        type="button"
        aria-expanded={!!open}
        aria-controls={id}
        aria-label={label ? t.common.helpAbout(label) : t.common.help}
        onClick={(e) => {
          // inside a <label>: do not focus the control
          e.preventDefault();
          const x = e.currentTarget.getBoundingClientRect().left;
          setOpen((o) => (o ? null : x > window.innerWidth / 2 ? "right" : "left"));
        }}
        className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[12px] font-semibold leading-none transition-colors ${open ? "border-accent bg-accent-soft text-accent-ink" : "border-line-strong text-muted hover:border-accent hover:text-ink"}`}
      >
        ?
      </button>
      {open && (
        <span
          id={id}
          role="note"
          className={`absolute top-full z-30 mt-2 block w-[min(360px,calc(100vw-40px))] rounded-xl border border-line-strong bg-raised p-3.5 text-left text-[13px] font-normal normal-case leading-relaxed tracking-normal text-ink shadow-xl ${open === "right" ? "right-0" : "left-0"}`}
        >
          {children}
        </span>
      )}
    </span>
  );
}

/** Text between backticks becomes code: names the user types or sees elsewhere (topics, headers, commands). */
export function withCode(text: string): ReactNode {
  return text.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));
}

/** Help text from a dictionary: one paragraph per entry. */
export function helpText(text: string | readonly string[]): ReactNode {
  return [text].flat().map((x, i) => (
    <span key={i} className={`block ${i ? "mt-2" : ""}`}>
      {withCode(x)}
    </span>
  ));
}

/** A short bullet list inside a help popover. */
export function HelpList({ items }: { items: readonly string[] }) {
  return (
    <span className="mt-1.5 flex flex-col gap-1">
      {items.map((x) => (
        <span key={x} className="block pl-3 -indent-3">
          • {withCode(x)}
        </span>
      ))}
    </span>
  );
}

/** What a page or a list shows when there is nothing yet: what it is for and the first thing to do. */
export function EmptyState({ title, text, action }: { title: string; text?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-2xl border border-dashed border-line-strong px-6 py-7">
      <p className="m-0 text-[15px] font-medium text-ink">{title}</p>
      {text && <p className="m-0 max-w-[60ch] text-sm leading-relaxed text-muted">{text}</p>}
      {action}
    </div>
  );
}

/** Copies to the clipboard and says so for a moment. */
export function CopyButton({ text, label }: { text: string; label?: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  return (
    <Button
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 2_000);
        })
      }
    >
      {done ? t.common.copied : (label ?? t.common.copy)}
    </Button>
  );
}

/** Two-step button for destructive actions (no browser confirm dialogs). */
export function ConfirmButton({ children, confirm, onConfirm }: { children: ReactNode; confirm: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4_000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Button variant="danger" onClick={() => (armed ? onConfirm() : setArmed(true))}>
      {armed ? confirm : children}
    </Button>
  );
}

/**
 * Live video of a go2rtc stream. Without MSE (or if the video drops) it shows a still frame every 2 s.
 * `children` sits over the video (zones, labels), in the same proportions.
 */
export function LiveVideo({ stream, camera, aspect, children }: { stream?: string; camera?: string; aspect: number; children?: ReactNode }) {
  const ref = useRef<HTMLVideoElement>(null);
  const t = useT();
  const [failed, setFailed] = useState<string | null>(null);
  const [noImage, setNoImage] = useState(false);
  const [tick, setTick] = useState(0);
  const useVideo = !!stream && supportsMse() && !failed;

  useEffect(() => {
    if (!useVideo || !ref.current) return;
    return playMse(ref.current, stream!, setFailed);
  }, [stream, useVideo]);
  useEffect(() => {
    if (useVideo) return;
    const t = setInterval(() => setTick((x) => x + 1), 2_000);
    return () => clearInterval(t);
  }, [useVideo]);
  // after a failure, still frames for a while, then the video again
  useEffect(() => {
    if (!failed) return;
    const t = setTimeout(() => setFailed(null), 15_000);
    return () => clearTimeout(t);
  }, [failed]);

  const still = stream ? `/api/streams/${encodeURIComponent(stream)}/frame.jpg` : camera ? `/api/cameras/${camera}/frame.jpg` : undefined;
  return (
    <div className="relative w-full overflow-hidden bg-video" style={{ aspectRatio: aspect }}>
      {useVideo ? (
        // the still frame stays visible until the first video frame arrives
        <video ref={ref} muted playsInline autoPlay poster={still} className="absolute inset-0 h-full w-full object-fill" />
      ) : (
        still && (
          <img
            src={`${still}?t=${tick}`}
            alt=""
            onLoad={() => setNoImage(false)}
            onError={() => setNoImage(true)}
            className={`absolute inset-0 h-full w-full object-fill ${noImage ? "invisible" : ""}`}
          />
        )
      )}
      {(!still || (noImage && !useVideo)) && (
        // the area is dark in both themes: fixed light text on it
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/55">
          <Icon d={ICONS.cameraOff} size={28} />
          <span className="text-[13px]">{t.common.video.noImage}</span>
        </span>
      )}
      {failed && <span className="absolute bottom-2 left-2 rounded-md bg-ground/80 px-2 py-1 text-xs text-muted">{t.common.video.stills(failed)}</span>}
      {children}
    </div>
  );
}
