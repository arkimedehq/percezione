import { useCallback, useEffect, useRef, useState } from "react";
import { ToName } from "./ToName.tsx";
import { api, ApiError, faceUrl, type PersonInfo } from "../api.ts";
import { PageHeader, useApp } from "../App.tsx";
import { dateTime, humanize } from "../i18n/format.ts";
import { useLocale, useT } from "../i18n/index.tsx";
import { Button, Card, ConfirmButton, EmptyState, Field, Help, helpText, Icon, ICONS, NumberInput, Select, TextInput } from "../ui.tsx";

/** Fewer faces than this and recognition is shaky (Frigate's guide: 5–10 to start). */
const FEW_FACES = 5;

function useLibrary() {
  const [people, setPeople] = useState<PersonInfo[]>();
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api.people().then(
        (p) => (setPeople(p), setError(null)),
        (e: ApiError) => setError(e.message),
      ),
    [],
  );
  useEffect(() => void load(), [load]);
  return { people, error, load };
}

/** Uploads photos one by one: Frigate keeps only the face it finds in each. Returns the messages of the failed ones. */
async function uploadAll(id: string, files: FileList | File[]): Promise<string[]> {
  const failed: string[] = [];
  for (const f of files) await api.uploadFace(id, f).catch((e: ApiError) => failed.push(`${f.name}: ${e.message}`));
  return failed;
}

/** The people of the face library: who Percezione can recognize. */
export function People() {
  const t = useT();
  const p = t.people;
  const { locale } = useLocale();
  const { navigate, notify } = useApp();
  const { people, error, load } = useLibrary();
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  // "to name" opens straight from a link: /people?to-name
  const [tab, setTab] = useState<"people" | "toName" | "recognition">(() => (new URLSearchParams(location.search).has("to-name") ? "toName" : "people"));
  const [toName, setToName] = useState<number | null>(null);
  useEffect(() => {
    api.unknown().then((g) => setToName(g.length), () => setToName(null));
  }, [people]);

  const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const shown = (people ?? []).filter((x) => fold(humanize(x.id)).includes(fold(query)));

  return (
    <>
      <PageHeader
        title={p.title}
        subtitle={people ? p.subtitle(people.length) : p.subtitleLoading}
        help={helpText(p.help)}
        actions={
          <Button variant="primary" onClick={() => setAdding((x) => !x)}>
            <Icon d={ICONS.plus} />
            {p.add}
          </Button>
        }
      />
      <div role="tablist" aria-label={p.title} className="mb-5 flex gap-2">
        {(["people", "toName", "recognition"] as const).map((x) => (
          <Button key={x} role="tab" aria-selected={tab === x} variant={tab === x ? "soft" : "secondary"} onClick={() => setTab(x)}>
            {x === "people" ? p.tabPeople : x === "toName" ? p.toName.title : p.recognition.title}
            {x === "toName" && !!toName && <span className="rounded-full bg-amber px-2 text-xs font-semibold text-on-accent">{toName}</span>}
          </Button>
        ))}
      </div>
      {tab === "recognition" ? (
        <Recognition />
      ) : tab === "toName" ? (
        <ToName people={(people ?? []).map((x) => x.id)} onChanged={() => void load()} />
      ) : (
        <>
          {adding && (
            <AddPerson
              taken={(people ?? []).map((x) => x.id.toLowerCase())}
              onCancel={() => setAdding(false)}
              onDone={(id, failed) => {
                if (failed.length) notify("error", p.uploadFailed(failed.join(" · ")));
                navigate(`/people/${encodeURIComponent(id)}`);
              }}
            />
          )}
          {error ? (
            <EmptyState title={p.unavailable} text={p.unavailableText(error)} action={<Button onClick={() => void load()}>{p.retry}</Button>} />
          ) : people && people.length === 0 ? (
            <EmptyState title={p.empty} text={p.emptyText} action={<Button onClick={() => setAdding(true)}>{p.add}</Button>} />
          ) : (
            <>
              {people && people.length > 8 && (
                <div className="mb-5 max-w-sm">
                  <TextInput type="search" value={query} onChange={setQuery} placeholder={p.search} aria-label={p.search} />
                </div>
              )}
              <ul className="m-0 grid list-none gap-3 p-0 [grid-template-columns:repeat(auto-fill,minmax(min(100%,220px),1fr))]">
                {shown.map((x) => (
                  <li key={x.id}>
                    <a
                      href={`/people/${encodeURIComponent(x.id)}`}
                      onClick={(e) => (e.preventDefault(), navigate(`/people/${encodeURIComponent(x.id)}`))}
                      className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-3 text-ink no-underline hover:border-line-strong hover:bg-raised"
                    >
                      <Avatar person={x} />
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="truncate text-[15px] font-medium">{humanize(x.id)}</span>
                        <span className={`text-xs ${x.faces.length < FEW_FACES ? "text-amber-ink" : "text-muted"}`}>{p.faces(x.faces.length)}</span>
                        <span className="truncate text-xs text-dim">{x.last_seen ? p.lastSeen(dateTime(locale, x.last_seen)) : p.neverSeen}</span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
              {people && shown.length === 0 && <p className="text-sm text-dim">{p.noMatch}</p>}
            </>
          )}
        </>
      )}
    </>
  );
}

/** Frigate's global face recognition settings: edited in the working copy, saved with the save bar. */
function Recognition() {
  const r = useT().people.recognition;
  const { draft, edit } = useApp();
  const f = draft.faces ?? {};
  const set = (k: keyof NonNullable<typeof draft.faces>, v: number | undefined) =>
    edit((d) => {
      const next = { ...d.faces, [k]: v };
      if (v === undefined) delete next[k];
      d.faces = next;
    });
  return (
    <Card className="flex flex-col gap-4 p-5 md:p-6">
      <p className="m-0 text-sm text-muted">{r.subtitle}</p>
      <div className="grid gap-4 md:grid-cols-3">
        <Field label={r.threshold} hint={r.thresholdHint}>
          <NumberInput value={f.recognition_threshold} min={0} step={0.01} onChange={(v) => set("recognition_threshold", v)} />
        </Field>
        <Field label={r.unknown} hint={r.unknownHint}>
          <NumberInput value={f.unknown_score} min={0} step={0.01} onChange={(v) => set("unknown_score", v)} />
        </Field>
        <Field label={r.attempts} hint={r.attemptsHint}>
          <NumberInput value={f.save_attempts} min={0} step={100} onChange={(v) => set("save_attempts", v)} />
        </Field>
      </div>
    </Card>
  );
}

function Avatar({ person, size = 56 }: { person: PersonInfo; size?: number }) {
  const face = person.faces[0];
  return (
    <span className="flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-raised text-dim" style={{ width: size, height: size }}>
      {face ? <img src={faceUrl(person.id, face)} alt="" loading="lazy" className="h-full w-full object-cover" /> : <Icon d={ICONS.people} size={size / 2.4} />}
    </span>
  );
}

function AddPerson({ taken, onCancel, onDone }: { taken: string[]; onCancel(): void; onDone(id: string, failed: string[]): void }) {
  const t = useT();
  const p = t.people;
  const { notify } = useApp();
  const [name, setName] = useState("");
  const [files, setFiles] = useState<FileList | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = /^[\p{L}\p{N}' _-]{1,50}$/u.test(name.trim()) && name.trim().toLowerCase() !== "train";
  const exists = taken.includes(name.trim().replace(/\s+/g, "_").toLowerCase());
  return (
    <Card className="mb-6 grid gap-4 p-5 md:grid-cols-2">
      <Field label={p.name} hint={exists ? p.nameTaken : !name || valid ? p.nameHint : p.nameInvalid}>
        <TextInput value={name} onChange={setName} placeholder="Alice Smith" autoFocus />
      </Field>
      <Field label={p.photos} hint={p.photosHint} help={helpText(p.photosHelp)}>
        <input type="file" accept="image/*" multiple onChange={(e) => setFiles(e.target.files)} className="text-sm text-muted file:mr-3 file:min-h-10 file:rounded-[10px] file:border file:border-line-strong file:bg-transparent file:px-3 file:text-ink" />
      </Field>
      <div className="flex justify-end gap-2 md:col-span-2">
        <Button onClick={onCancel}>{t.common.save.cancel}</Button>
        <Button
          variant="primary"
          disabled={busy || !valid || exists}
          onClick={async () => {
            setBusy(true);
            try {
              const { id } = await api.createPerson(name);
              onDone(id, files?.length ? await uploadAll(id, files) : []);
            } catch (e) {
              notify("error", (e as ApiError).message);
              setBusy(false);
            }
          }}
        >
          {p.create}
        </Button>
      </div>
    </Card>
  );
}

/** One person: their faces, more photos, a wrong face out, rename, merge, delete. */
export function PersonPage({ id }: { id: string }) {
  const t = useT();
  const p = t.people;
  const { locale } = useLocale();
  const { navigate, notify } = useApp();
  const { people, error, load } = useLibrary();
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState("");
  const [mergeInto, setMergeInto] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const person = people?.find((x) => x.id === id);
  const others = (people ?? []).filter((x) => x.id !== id);
  const fail = (e: ApiError) => notify("error", e.message);

  if (error) return <EmptyState title={p.unavailable} text={p.unavailableText(error)} action={<Button onClick={() => void load()}>{p.retry}</Button>} />;
  if (!people) return null;
  if (!person) {
    return (
      <div className="flex flex-col items-start gap-4">
        <p className="m-0">{p.notFound(humanize(id))}</p>
        <Button onClick={() => navigate("/people")}>{p.back}</Button>
      </div>
    );
  }

  return (
    <>
      <header className="mb-6 flex flex-wrap items-center gap-4">
        <Button aria-label={p.back} onClick={() => navigate("/people")} className="w-11 px-0">
          <Icon d={ICONS.back} />
        </Button>
        <Avatar person={person} size={64} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {renaming ? (
            <div className="flex flex-wrap items-center gap-2">
              <TextInput value={newName} onChange={setNewName} aria-label={p.name} className="max-w-xs" autoFocus />
              <Button
                variant="primary"
                disabled={busy || !newName.trim()}
                onClick={() => {
                  setBusy(true);
                  api.renamePerson(id, newName).then(
                    (r) => (setRenaming(false), setBusy(false), navigate(`/people/${encodeURIComponent(r.id)}`), void load()),
                    (e: ApiError) => (fail(e), setBusy(false)),
                  );
                }}
              >
                {p.renameDo}
              </Button>
              <Button onClick={() => setRenaming(false)}>{t.common.save.cancel}</Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <h1 className="m-0 font-display text-[28px] font-semibold">{humanize(person.id)}</h1>
              <Button variant="ghost" onClick={() => (setNewName(humanize(person.id)), setRenaming(true))}>
                {p.rename}
              </Button>
            </div>
          )}
          <p className="m-0 text-sm text-muted">
            {p.faces(person.faces.length)} · {person.last_seen ? p.lastSeen(dateTime(locale, person.last_seen)) : p.neverSeen}
          </p>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={async (e) => {
            const files = e.target.files;
            if (!files?.length) return;
            setBusy(true);
            const failed = await uploadAll(id, files);
            e.target.value = "";
            setBusy(false);
            if (failed.length) notify("error", p.uploadFailed(failed.join(" · ")));
            else notify("info", p.uploaded(files.length));
            void load();
          }}
        />
        <Button variant="primary" disabled={busy} onClick={() => fileInput.current?.click()}>
          <Icon d={ICONS.plus} />
          {p.addPhotos}
        </Button>
      </header>

      {person.faces.length < FEW_FACES && (
        <p className="mb-5 flex items-center gap-2 rounded-xl border border-amber-line bg-amber-soft px-4 py-3 text-sm text-amber-ink">
          {p.fewFaces(FEW_FACES)}
          <Help label={p.photos}>{helpText(p.photosHelp)}</Help>
        </p>
      )}

      {person.faces.length === 0 ? (
        <EmptyState title={p.noFaces} text={p.noFacesText} action={<Button onClick={() => fileInput.current?.click()}>{p.addPhotos}</Button>} />
      ) : (
        <ul className="m-0 grid list-none gap-3 p-0 [grid-template-columns:repeat(auto-fill,minmax(132px,1fr))]">
          {person.faces.map((file) => (
            <FaceTile key={file} person={id} file={file} others={others.map((x) => x.id)} onChanged={() => void load()} />
          ))}
        </ul>
      )}

      <Card className="mt-8 flex flex-col gap-4 p-5">
        <div className="flex items-center gap-2">
          <h2 className="m-0 text-base font-semibold">{p.manage}</h2>
          <Help label={p.manage}>{helpText(p.manageHelp)}</Help>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={p.mergeInto}>
            <Select value={mergeInto} options={[["", t.common.none], ...others.map((x) => [x.id, humanize(x.id)] as [string, string])]} onChange={setMergeInto} />
          </Field>
          {mergeInto && (
            <ConfirmButton
              confirm={p.mergeConfirm(humanize(mergeInto))}
              onConfirm={() => {
                setBusy(true);
                api.mergePerson(id, mergeInto).then(
                  () => (navigate(`/people/${encodeURIComponent(mergeInto)}`), void load()),
                  (e: ApiError) => (fail(e), setBusy(false)),
                );
              }}
            >
              {p.merge}
            </ConfirmButton>
          )}
          <span className="ml-auto">
            <ConfirmButton confirm={p.deleteConfirm} onConfirm={() => api.deletePerson(id).then(() => navigate("/people"), fail)}>
              {p.delete}
            </ConfirmButton>
          </span>
        </div>
      </Card>
    </>
  );
}

function FaceTile({ person, file, others, onChanged }: { person: string; file: string; others: string[]; onChanged(): void }) {
  const t = useT();
  const p = t.people;
  const { notify } = useApp();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState("");
  const fail = (e: ApiError) => notify("error", e.message);
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-2">
      <button type="button" onClick={() => setOpen((x) => !x)} aria-expanded={open} aria-label={p.faceActions} className="relative block aspect-square overflow-hidden rounded-lg bg-raised">
        <img src={faceUrl(person, file)} alt="" loading="lazy" className="h-full w-full object-cover" />
        {/* night faces are listed as "~ir/<file>" (the service keeps them in their own folder) */}
        {file.startsWith("~ir/") && (
          <span title={p.nightTitle} className="absolute left-1 top-1 rounded-md bg-ground/85 px-1.5 py-0.5 text-[11px] font-medium text-ink">
            {p.night}
          </span>
        )}
      </button>
      {open && (
        <div className="flex flex-col gap-2">
          <Select value={to} options={[["", p.moveTo], ...others.map((x) => [x, humanize(x)] as [string, string])]} onChange={setTo} />
          {to && (
            <Button variant="soft" onClick={() => api.moveFace(person, file, to).then(onChanged, fail)}>
              {p.move}
            </Button>
          )}
          <ConfirmButton confirm={p.removeFaceConfirm} onConfirm={() => api.deleteFace(person, file).then(onChanged, fail)}>
            {p.removeFace}
          </ConfirmButton>
        </div>
      )}
    </li>
  );
}
