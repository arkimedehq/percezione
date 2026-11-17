import { useCallback, useEffect, useState } from "react";
import { api, type AnalyzerStatus, type ApiError } from "../api.ts";
import { PageHeader, useApp } from "../App.tsx";
import { Button, Card, ConfirmButton, Dot, EmptyState, Field, Help, Icon, ICONS, TextInput, helpText } from "../ui.tsx";
import { useT } from "../i18n/index.tsx";
import { label } from "../i18n/format.ts";

/** Help text: one block per paragraph (the popover is a span, so no <p>). */
export function Analyzers() {
  const { draft, edit, config } = useApp();
  const t = useT();
  const msg = t.analyzers;
  const [list, setList] = useState<AnalyzerStatus[]>([]);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("http://127.0.0.1:8100");
  const load = useCallback((refresh = false) => api.analyzers(refresh).then(setList, () => undefined), []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load, config.version]);

  const endpoints = draft.analyzers.endpoints;
  const usedBy = (name: string) => Object.entries(draft.cameras).filter(([, c]) => c.observe.posture?.analyzer === name).map(([n]) => n);

  return (
    <>
      <PageHeader
        title={msg.title}
        subtitle={msg.subtitle}
        help={helpText(msg.help)}
        actions={<Button onClick={() => void load(true)}>{msg.refresh}</Button>}
      />
      <div className="flex flex-col gap-5">
        {list.map((a) => (
          <Card key={a.name} className="flex flex-col gap-4 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <h2 className="m-0 flex items-center gap-2.5 text-lg font-semibold">
                  <Dot color={a.ok ? "ok" : a.download ? "amber" : "ko"} />
                  {a.name}
                  <span className="text-sm font-normal text-muted">{a.kind === "vlm" ? "VLM (Ollama)" : msg.runner(a.version ?? "")}</span>
                </h2>
                <span className="text-[13px] text-dim">
                  {a.url}
                  {a.providers ? ` · ${a.providers.map((p) => p.replace("ExecutionProvider", "")).join(", ")}` : ""}
                </span>
                {a.error && <span className="text-[13px] text-ko-ink">{a.error}</span>}
                {a.download && <span className="text-[13px] text-amber-ink">{msg.downloading(a.download.model, a.download.percent)}</span>}
              </div>
              {a.kind === "endpoint" && (
                <div className="flex flex-col items-end gap-2">
                  {usedBy(a.name).length > 0 ? (
                    <span className="flex items-center gap-2 text-[13px] text-muted">
                      {msg.usedBy(usedBy(a.name).join(", "))}
                      <Help label={msg.remove}>{msg.usedByHelp}</Help>
                    </span>
                  ) : (
                    <ConfirmButton confirm={msg.removeConfirm} onConfirm={() => edit((d) => void delete d.analyzers.endpoints[a.name])}>
                      <Icon d={ICONS.trash} /> {msg.remove}
                    </ConfirmButton>
                  )}
                </div>
              )}
            </div>
            {a.models.length === 0 ? (
              <EmptyState title={msg.noModels} text={a.kind === "endpoint" && a.ok ? msg.noModelsText : undefined} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <thead className="text-[13px] text-muted">
                    <tr>
                      <th className="py-2 pr-4 font-medium">{msg.columns.model}</th>
                      <th className="py-2 pr-4 font-medium">{msg.columns.task}</th>
                      <th className="py-2 pr-4 font-medium">{msg.columns.labels}</th>
                      <th className="py-2 pr-4 text-right font-medium">{msg.columns.average}</th>
                      <th className="py-2 text-right font-medium">{msg.columns.calls}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.models.map((m) => (
                      <tr key={m.name} className="border-t border-line">
                        <td className="py-2.5 pr-4 font-medium">
                          {m.name}
                          {m.family && <span className="ml-2 text-xs text-dim">{m.family}</span>}
                        </td>
                        <td className="py-2.5 pr-4">{msg.task[m.task] ?? m.task}</td>
                        <td className="py-2.5 pr-4 text-muted">{m.outputs.map((o) => label(t, o)).join(", ") || t.common.none}</td>
                        <td className="py-2.5 pr-4 text-right tabular-nums">{m.avg_ms != null ? `${m.avg_ms} ms` : t.common.none}</td>
                        <td className="py-2.5 text-right tabular-nums text-muted">
                          {m.calls ?? t.common.none}
                          {m.errors ? <span className="text-ko-ink"> · {msg.errors(m.errors)}</span> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {a.broken && Object.keys(a.broken).length > 0 && (
              <div className="rounded-[10px] border border-ko/40 bg-ko-soft px-3.5 py-2.5 text-[13px] text-ko-ink">
                {Object.entries(a.broken).map(([n, err]) => (
                  <div key={n}>
                    {n}: {err}
                  </div>
                ))}
              </div>
            )}
            {a.kind === "endpoint" && a.ok && <Upload endpoint={a.name} onDone={() => void load(true)} />}
          </Card>
        ))}

        <Card className="flex flex-col gap-3 p-5">
          <h2 className="m-0 flex items-center gap-2 text-base font-semibold">
            {msg.addTitle}
            <Help label={msg.addTitle}>{helpText(msg.addHelp)}</Help>
          </h2>
          <p className="m-0 text-[13px] text-muted">{msg.addNote}</p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-40">
              <Field label={msg.name} hint={msg.nameHint}>
                <TextInput value={newName} onChange={setNewName} placeholder="onnx" />
              </Field>
            </div>
            <div className="min-w-[260px] flex-1">
              <Field label={msg.address}>
                <TextInput value={newUrl} onChange={setNewUrl} />
              </Field>
            </div>
            <Button
              disabled={!/^[a-z0-9_]+$/.test(newName) || newName in endpoints || !/^https?:\/\//.test(newUrl)}
              onClick={() => {
                edit((d) => void (d.analyzers.endpoints[newName] = { url: newUrl.replace(/\/$/, "") }));
                setNewName("");
              }}
            >
              {msg.add}
            </Button>
          </div>
        </Card>
      </div>
    </>
  );
}

function Upload({ endpoint, onDone }: { endpoint: string; onDone(): void }) {
  const { notify } = useApp();
  const t = useT();
  const u = t.analyzers.upload;
  const [name, setName] = useState("");
  const [onnx, setOnnx] = useState<File | null>(null);
  const [yml, setYml] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const file = "block w-full text-sm text-muted file:mr-3 file:min-h-10 file:rounded-[10px] file:border file:border-line-strong file:bg-transparent file:px-3 file:text-ink";
  return (
    <details className="rounded-xl border border-line bg-ground px-4 py-3">
      <summary className="min-h-8 cursor-pointer text-sm font-medium">
        {u.title} <Help label={u.title}>{u.help}</Help>
      </summary>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="w-40">
          <Field label={t.analyzers.name} hint={u.nameHint}>
            <TextInput value={name} onChange={setName} placeholder={u.namePlaceholder} />
          </Field>
        </div>
        <Field label="model.onnx">
          <input type="file" accept=".onnx" className={file} onChange={(e) => setOnnx(e.target.files?.[0] ?? null)} />
        </Field>
        <Field label="model.yml">
          <input type="file" accept=".yml,.yaml" className={file} onChange={(e) => setYml(e.target.files?.[0] ?? null)} />
        </Field>
        <Button
          variant="primary"
          disabled={busy || !onnx || !yml || !/^[a-z0-9_-]+$/.test(name)}
          onClick={() => {
            setBusy(true);
            api
              .uploadModel(endpoint, name, onnx!, yml!)
              .then(
                () => (notify("info", u.done(name, endpoint)), onDone()),
                (e: ApiError) => notify("error", u.failed(e.message)),
              )
              .finally(() => setBusy(false));
          }}
        >
          {busy ? u.uploading : u.submit}
        </Button>
      </div>
    </details>
  );
}
