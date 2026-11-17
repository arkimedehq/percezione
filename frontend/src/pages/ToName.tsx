import { useCallback, useEffect, useState } from "react";
import { api, ApiError, faceUrl, type AttemptGroup } from "../api.ts";
import { useApp } from "../App.tsx";
import { dateTime, decimal, humanize, place as placeName } from "../i18n/format.ts";
import { useLocale, useT } from "../i18n/index.tsx";
import { Button, ConfirmButton, EmptyState, Help, helpText, Switch, TextInput } from "../ui.tsx";

/** Faces picked by default: a few, not all (Frigate's guide: not many similar faces at once). */
const PICK = 3;
const SHOWN = 8;

/**
 * "To name": the faces Frigate saw but could not name, one card per passage (a Frigate event is one person). Naming
 * a passage adds the chosen faces to that person, the strongest teaching there is: the camera's own light and angle.
 */
export function ToName({ people, onChanged }: { people: string[]; onChanged(): void }) {
  const t = useT();
  const n = t.people.toName;
  const [groups, setGroups] = useState<AttemptGroup[]>();
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);

  const load = useCallback(
    () =>
      api.unknown(all).then(
        (g) => (setGroups(g), setError(null)),
        (e: ApiError) => setError(e.message),
      ),
    [all],
  );
  useEffect(() => void load(), [load]);
  const done = (event: string) => {
    setGroups((g) => g?.filter((x) => x.event !== event));
    onChanged();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 flex items-center gap-2 text-sm text-muted">
          {n.intro}
          <Help label={n.title}>{helpText(n.help)}</Help>
        </p>
        <label className="flex items-center gap-2.5 text-[13px] text-muted">
          <Switch checked={all} onChange={setAll} label={n.showRecognized} />
          {n.showRecognized}
        </label>
      </div>
      <datalist id="people-names">
        {people.map((p) => (
          <option key={p} value={humanize(p)} />
        ))}
      </datalist>
      {error ? (
        <EmptyState title={t.people.unavailable} text={t.people.unavailableText(error)} action={<Button onClick={() => void load()}>{t.people.retry}</Button>} />
      ) : groups && groups.length === 0 ? (
        <EmptyState title={n.empty} text={n.emptyText} />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {groups?.map((g) => <Passage key={g.event} group={g} onDone={() => done(g.event)} />)}
        </ul>
      )}
    </div>
  );
}

function Passage({ group: g, onDone }: { group: AttemptGroup; onDone(): void }) {
  const t = useT();
  const n = t.people.toName;
  const { locale } = useLocale();
  const { notify } = useApp();
  const shown = g.attempts.slice(0, SHOWN);
  const [picked, setPicked] = useState(() => new Set(shown.slice(0, PICK).map((a) => a.file)));
  const [who, setWho] = useState(g.best ? humanize(g.best.name) : "");
  const [busy, setBusy] = useState(false);
  const fail = (e: ApiError) => (notify("error", e.message), setBusy(false));
  const toggle = (file: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });

  return (
    <li className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <span className="font-medium">{g.place ? placeName(t, g.place) : n.unknownCamera}</span>
        {g.camera && g.camera !== g.place && <span className="text-dim">{humanize(g.camera)}</span>}
        <span className="text-muted">{dateTime(locale, g.ts)}</span>
        <span className={g.best ? "text-muted" : "text-dim"}>{g.best ? n.guess(humanize(g.best.name), decimal(locale, g.best.score * 100, 0)) : n.noGuess}</span>
      </div>
      <div role="group" aria-label={n.pick} className="flex flex-wrap gap-2">
        {shown.map((a) => {
          const on = picked.has(a.file);
          return (
            <button
              key={a.file}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(a.file)}
              title={a.name ? `${humanize(a.name)} ${decimal(locale, a.score * 100, 0)}%` : `${decimal(locale, a.score * 100, 0)}%`}
              className={`relative h-20 w-20 overflow-hidden rounded-lg border-2 bg-raised ${on ? "border-accent" : "border-transparent opacity-60 hover:opacity-100"}`}
            >
              <img src={faceUrl("train", a.file)} alt="" loading="lazy" className="h-full w-full object-cover" />
              {on && <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-[11px] font-bold text-on-accent">✓</span>}
            </button>
          );
        })}
        {g.attempts.length > SHOWN && <span className="self-center text-xs text-dim">{n.more(g.attempts.length - SHOWN)}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted">{n.itIs}</span>
        <TextInput value={who} onChange={setWho} list="people-names" placeholder={n.namePlaceholder} aria-label={n.itIs} className="max-w-[240px]" />
        <Button
          variant="primary"
          disabled={busy || !who.trim() || picked.size === 0}
          onClick={() => {
            setBusy(true);
            api.assignAttempts([...picked], who).then(
              (r) => (notify("info", n.assigned(picked.size, humanize(r.id))), onDone()),
              fail,
            );
          }}
        >
          {n.assign(picked.size)}
        </Button>
        <span className="ml-auto">
          <ConfirmButton
            confirm={n.discardConfirm}
            onConfirm={() => {
              setBusy(true);
              api.discardAttempts(g.attempts.map((a) => a.file)).then(onDone, fail);
            }}
          >
            {n.discard}
          </ConfirmButton>
        </span>
      </div>
    </li>
  );
}
