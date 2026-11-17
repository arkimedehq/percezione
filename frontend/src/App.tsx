import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError, subscribe, UNAUTHORIZED, type Broadcast, type Config, type PerceptionEvent, type Status } from "./api.ts";
import { Cameras } from "./pages/Cameras.tsx";
import { Home } from "./pages/Home.tsx";
import { Sources } from "./pages/Sources.tsx";
import { People, PersonPage } from "./pages/People.tsx";
import { Editor } from "./pages/Editor.tsx";
import { Analyzers } from "./pages/Analyzers.tsx";
import { History } from "./pages/History.tsx";
import { Usage } from "./pages/Usage.tsx";
import { Agents } from "./pages/Agents.tsx";
import { Outputs } from "./pages/Outputs.tsx";
import { Live } from "./pages/Live.tsx";
import { Rules } from "./pages/Rules.tsx";
import { Tuning } from "./pages/Tuning.tsx";
import { Button, Dot, Help, Icon, ICONS, TextInput } from "./ui.tsx";
import { ThemePicker } from "./theme.tsx";
import { LocalePicker, useT, type Messages } from "./i18n/index.tsx";

interface Toast {
  id: number;
  level: "info" | "error";
  text: string;
}

interface AppState {
  /** configuration in effect on the service */
  config: Config;
  /** working copy: changes stay here until saved */
  draft: Config;
  edit(fn: (d: Config) => void): void;
  dirty: boolean;
  status?: Status;
  streams: { name: string; camera: string | null }[];
  navigate(path: string): void;
  /** saves the working copy right away (e.g. a new camera) */
  saveNow(next?: Config): Promise<boolean>;
  notify(level: Toast["level"], text: string): void;
  onEvent(fn: (e: PerceptionEvent) => void): () => void;
}

const Ctx = createContext<AppState | null>(null);
export const useApp = () => useContext(Ctx)!;

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  useEffect(() => {
    api.me().then(() => setAuthed(true), () => setAuthed(false));
    const out = () => setAuthed(false);
    window.addEventListener(UNAUTHORIZED, out);
    return () => window.removeEventListener(UNAUTHORIZED, out);
  }, []);
  if (authed === null) return null;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return <Shell onLogout={() => setAuthed(false)} />;
}

/** The login, or on first start the choice of the password (once: afterwards the server refuses it). */
function Login({ onDone }: { onDone: () => void }) {
  const t = useT();
  const l = t.common.login;
  const [first, setFirst] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.setupState().then((s) => setFirst(!s.password_set), () => setFirst(false));
  }, []);
  if (first === null) return null;
  const problem = first && password ? (password.length < 8 ? l.tooShort : repeat && repeat !== password ? l.mismatch : "") : "";
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <form
        className="flex w-full max-w-sm flex-col gap-5 rounded-2xl border border-line bg-surface p-7"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          (first ? api.setPassword(password) : api.login(password)).then(onDone, (err: ApiError) => {
            setError(err.message);
            setBusy(false);
          });
        }}
      >
        <Brand />
        {first && <p className="m-0 text-sm text-muted">{l.welcome}</p>}
        <label className="flex flex-col gap-1.5 text-[13px] text-muted">
          {l.password}
          <TextInput type="password" autoFocus autoComplete={first ? "new-password" : "current-password"} value={password} onChange={setPassword} />
        </label>
        {first && (
          <label className="flex flex-col gap-1.5 text-[13px] text-muted">
            {l.repeat}
            <TextInput type="password" autoComplete="new-password" value={repeat} onChange={setRepeat} />
          </label>
        )}
        {(problem || error) && <p className="m-0 text-sm text-ko-ink">{problem || error}</p>}
        <Button variant="primary" type="submit" disabled={busy || !password || (first && (!!problem || repeat !== password))}>
          {first ? l.create : l.submit}
        </Button>
        <LocalePicker className="self-end" />
      </form>
    </main>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#7DB4FF" strokeWidth="1.8" aria-hidden="true">
        <circle cx="12" cy="12" r="3.2" />
        <path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
      </svg>
      <span className="font-display text-xl font-semibold">Percezione</span>
    </div>
  );
}

/** Italian paths of the first versions → English ones, so old bookmarks still work. */
const LEGACY_PATHS: [string, string][] = [
  ["/camere/", "/cameras/"],
  ["/regole", "/rules"],
  ["/cronologia", "/history"],
  ["/analizzatori", "/analyzers"],
  ["/utilizzo", "/usage"],
  ["/agenti", "/agents"],
  ["/uscite", "/outputs"],
];

function currentPath(): string {
  const p = location.pathname;
  const legacy = LEGACY_PATHS.find(([from]) => p.startsWith(from));
  if (!legacy) return p;
  const next = legacy[1] + p.slice(legacy[0].length);
  history.replaceState(null, "", next);
  return next;
}

function usePath(): [string, (p: string) => void] {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const on = () => setPath(currentPath());
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  const navigate = useCallback((p: string) => {
    history.pushState(null, "", p);
    setPath(p);
    scrollTo(0, 0);
  }, []);
  return [path, navigate];
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const t = useT();
  const [config, setConfig] = useState<Config>();
  const [draft, setDraft] = useState<Config>();
  const [status, setStatus] = useState<Status>();
  const [streams, setStreams] = useState<AppState["streams"]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [stale, setStale] = useState<number | null>(null);
  const [listeners] = useState(() => new Set<(e: PerceptionEvent) => void>());
  const [path, navigate] = usePath();
  const [menuOpen, setMenuOpen] = useState(false);

  const notify = useCallback((level: Toast["level"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-4), { id, level, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), level === "error" ? 12_000 : 6_000);
  }, []);

  const load = useCallback(async () => {
    const c = await api.config();
    setConfig(c);
    setDraft(c);
    setStale(null);
  }, []);

  useEffect(() => {
    load().catch((e: ApiError) => (e.status === 401 ? onLogout() : notify("error", e.message)));
    api.streams().then(setStreams, () => undefined);
    const poll = () => api.status().then(setStatus, () => setStatus(undefined));
    poll();
    const t = setInterval(poll, 10_000);
    return () => clearInterval(t);
  }, [load, notify, onLogout]);

  // a camera turned on or off: read the status at once and again when Frigate has had time to start or stop it
  useEffect(() => {
    if (!config) return;
    const poll = () => api.status().then(setStatus, () => undefined);
    const timers = [setTimeout(poll, 1_000), setTimeout(poll, 6_000)];
    return () => timers.forEach(clearTimeout);
  }, [config?.version]);

  const dirty = useMemo(() => !!config && !!draft && JSON.stringify(config) !== JSON.stringify(draft), [config, draft]);

  // new versions from the service (by hand, from Frigate, rollback after a refusal): applied if there are no
  // pending changes, otherwise a warning is shown and saving will be refused with 409
  const configRef = useRef(config);
  const draftRef = useRef(draft);
  configRef.current = config;
  draftRef.current = draft;
  useEffect(
    () =>
      subscribe((m: Broadcast) => {
        if (m.type === "event") for (const l of listeners) l(m.event);
        if (m.type === "sync") notify(m.level, m.message);
        if (m.type === "config" && m.version !== configRef.current?.version) {
          void api.config().then((fresh) => {
            const editing = JSON.stringify(draftRef.current) !== JSON.stringify(configRef.current);
            setConfig(fresh);
            if (editing) setStale(fresh.version);
            else setDraft(fresh);
            api.streams().then(setStreams, () => undefined);
          });
        }
      }),
    [listeners, notify],
  );

  const saveNow = useCallback(
    async (next?: Config) => {
      if (!config) return false;
      try {
        await api.save(next ?? draft!, config.version);
        await load();
        api.streams().then(setStreams, () => undefined);
        return true;
      } catch (e) {
        const err = e as ApiError;
        notify("error", err.status === 409 ? err.message : t.common.save.failed(err.errors.join("; ") || err.message));
        return false;
      }
    },
    [config, draft, load, notify, t],
  );

  if (!config || !draft) return null;
  const state: AppState = {
    config,
    draft,
    dirty,
    status,
    streams,
    navigate,
    saveNow,
    notify,
    edit: (fn) =>
      setDraft((d) => {
        const copy = structuredClone(d!);
        fn(copy);
        return copy;
      }),
    onEvent: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };

  const camMatch = path.match(/^\/cameras\/([a-z0-9_]+)/);
  const personMatch = path.match(/^\/people\/([^/]+)/);
  const page = camMatch ? (
    <Editor key={camMatch[1]} name={camMatch[1]!} />
  ) : path.startsWith("/cameras") ? (
    <Cameras />
  ) : personMatch ? (
    <PersonPage key={personMatch[1]} id={decodeURIComponent(personMatch[1]!)} />
  ) : path.startsWith("/people") ? (
    <People />
  ) : path.startsWith("/sources") ? (
    <Sources />
  ) : path.startsWith("/rules") ? (
    <Rules />
  ) : path.startsWith("/live") ? (
    <Live />
  ) : path.startsWith("/history") ? (
    <History />
  ) : path.startsWith("/analyzers") ? (
    <Analyzers />
  ) : path.startsWith("/usage") ? (
    <Usage />
  ) : path.startsWith("/agents") ? (
    <Agents />
  ) : path.startsWith("/outputs") ? (
    <Outputs />
  ) : path.startsWith("/tuning") ? (
    <Tuning />
  ) : (
    <Home />
  );
  const n = t.common.nav;
  const groups: { label: string; items: [string, string, string][] }[] = [
    { label: n.observe, items: [["/", n.home, ICONS.home], ["/live", n.live, ICONS.live]] },
    {
      label: n.configure,
      items: [["/cameras", n.cameras, ICONS.camera], ["/sources", n.sources, ICONS.sources], ["/people", n.people, ICONS.people], ["/rules", n.rules, ICONS.rules], ["/analyzers", n.analyzers, ICONS.analyzers], ["/tuning", n.tuning, ICONS.tuning]],
    },
    { label: n.connect, items: [["/outputs", n.outputs, ICONS.outputs], ["/agents", n.agents, ICONS.agents]] },
    { label: n.system, items: [["/usage", n.usage, ICONS.usage], ["/history", n.history, ICONS.versions]] },
  ];
  const section = groups.flatMap((g) => g.items.map(([href]) => href)).filter((h) => h !== "/").find((h) => path.startsWith(h)) ?? "/";

  return (
    <Ctx.Provider value={state}>
      <div className="flex min-h-screen flex-col md:flex-row">
        {/* phone: a top bar with the menu button; from md up the menu is always on the side */}
        <div className="sticky top-0 z-40 flex items-center justify-between border-b border-line bg-ground/95 px-4 py-2.5 backdrop-blur md:hidden">
          <Brand />
          <Button variant="ghost" aria-expanded={menuOpen} aria-controls="main-nav" aria-label={n.menu} onClick={() => setMenuOpen((o) => !o)} className="w-11 px-0">
            <Icon d={menuOpen ? ICONS.close : ICONS.menu} />
          </Button>
        </div>
        <nav
          id="main-nav"
          aria-label={n.label}
          className={`${menuOpen ? "flex" : "hidden"} w-full flex-col gap-5 border-b border-line bg-ground px-4 py-5 md:sticky md:top-0 md:flex md:h-screen md:w-[240px] md:shrink-0 md:overflow-y-auto md:border-r md:border-b-0 md:px-5 md:py-7`}
        >
          <div className="hidden px-2 md:block">
            <Brand />
          </div>
          {groups.map((g) => (
            <div key={g.label} className="flex flex-col gap-0.5">
              <span className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-dim">{g.label}</span>
              {g.items.map(([href, label, icon]) => (
                <a
                  key={href}
                  href={href}
                  onClick={(e) => {
                    e.preventDefault();
                    setMenuOpen(false);
                    navigate(href);
                  }}
                  aria-current={section === href ? "page" : undefined}
                  className={`flex min-h-10 items-center gap-3 rounded-[10px] px-3 no-underline ${section === href ? "bg-selected font-medium text-ink" : "text-muted hover:bg-raised hover:text-ink"}`}
                >
                  <Icon d={icon} />
                  {label}
                </a>
              ))}
            </div>
          ))}
          <div className="mt-auto flex flex-col gap-3 pt-2">
            <div className="rounded-xl border border-line bg-surface px-3 py-3 text-[13px] leading-relaxed text-muted">
              <div className="flex items-center gap-2 font-medium text-ink">
                <Dot color={status ? "ok" : "ko"} />
                {status ? t.common.shell.frigate(status.frigate.version.split("-")[0]!) : t.common.shell.frigateDown}
              </div>
              {t.common.shell.configVersion(config.version)}
              {status?.frigate.ui_port && (
                // Frigate's own UI, behind the same login (perception-service/src/frigate-proxy.ts)
                <a href={`${location.protocol}//${location.hostname}:${status.frigate.ui_port}/`} target="_blank" rel="noreferrer" className="mt-1 block text-accent-ink underline-offset-2 hover:underline">
                  {t.common.shell.openFrigate}
                </a>
              )}
            </div>
            <div className="flex flex-col gap-2 px-3">
              <LocalePicker />
              <ThemePicker />
            </div>
            <Button variant="ghost" onClick={() => api.logout().then(onLogout)}>
              {t.common.shell.logout}
            </Button>
          </div>
        </nav>
        <main className={`min-w-0 flex-1 px-4 pt-6 md:px-10 md:pt-8 ${dirty ? "pb-40" : "pb-12"}`}>{page}</main>
      </div>
      {dirty && <SaveBar stale={stale} onReload={load} />}
      <div aria-live="polite" className={`fixed right-4 z-50 flex w-[min(420px,calc(100vw-32px))] flex-col gap-2 ${dirty ? "bottom-32" : "bottom-4"}`}>
        {toasts.map((t) => (
          <div key={t.id} className={`rounded-xl border px-4 py-3 text-sm shadow-lg ${t.level === "error" ? "border-ko/50 bg-ko-soft text-ko-ink" : "border-line-strong bg-surface text-ink"}`}>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

/** Parts changed between two configurations, for the save bar. */
export function changedParts(a: Config, b: Config, t: Messages): string[] {
  const out: string[] = [];
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  for (const name of new Set([...Object.keys(a.cameras), ...Object.keys(b.cameras)])) {
    const x = a.cameras[name];
    const y = b.cameras[name];
    if (!x) out.push(t.common.save.part.newCamera(name));
    else if (!y) out.push(t.common.save.part.removedCamera(name));
    else for (const k of new Set([...Object.keys(x), ...Object.keys(y)]) as Set<keyof typeof x>) if (!same(x[k], y[k])) out.push(`${name}/${k}`);
  }
  if (!same(a.rules, b.rules)) out.push(t.common.save.part.rules);
  if (!same(a.analyzers, b.analyzers)) out.push(t.common.save.part.vlm);
  if (!same(a.outputs, b.outputs)) out.push(t.common.save.part.outputs);
  if (!same(a.sources, b.sources)) out.push(t.common.save.part.sources);
  if (!same(a.restream, b.restream)) out.push(t.common.save.part.streams);
  if (!same(a.groups, b.groups)) out.push(t.common.save.part.groups);
  if (!same(a.faces, b.faces)) out.push(t.common.save.part.faces);
  if (!same(a.tuning, b.tuning)) out.push(t.common.save.part.tuning);
  return out;
}

function SaveBar({ stale, onReload }: { stale: number | null; onReload: () => Promise<void> }) {
  const { config, draft, saveNow } = useApp();
  const t = useT();
  const [preview, setPreview] = useState<{ ok: boolean; errors: string[]; frigate?: string[]; frigateDown?: boolean }>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => api.preview(draft).then(setPreview, (e: ApiError) => setPreview({ ok: false, errors: e.errors })), 400);
    return () => clearTimeout(t);
  }, [draft]);
  const parts = changedParts(config, draft, t);
  return (
    <footer className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 px-4 py-4 backdrop-blur md:pl-[260px]">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1 text-[13px]">
          <span className="font-semibold">
            {t.common.save.pending(parts.length)}: <span className="font-normal text-muted">{parts.join(" · ")}</span>
          </span>
          {stale !== null && <span className="text-amber-ink">{t.common.save.stale(stale)}</span>}
          {preview && !preview.ok && <span className="text-ko-ink">{preview.errors.join(" · ")}</span>}
          {preview?.ok && <span className="text-muted">{preview.frigateDown ? t.common.save.frigateLater : preview.frigate?.length ? t.common.save.toFrigate(preview.frigate.join(", ")) : t.common.save.nothingForFrigate}</span>}
        </div>
        <div className="flex gap-2.5">
          <Button onClick={() => void onReload()}>{stale !== null ? t.common.save.reload : t.common.save.cancel}</Button>
          <Button
            variant="primary"
            disabled={busy || !preview?.ok || stale !== null}
            onClick={() => {
              setBusy(true);
              void saveNow().finally(() => setBusy(false));
            }}
          >
            {t.common.save.apply}
          </Button>
        </div>
      </div>
    </footer>
  );
}

/** A page title, a one-line subtitle, an optional help popover for the details, and the page's actions. */
export function PageHeader({ title, subtitle, help, actions }: { title: string; subtitle?: ReactNode; help?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-3">
          <h1 className="m-0 font-display text-[32px] font-semibold">{title}</h1>
          {help && <Help label={title}>{help}</Help>}
        </div>
        {subtitle && <p className="m-0 text-[15px] text-muted">{subtitle}</p>}
      </div>
      {actions}
    </header>
  );
}
