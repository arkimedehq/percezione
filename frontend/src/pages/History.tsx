import { diffLines } from "diff";
import { useEffect, useState } from "react";
import { api, type Config, type HistoryItem } from "../api.ts";
import { PageHeader, useApp } from "../App.tsx";
import { ConfirmButton, Card, EmptyState, helpText } from "../ui.tsx";
import { useLocale, useT } from "../i18n/index.tsx";

export function History() {
  const { config, dirty, notify } = useApp();
  const t = useT();
  const { locale } = useLocale();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [sel, setSel] = useState(0);
  const [pair, setPair] = useState<[Config | null, Config] | null>(null);

  useEffect(() => {
    api.history().then(setItems, (e: Error) => notify("error", e.message));
  }, [config.version, notify]);

  useEffect(() => {
    const cur = items[sel];
    if (!cur) return;
    const prev = items[sel + 1];
    void Promise.all([prev ? api.historyFile(prev.file) : Promise.resolve(null), api.historyFile(cur.file)]).then(([a, b]) => setPair([a, b]));
  }, [items, sel]);

  const cur = items[sel];
  return (
    <>
      <PageHeader
        title={t.history.title}
        subtitle={t.history.subtitle}
        help={helpText(t.history.help)}
      />
      <div className="flex flex-wrap items-start gap-6">
        <ol className="m-0 flex max-h-[75vh] min-w-0 flex-[1_1_320px] list-none flex-col gap-2 overflow-y-auto p-0">
          {items.map((h, i) => (
            <li key={h.file}>
              <button
                type="button"
                onClick={() => setSel(i)}
                className={`flex min-h-14 w-full items-center gap-3.5 rounded-xl border px-3.5 py-2.5 text-left ${i === sel ? "border-accent bg-selected" : "border-line bg-surface"}`}
              >
                <span className="w-12 font-display text-[15px] font-semibold">v{h.version}</span>
                <span className="flex-1 text-sm text-muted">{new Date(h.ts).toLocaleString(locale, { dateStyle: "short", timeStyle: "medium" })}</span>
                {h.version === config.version && <span className="rounded-md bg-ok-soft px-2 py-0.5 text-xs text-ok-ink">{t.history.current}</span>}
              </button>
            </li>
          ))}
          {items.length === 0 && (
            <li>
              <EmptyState title={t.history.emptyTitle} text={t.history.emptyText} />
            </li>
          )}
        </ol>
        <Card className="flex min-w-0 flex-[2_1_520px] flex-col gap-4 p-6">
          {cur && pair && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="m-0 text-lg font-semibold">
                  v{cur.version} {pair[0] ? t.history.versus(items[sel + 1]!.version) : t.history.first}
                </h2>
                {cur.version !== config.version && (
                  <ConfirmButton
                    confirm={dirty ? t.history.confirmLoseChanges : t.history.confirmRestore}
                    onConfirm={() => api.restore(cur.file).then((r) => notify("info", t.history.restored(r.version)), (e: Error) => notify("error", e.message))}
                  >
                    {t.history.restore}
                  </ConfirmButton>
                )}
              </div>
              <Diff a={pair[0]} b={pair[1]} />
            </>
          )}
        </Card>
      </div>
    </>
  );
}

/** Line-by-line differences, with a few lines of context around each change. */
function Diff({ a, b }: { a: Config | null; b: Config }) {
  const t = useT();
  const strip = (c: Config | null) => (c ? JSON.stringify({ ...c, version: undefined }, null, 2) : "");
  const parts = diffLines(strip(a), strip(b));
  const rows: { kind: "add" | "del" | "ctx" | "gap"; text: string }[] = [];
  parts.forEach((p, i) => {
    const lines = p.value.replace(/\n$/, "").split("\n");
    if (p.added || p.removed) {
      for (const l of lines) rows.push({ kind: p.added ? "add" : "del", text: l });
      return;
    }
    const head = i > 0 ? lines.slice(0, 3) : [];
    const tail = i < parts.length - 1 ? lines.slice(-3) : [];
    if (lines.length > head.length + tail.length) {
      for (const l of head) rows.push({ kind: "ctx", text: l });
      rows.push({ kind: "gap", text: "…" });
      for (const l of tail) rows.push({ kind: "ctx", text: l });
    } else for (const l of lines) rows.push({ kind: "ctx", text: l });
  });
  const style = { add: "bg-ok-soft text-ok-ink", del: "bg-ko-soft text-ko-ink", ctx: "text-dim", gap: "text-dim" };
  const sign = { add: "+ ", del: "- ", ctx: "  ", gap: "  " };
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-ground">
      <pre className="m-0 p-4 font-mono text-[13px] leading-[1.7]">
        {rows.length === 0 && <span className="text-dim">{t.history.noDiff}</span>}
        {rows.map((r, i) => (
          <span key={i} className={`block ${style[r.kind]}`}>
            {sign[r.kind]}
            {r.text}
          </span>
        ))}
      </pre>
    </div>
  );
}
