import { useCallback, useEffect, useState } from "react";
import { api, type RestoreResult, type Usage as UsageData } from "../api.ts";
import { PageHeader, useApp } from "../App.tsx";
import { Button, Card, ConfirmButton, Dot, EmptyState, Help, helpText, Switch } from "../ui.tsx";
import { useLocale, useT, type Locale } from "../i18n/index.tsx";
import { decimal } from "../i18n/format.ts";

const GB = 1024 ** 3;

function bytes(locale: Locale, n: number): string {
  if (n >= GB) return `${decimal(locale, n / GB, 1)} GB`;
  if (n >= 1024 ** 2) return `${decimal(locale, n / 1024 ** 2, 1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} kB`;
  return `${n} B`;
}

const pct = (n: number) => `${Math.round(n)}%`;

/** Help text: one block per paragraph (the popover is a span, so no <p>). */
/** Status of a share used: thresholds shared by disk, memory and shared memory. Always shown with a label. */
function level(share: number): "ok" | "amber" | "ko" {
  if (share >= 0.9) return "ko";
  if (share >= 0.75) return "amber";
  return "ok";
}

/** Fill meter: one bar, the share used, in the status color of its level. */
function Meter({ used, total, label }: { used: number; total: number; label: string }) {
  const share = total ? used / total : 0;
  const t = useT();
  const { locale } = useLocale();
  const color = level(share);
  const lv = { color, label: t.usage.level[color] };
  const fill = { ok: "bg-ok", amber: "bg-amber", ko: "bg-ko" }[lv.color];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted">
          {t.usage.of(bytes(locale, used), bytes(locale, total))} · {pct(share * 100)}
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(share * 100)}
        className="h-2.5 w-full overflow-hidden rounded-full bg-raised"
      >
        <div className={`h-full rounded-full ${fill}`} style={{ width: `${Math.min(100, share * 100)}%` }} />
      </div>
      <span className="flex items-center gap-1.5 text-[13px] text-muted">
        <Dot color={lv.color} /> {lv.label}
      </span>
    </div>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <Card className="flex min-w-[180px] flex-1 flex-col gap-1 px-5 py-4">
      <span className="text-[13px] text-muted">{label}</span>
      <span className="font-display text-[26px] font-semibold tabular-nums">{value}</span>
      {note && <span className="text-[13px] text-dim">{note}</span>}
    </Card>
  );
}

export function Usage() {
  const t = useT();
  const u = t.usage;
  const { locale } = useLocale();
  const { navigate } = useApp();
  const num = (n: number) => decimal(locale, n, 1);
  const size = (n: number) => bytes(locale, n);
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    (refresh = false) =>
      api.usage(refresh).then(
        (u) => (setData(u), setError(null)),
        (e: Error) => setError(e.message),
      ),
    [],
  );
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const memUsed = data ? data.host.memTotal - data.host.memFree : 0;
  const biggest = data ? Math.max(1, ...data.folders.map((f) => f.bytes)) : 1;
  const groups = data ? [...new Set(data.folders.map((f) => f.group))] : [];

  return (
    <>
      <PageHeader
        title={u.title}
        subtitle={data ? u.subtitle(new Date(data.ts).toLocaleTimeString(locale)) : u.subtitleLoading}
        help={helpText(u.help)}
        actions={<Button onClick={() => void load(true)}>{u.rescan}</Button>}
      />
      {error && <p className="text-sm text-ko-ink">{error}</p>}
      {data && (
        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-3">
            <h2 className="m-0 flex items-center gap-2 text-[13px] font-semibold tracking-[0.08em] text-muted">
              {u.space}
              <Help label={u.space}>{u.spaceHelp}</Help>
            </h2>
            <Card className="flex flex-col gap-5 p-5">
              <Meter label={u.disk} used={data.disk.total - data.disk.free} total={data.disk.total} />
              <p className="m-0 text-[13px] text-muted">
                {u.diskNote(size(data.disk.free))}
              </p>
            </Card>
            <Card className="overflow-x-auto p-5">
              <table className="w-full border-collapse text-left text-sm">
                <caption className="sr-only">{u.folders.caption}</caption>
                <thead className="text-[13px] text-muted">
                  <tr>
                    <th className="py-2 pr-4 font-medium">{u.folders.folder}</th>
                    <th className="w-[40%] py-2 pr-4 font-medium">
                      <span className="sr-only">{u.folders.relative}</span>
                    </th>
                    <th className="py-2 pr-4 text-right font-medium">{u.folders.space}</th>
                    <th className="py-2 text-right font-medium">{u.folders.files}</th>
                  </tr>
                </thead>
                {groups.map((g) => (
                  <tbody key={g}>
                    <tr>
                      <th colSpan={4} className="pb-1 pt-4 text-[13px] font-semibold text-ink">
                        {g} · {size(data.folders.filter((f) => f.group === g).reduce((s, f) => s + f.bytes, 0))}
                      </th>
                    </tr>
                    {data.folders
                      .filter((f) => f.group === g)
                      .map((f) => (
                        <tr key={f.path} className="border-t border-line" title={f.path}>
                          <td className="py-2 pr-4">{f.name}</td>
                          <td className="py-2 pr-4">
                            <div className="h-2 w-full rounded-full bg-raised">
                              <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(f.bytes ? 1 : 0, (f.bytes / biggest) * 100)}%` }} />
                            </div>
                          </td>
                          <td className="py-2 pr-4 text-right tabular-nums">{size(f.bytes)}</td>
                          <td className="py-2 text-right tabular-nums text-muted">{f.files.toLocaleString(locale)}</td>
                        </tr>
                      ))}
                  </tbody>
                ))}
              </table>
            </Card>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="m-0 flex items-center gap-2 text-[13px] font-semibold tracking-[0.08em] text-muted">
              {u.resources}
              <Help label={u.resources}>{helpText(u.resourcesHelp)}</Help>
            </h2>
            <div className="flex flex-wrap gap-3">
              <Tile label={u.load} value={num(data.host.load[0] ?? 0)} note={u.loadNote(data.host.cpus, num(data.host.load[2] ?? 0))} />
              {data.frigate?.detector && (
                <Tile label={u.detection} value={`${num(data.frigate.detector.inferenceMs)} ms`} note={u.detectionNote(pct(data.frigate.detector.cpu))} />
              )}
              {data.frigate?.faceRecognitionMs != null && <Tile label={u.faces} value={`${Math.round(data.frigate.faceRecognitionMs)} ms`} note={u.facesNote} />}
            </div>
            <Card className="flex flex-col gap-5 p-5">
              <Meter label={u.memory} used={memUsed} total={data.host.memTotal} />
              {data.frigate?.shm && <Meter label={u.shm} used={data.frigate.shm.used} total={data.frigate.shm.total} />}
            </Card>
            <Card className="overflow-x-auto p-5">
              <table className="w-full border-collapse text-left text-sm">
                <caption className="sr-only">{u.processes.caption}</caption>
                <thead className="text-[13px] text-muted">
                  <tr>
                    <th className="py-2 pr-4 font-medium">{u.processes.process}</th>
                    <th className="py-2 pr-4 text-right font-medium">{u.processes.memory}</th>
                    <th className="py-2 text-right font-medium">{u.processes.cpu}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.processes.map((p) => (
                    <tr key={p.name} className="border-t border-line">
                      <td className="py-2 pr-4">{p.name}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{size(p.rss)}</td>
                      <td className="py-2 text-right tabular-nums">{pct(p.cpu)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </section>

          {data.frigate && (
            <section className="flex flex-col gap-3">
              <h2 className="m-0 flex items-center gap-2 text-[13px] font-semibold tracking-[0.08em] text-muted">
                {u.cameras.title}
                <Help label={u.cameras.title}>{helpText(u.cameras.help)}</Help>
              </h2>
              {data.frigate.cameras.length === 0 ? (
                <EmptyState title={u.cameras.empty} text={u.cameras.emptyText} action={<Button onClick={() => navigate("/cameras")}>{u.cameras.emptyAction}</Button>} />
              ) : (
                <Card className="overflow-x-auto p-5">
                  <table className="w-full border-collapse text-left text-sm">
                    <caption className="sr-only">{u.cameras.caption}</caption>
                    <thead className="text-[13px] text-muted">
                      <tr>
                        <th className="py-2 pr-4 font-medium">{u.cameras.camera}</th>
                        <th className="py-2 pr-4 text-right font-medium">{u.cameras.fps}</th>
                        <th className="py-2 pr-4 text-right font-medium">{u.cameras.detections}</th>
                        <th className="py-2 pr-4 text-right font-medium">{u.cameras.stalls}</th>
                        <th className="py-2 text-right font-medium">{u.cameras.reconnects}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.frigate.cameras.map((c) => {
                        // a stall is a gap in the stream: a few per hour are normal, dozens are visible as freezes
                        const st = c.stallsLastHour >= 60 ? { color: "ko" as const, label: u.cameras.stallLevel.many } : c.stallsLastHour >= 20 ? { color: "amber" as const, label: u.cameras.stallLevel.some } : { color: "ok" as const, label: u.cameras.stallLevel.few };
                        return (
                          <tr key={c.name} className="border-t border-line">
                            <td className="py-2 pr-4 font-medium">{c.name}</td>
                            <td className="py-2 pr-4 text-right tabular-nums">{num(c.fps)}</td>
                            <td className="py-2 pr-4 text-right tabular-nums">{num(c.detectionFps)}</td>
                            <td className="py-2 pr-4 text-right tabular-nums">
                              <span className="inline-flex items-center gap-1.5">
                                <Dot color={st.color} />
                                {c.stallsLastHour} <span className="text-[13px] text-muted">{st.label}</span>
                              </span>
                            </td>
                            <td className="py-2 text-right tabular-nums">{c.reconnectsLastHour}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </Card>
              )}
            </section>
          )}
        </div>
      )}
      <BackupSection />
    </>
  );
}

/** Download a backup, or restore one (then wait for the service to come back and reload). */
function BackupSection() {
  const b = useT().usage.backup;
  const [withSecrets, setWithSecrets] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<"idle" | "restoring" | "restarting">("idle");
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [error, setError] = useState("");
  const restore = async () => {
    if (!file) return;
    setState("restoring");
    setError("");
    try {
      const r = await api.restoreBackup(file);
      setResult(r);
      if (!r.restarting) return setState("idle");
      setState("restarting");
      // the service exits and Docker starts it again: reload once it answers
      await new Promise((ok) => setTimeout(ok, 3_000));
      for (let i = 0; i < 60; i++) {
        if (await fetch("/healthz").then(() => true, () => false)) return window.location.reload();
        await new Promise((ok) => setTimeout(ok, 2_000));
      }
    } catch (err) {
      setError((err as Error).message);
      setState("idle");
    }
  };
  const faces = result?.people.reduce((n, p) => n + p.added, 0) ?? 0;
  return (
    <section className="mt-6 flex flex-col gap-3">
      <h2 className="m-0 flex items-center gap-2 text-[13px] font-semibold tracking-[0.08em] text-muted">
        {b.title}
        <Help label={b.title}>{helpText(b.help)}</Help>
      </h2>
      <Card className="flex flex-col gap-5 p-5">
        <div className="flex flex-col gap-3">
          <Switch checked={withSecrets} onChange={setWithSecrets} label={b.withSecrets} />
          {withSecrets && <p className="m-0 text-[13px] text-muted">{b.withSecretsNote}</p>}
          <a className="self-start" href={`/api/backup${withSecrets ? "?secrets=1" : ""}`} download>
            <Button type="button">{b.download}</Button>
          </a>
        </div>
        <div className="flex flex-col gap-3 border-t border-line pt-5">
          <label className="flex flex-col gap-1.5 text-[13px] text-muted">
            {b.restoreLabel}
            <input type="file" accept=".gz,application/gzip" disabled={state !== "idle"} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          {file && state === "idle" && (
            <div className="self-start">
              <ConfirmButton confirm={b.confirm} onConfirm={() => void restore()}>
                {b.restore}
              </ConfirmButton>
            </div>
          )}
          {state !== "idle" && <p className="m-0 text-sm text-muted">{state === "restoring" ? b.restoring : b.restarting}</p>}
          {result && <p className="m-0 text-sm">{b.result(result.people.filter((p) => p.added > 0).length, faces)}</p>}
          {!!result?.errors.length && (
            <div className="text-sm text-ko-ink">
              {b.errors(result.errors.length)}
              <ul className="m-0 mt-1 pl-5">
                {result.errors.slice(0, 10).map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}
          {error && <p className="m-0 text-sm text-ko-ink">{error}</p>}
        </div>
      </Card>
    </section>
  );
}
