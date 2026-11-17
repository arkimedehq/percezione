import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Restream } from "../api.ts";
import { PageHeader, useApp } from "../App.tsx";
import { useT } from "../i18n/index.tsx";
import { Button, Card, ConfirmButton, Dot, EmptyState, Field, Help, helpText, Icon, ICONS, TextInput } from "../ui.tsx";

const ID = /^[a-z0-9][a-z0-9-]*$/;
const hasPassword = (url: string) => /:\/\/[^@/]*:[^@/]*@/.test(url);

/**
 * The video sources of Percezione's go2rtc: one connection per camera, shared by Frigate, the live video and, when
 * sharing is on, other apps. Addresses go in the configuration (saved with the save bar); passwords go straight to
 * the service, which keeps them apart and never sends them back.
 */
export function Sources() {
  const t = useT();
  const s = t.cameras.sources;
  const { draft, edit, notify } = useApp();
  const [rs, setRs] = useState<Restream>();
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);

  const load = useCallback(() => api.restream().then(setRs, () => setRs(undefined)), []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const sources = Object.entries(draft.sources);
  const usedBy = (id: string) => Object.entries(draft.cameras).filter(([, c]) => c.stream && "go2rtc" in c.stream && (c.stream.go2rtc === id || c.stream.go2rtc === `${id}_sub`)).map(([n]) => n);
  const active = (id: string) => rs?.streams.find((x) => x.name === id)?.active;

  return (
    <>
      <PageHeader
        title={s.title}
        subtitle={s.subtitle}
        help={helpText(s.help)}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => (setImporting((x) => !x), setAdding(false))}>{s.import}</Button>
            <Button variant="primary" onClick={() => (setAdding((x) => !x), setImporting(false))}>
              <Icon d={ICONS.plus} />
              {s.add}
            </Button>
          </div>
        }
      />
      <Card className="flex flex-col gap-4 p-5 md:p-6">
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <Dot color={rs?.up ? "ok" : "ko"} />
          {rs?.up ? s.running(rs.version ?? "") : s.down}
        </div>

        {importing && <ImportForm onDone={() => (setImporting(false), void load())} />}
        {adding && (
          <SourceForm
            taken={Object.keys(draft.sources)}
            onCancel={() => setAdding(false)}
            onSave={(id, src, password) => {
              edit((d) => void (d.sources[id] = src));
              if (password) api.sourcePassword(id, password).then(load, (e: ApiError) => notify("error", e.message));
              setAdding(false);
            }}
          />
        )}

        {sources.length === 0 ? (
          <EmptyState title={s.empty} text={s.emptyText} />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {sources.map(([id, src]) => {
              const users = usedBy(id);
              const pw = rs?.sources[id]?.has_password;
              return (
                <li key={id} className="flex flex-col gap-3 rounded-xl border border-line px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <Dot color={active(id) ? "ok" : rs?.up ? "dim" : "ko"} />
                    <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-0.5">
                      <span className="text-[15px] font-medium">
                        {src.label ? `${src.label} · ` : ""}
                        <span className="font-mono text-sm">{id}</span>
                      </span>
                      <span className="truncate font-mono text-xs text-dim" title={src.url}>
                        {src.url}
                      </span>
                      <span className="text-xs text-muted">
                        {[src.sub ? s.withSub : s.noSub, pw ? s.passwordSet : s.passwordMissing, users.length ? s.usedBy(users.join(", ")) : s.unused].join(" · ")}
                      </span>
                    </div>
                    <div className="flex gap-2">
                      <Button onClick={() => setEditing(editing === id ? null : id)}>{s.edit}</Button>
                      {users.length === 0 && (
                        <ConfirmButton confirm={s.removeConfirm} onConfirm={() => edit((d) => void delete d.sources[id])}>
                          {s.remove}
                        </ConfirmButton>
                      )}
                    </div>
                  </div>
                  {editing === id && (
                    <SourceForm
                      id={id}
                      initial={src}
                      taken={[]}
                      onCancel={() => setEditing(null)}
                      onSave={(_id, next, password) => {
                        edit((d) => void (d.sources[id] = next));
                        if (password) api.sourcePassword(id, password).then(load, (e: ApiError) => notify("error", e.message));
                        setEditing(null);
                      }}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}

type Src = { url: string; sub?: string; label?: string };

function SourceForm({ id: fixedId, initial, taken, onSave, onCancel }: { id?: string; initial?: Src; taken: string[]; onSave(id: string, src: Src, password: string): void; onCancel(): void }) {
  const t = useT();
  const s = t.cameras.sources;
  const [id, setId] = useState(fixedId ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [sub, setSub] = useState(initial?.sub ?? "");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [password, setPassword] = useState("");
  const idError = fixedId ? "" : !ID.test(id) ? s.idInvalid : taken.includes(id) ? s.idTaken : "";
  const urlError = (u: string) => (!u ? "" : !/^(rtsps?|https?):\/\//.test(u) ? s.urlInvalid : hasPassword(u) ? s.urlHasPassword : "");
  const errors = [idError, !url ? s.urlNeeded : urlError(url), urlError(sub)].filter(Boolean);
  return (
    <div className="grid gap-4 rounded-xl border border-line-strong bg-ground p-4 md:grid-cols-2">
      {!fixedId && (
        <Field label={s.id} hint={idError || s.idHint}>
          <TextInput value={id} onChange={(v) => setId(v.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} />
        </Field>
      )}
      <Field label={s.label}>
        <TextInput value={label} onChange={setLabel} placeholder={s.labelPlaceholder} />
      </Field>
      <Field label={s.url} hint={urlError(url) || s.urlHint} help={helpText(s.urlHelp)}>
        <TextInput value={url} onChange={setUrl} placeholder="rtsp://admin@192.0.2.10:554/Streaming/Channels/101" className="font-mono text-sm" />
      </Field>
      <Field label={s.sub} hint={urlError(sub) || s.subHint}>
        <TextInput value={sub} onChange={setSub} placeholder="rtsp://admin@192.0.2.10:554/Streaming/Channels/102" className="font-mono text-sm" />
      </Field>
      <Field label={s.password} hint={fixedId ? s.passwordKeep : s.passwordHint}>
        <TextInput type="password" autoComplete="new-password" value={password} onChange={setPassword} />
      </Field>
      <div className="flex flex-wrap items-end justify-end gap-2 md:col-span-2">
        {errors[0] && <span className="mr-auto text-[13px] text-amber-ink">{errors[0]}</span>}
        <Button onClick={onCancel}>{t.common.save.cancel}</Button>
        <Button
          variant="primary"
          disabled={errors.length > 0}
          onClick={() => onSave(id, { url, ...(sub ? { sub } : {}), ...(label ? { label } : {}) }, password)}
        >
          {s.done}
        </Button>
      </div>
    </div>
  );
}

function ImportForm({ onDone }: { onDone(): void }) {
  const t = useT();
  const s = t.cameras.sources;
  const { notify } = useApp();
  const [url, setUrl] = useState("http://");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid gap-4 rounded-xl border border-line-strong bg-ground p-4 md:grid-cols-3">
      <p className="m-0 text-sm text-muted md:col-span-3">
        {s.importIntro} <Help label={s.import}>{helpText(s.importHelp)}</Help>
      </p>
      <Field label={s.importUrl} hint={s.importUrlHint}>
        <TextInput value={url} onChange={setUrl} placeholder="http://192.0.2.20:1984" className="font-mono text-sm" />
      </Field>
      <Field label={s.importUser}>
        <TextInput value={user} onChange={setUser} autoComplete="off" />
      </Field>
      <Field label={s.password}>
        <TextInput type="password" autoComplete="new-password" value={password} onChange={setPassword} />
      </Field>
      <div className="flex justify-end gap-2 md:col-span-3">
        <Button onClick={onDone}>{t.common.save.cancel}</Button>
        <Button
          variant="primary"
          disabled={busy || !/^https?:\/\/./.test(url) || !user || !password}
          onClick={() => {
            setBusy(true);
            api.importSources(url, user, password).then(
              (r) => {
                notify("info", r.added.length ? s.imported(r.added.length) : s.importedNone);
                onDone();
              },
              (e: ApiError) => {
                notify("error", s.importFailed(e.message));
                setBusy(false);
              },
            );
          }}
        >
          {s.importGo}
        </Button>
      </div>
    </div>
  );
}
