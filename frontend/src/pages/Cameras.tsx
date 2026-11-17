import { useEffect, useState } from "react";
import { api, type Camera, type Config, type PerceptionEvent } from "../api.ts";
import { PageHeader, useApp } from "../App.tsx";
import { CameraGroups } from "./CameraGroups.tsx";
import { Button, Card, Dot, EmptyState, Field, Help, Icon, ICONS, LiveVideo, NumberInput, Select, Switch, TextInput, helpText } from "../ui.tsx";
import { useLocale, useT } from "../i18n/index.tsx";
import { describeEvent, place, time } from "../i18n/format.ts";

/** The observations shown on a camera card, in this order. */
const CARD_OBSERVATIONS = ["presence", "activity", "passages", "approach"] as const;

/** Lighter go2rtc stream for small previews: `<name>_sub` if it exists. */
export function previewStream(cam: Camera, streams: { name: string }[], small: boolean): string | undefined {
  if (!cam.stream || !("go2rtc" in cam.stream)) return undefined;
  const sub = `${cam.stream.go2rtc}_sub`;
  return small && streams.some((s) => s.name === sub) ? sub : cam.stream.go2rtc;
}

/** Help text: one block per paragraph (the popover is a span, so no <p>). */
export function aspectOf(cam: Camera): number {
  return cam.detect ? cam.detect.width / cam.detect.height : 16 / 9;
}

export function ZoneOverlay({ cam }: { cam: Camera }) {
  const zones = Object.entries(cam.zones);
  if (!zones.length) return null;
  return (
    <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
      {zones.map(([name, z]) => (
        <polygon key={name} points={z.points.map((p) => p.join(",")).join(" ")} fill="#F2A33A33" stroke="#F2A33A" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}

export function Cameras() {
  const { config, status, streams, navigate, saveNow, notify } = useApp();
  // the getting-started guide on the home page opens the wizard with /cameras?add
  const [adding, setAdding] = useState(() => new URLSearchParams(location.search).has("add"));
  const [last, setLast] = useState<Record<string, PerceptionEvent>>({});
  const { onEvent } = useApp();
  const t = useT();
  const { locale } = useLocale();

  useEffect(() => {
    api.events(300).then((evs) => {
      const m: Record<string, PerceptionEvent> = {};
      for (const e of [...evs].reverse()) for (const c of e.cameras ?? [e.camera]) m[c] = e;
      setLast(m);
    }, () => undefined);
    return onEvent((e) => setLast((m) => ({ ...m, ...Object.fromEntries((e.cameras ?? [e.camera]).map((c) => [c, e])) })));
  }, [onEvent]);

  const cams = Object.entries(config.cameras);
  // saved at once, like Frigate's own switch: a camera is turned off to free the computer now
  const toggle = async (name: string, on: boolean) => {
    const next = structuredClone(config);
    if (on) delete next.cameras[name]!.enabled;
    else next.cameras[name]!.enabled = false;
    const label = config.cameras[name]!.label ?? name;
    if (await saveNow(next)) notify("info", on ? t.cameras.turnedOn(label) : t.cameras.turnedOff(label));
  };
  const outdoor = cams.filter(([, c]) => c.kind === "outdoor").length;
  return (
    <>
      <PageHeader
        title={t.cameras.title}
        subtitle={t.cameras.subtitle(cams.length, cams.length - outdoor, outdoor)}
        help={helpText(t.cameras.help)}
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Icon d={ICONS.plus} />
            {t.cameras.add}
          </Button>
        }
      />
      {cams.length === 0 && (
        <EmptyState
          title={t.cameras.empty.title}
          text={t.cameras.empty.text}
          action={
            <Button variant="primary" onClick={() => setAdding(true)}>
              <Icon d={ICONS.plus} />
              {t.cameras.add}
            </Button>
          }
        />
      )}
      <section aria-label={t.cameras.listLabel} className="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,380px),1fr))]">
        {cams.map(([name, cam]) => {
          const st = status?.cameras[name];
          const on = cam.enabled !== false;
          return (
            <Card key={name} className="flex flex-col overflow-hidden">
              {on ? (
                <LiveVideo stream={previewStream(cam, streams, true)} camera={name} aspect={aspectOf(cam)}>
                  <ZoneOverlay cam={cam} />
                  <span className="absolute right-3 top-3 flex items-center gap-1.5 rounded-full bg-ground/80 px-2.5 py-1 text-xs text-ink">
                    <Dot color={!st ? "dim" : st.fps > 1 ? "ok" : "ko"} />
                    {st ? `${st.fps.toFixed(1)} fps` : "—"}
                  </span>
                </LiveVideo>
              ) : (
                // no preview: a camera turned off is not read at all
                <div className="flex w-full flex-col items-center justify-center gap-1 bg-raised text-sm text-muted" style={{ aspectRatio: aspectOf(cam) }}>
                  <span className="font-medium text-ink">{t.cameras.off}</span>
                  {t.cameras.offText}
                </div>
              )}
              <div className="flex flex-col gap-3 px-5 pb-5 pt-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="m-0 min-w-0 truncate text-lg font-semibold">{cam.label ?? name}</h2>
                  <span className="flex items-center gap-3 text-[13px] text-muted">
                    {place(t, cam.place)} · {t.events.kind[cam.kind]}
                    <Switch checked={on} onChange={(v) => void toggle(name, v)} label={t.cameras.on(cam.label ?? name)} />
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {CARD_OBSERVATIONS
                    .filter((k) => cam.observe[k])
                    .map((k) => (
                      <span key={k} className="rounded-lg bg-raised px-2.5 py-1 text-[13px] text-ink">
                        {t.events.observation[k]}
                      </span>
                    ))}
                  {Object.keys(cam.observe).length === 0 && <span className="text-[13px] text-dim">{t.cameras.noObservations}</span>}
                </div>
                <div className="flex items-center justify-between gap-3 pt-1">
                  <span className="min-w-0 truncate text-[13px] text-muted">{last[name] ? `${describeEvent(t, last[name])} · ${time(locale, last[name].ts)}` : t.cameras.noRecentEvents}</span>
                  <Button onClick={() => navigate(`/cameras/${name}`)}>{t.cameras.edit}</Button>
                </div>
              </div>
            </Card>
          );
        })}
      </section>
      {cams.length > 1 && <CameraGroups />}
      {adding && (
        <AddCamera
          onClose={() => {
            setAdding(false);
            if (location.search) history.replaceState(null, "", location.pathname);
          }}
        />
      )}
    </>
  );
}

/** Source → test → name and place; at the end the camera is saved and sent to Frigate. */
function AddCamera({ onClose }: { onClose: () => void }) {
  const { config, streams, saveNow, navigate } = useApp();
  const t = useT();
  const w = t.cameras.wizard;
  const free = streams.filter((s) => !s.camera && !s.name.endsWith("_sub"));
  useEffect(() => {
    const escape = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);
  const [step, setStep] = useState(1);
  const [src, setSrc] = useState<"go2rtc" | "rtsp">("go2rtc");
  const [stream, setStream] = useState(free[0]?.name ?? "");
  const [rtsp, setRtsp] = useState("");
  const [sub, setSub] = useState("");
  const [password, setPassword] = useState("");
  const [probeImg, setProbeImg] = useState<string>();
  const [size, setSize] = useState<{ width?: number; height?: number }>({});
  const [probe, setProbe] = useState<"idle" | "ok" | "ko">("idle");
  const [name, setName] = useState("");
  const [place, setPlace] = useState("");
  const [kind, setKind] = useState<Camera["kind"]>("indoor");
  const [busy, setBusy] = useState(false);
  const places = [...new Set(Object.values(config.cameras).map((c) => c.place))];

  const rtspError = !rtsp ? "" : !/^(rtsps?|https?):\/\//.test(rtsp) ? t.cameras.sources.urlInvalid : /:\/\/[^@/]*:[^@/]*@/.test(rtsp) ? t.cameras.sources.urlHasPassword : "";
  const nameError = !/^[a-z0-9_]+$/.test(name) ? w.nameInvalid : name in config.cameras ? w.nameTaken : "";
  // a camera address becomes a video source (src/pages/Sources.tsx) named after the camera
  const sourceId = (() => {
    const base = name.replaceAll("_", "-");
    let id = base;
    for (let i = 2; id in config.sources; i++) id = `${base}-${i}`;
    return id;
  })();
  // step 2 with an address: one frame through go2rtc, with the password that is not saved yet
  useEffect(() => {
    if (step !== 2 || src !== "rtsp") return;
    let url: string | undefined;
    setProbe("idle");
    api.probeSource(rtsp, password).then(
      (blob) => setProbeImg((url = URL.createObjectURL(blob))),
      () => setProbe("ko"),
    );
    return () => {
      if (url) URL.revokeObjectURL(url);
      setProbeImg(undefined);
    };
  }, [step, src, rtsp, password]);
  const create = async () => {
    setBusy(true);
    const next: Config = structuredClone(config);
    if (src === "rtsp") {
      next.sources[sourceId] = { url: rtsp, ...(sub ? { sub } : {}) };
      if (password) await api.sourcePassword(sourceId, password).catch(() => undefined);
    }
    next.cameras[name] = {
      label: undefined,
      stream: { go2rtc: src === "go2rtc" ? stream : sourceId },
      detect: { width: size.width!, height: size.height!, fps: 5 },
      place: place || name,
      kind,
      zones: {},
      masks: {},
      observe: { presence: {}, ...(kind === "outdoor" ? { passages: { group: "street", merge_s: 15 } } : {}) },
    };
    if (await saveNow(next)) {
      onClose();
      navigate(`/cameras/${name}`);
    } else setBusy(false);
  };

  const steps = [w.steps.source, w.steps.test, w.steps.name];
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-scrim/80 px-4 py-16">
      <section role="dialog" aria-modal="true" aria-label={w.title} className="flex w-full max-w-[640px] flex-col gap-5 rounded-[18px] border border-line-strong bg-surface p-7">
        <div className="flex items-center justify-between">
          <h2 className="m-0 font-display text-[22px] font-semibold">{w.title}</h2>
          <Button variant="ghost" aria-label={w.close} onClick={onClose}>
            <Icon d={ICONS.close} />
          </Button>
        </div>
        <ol className="m-0 flex list-none gap-2 p-0 text-[13px]">
          {steps.map((s, i) => (
            <li key={s} className={`flex-1 rounded-lg px-2.5 py-2 ${i + 1 <= step ? "bg-accent-soft-strong text-accent-ink" : "bg-raised text-dim"}`}>
              {i + 1} · {s}
            </li>
          ))}
        </ol>

        {step === 1 && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2.5">
              <div role="group" aria-label={w.sourceLabel} className="flex flex-1 gap-2.5">
                {(["go2rtc", "rtsp"] as const).map((s) => (
                  <Button key={s} variant={src === s ? "soft" : "secondary"} className="flex-1" onClick={() => setSrc(s)}>
                    {s === "go2rtc" ? w.go2rtcStream : w.rtspUrl}
                  </Button>
                ))}
              </div>
              <Help label={w.sourceLabel}>{helpText(w.sourceHelp)}</Help>
            </div>
            {src === "go2rtc" ? (
              <Field label={w.stream} hint={w.streamHint} help={helpText(w.streamHelp)}>
                {free.length ? <Select value={stream} options={free.map((s) => s.name)} onChange={setStream} /> : <span className="text-sm text-ko-ink">{w.noFreeStream}</span>}
              </Field>
            ) : (
              <>
                <Field label={w.url} hint={rtspError || w.urlHint} help={helpText(w.urlHelp)}>
                  <TextInput value={rtsp} onChange={setRtsp} placeholder="rtsp://admin@192.0.2.10:554/Streaming/Channels/101" className="font-mono text-sm" />
                </Field>
                <Field label={w.sub} hint={w.subHint}>
                  <TextInput value={sub} onChange={setSub} placeholder="rtsp://admin@192.0.2.10:554/Streaming/Channels/102" className="font-mono text-sm" />
                </Field>
                <Field label={w.password} hint={w.passwordHint}>
                  <TextInput type="password" autoComplete="new-password" value={password} onChange={setPassword} />
                </Field>
              </>
            )}
            <div className="flex justify-end">
              <Button variant="primary" disabled={src === "go2rtc" ? !stream : !rtsp || !!rtspError} onClick={() => (setProbe("idle"), setStep(2))}>
                {w.testConnection}
              </Button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="flex flex-col gap-4">
            {src === "go2rtc" ? (
              <>
                <div className="overflow-hidden rounded-xl bg-video">
                  <img
                    src={`/api/streams/${encodeURIComponent(stream)}/frame.jpg`}
                    alt={w.frameAlt(stream)}
                    className="block w-full"
                    onLoad={(e) => {
                      setSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight });
                      setProbe("ok");
                    }}
                    onError={() => setProbe("ko")}
                  />
                </div>
                <div className="flex items-center gap-2.5 text-sm">
                  <Dot color={probe === "ok" ? "ok" : probe === "ko" ? "ko" : "dim"} />
                  {probe === "ok" ? w.connected(size.width, size.height) : probe === "ko" ? w.noFrame : w.connecting}
                </div>
              </>
            ) : probe !== "ko" ? (
              <>
                <div className="overflow-hidden rounded-xl bg-video">
                  {probeImg && (
                    <img
                      src={probeImg}
                      alt={w.frameAlt(sourceId)}
                      className="block w-full"
                      onLoad={(e) => {
                        setSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight });
                        setProbe("ok");
                      }}
                      onError={() => setProbe("ko")}
                    />
                  )}
                </div>
                <div className="flex items-center gap-2.5 text-sm">
                  <Dot color={probe === "ok" ? "ok" : "dim"} />
                  {probe === "ok" ? w.connected(size.width, size.height) : w.connecting}
                </div>
              </>
            ) : (
              <>
                <p className="m-0 flex items-center gap-2 text-sm text-muted">
                  {w.rtspNote}
                  <Help label={w.steps.test}>{helpText(w.rtspHelp)}</Help>
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label={w.width}>
                    <NumberInput value={size.width} min={1} onChange={(width) => setSize((s) => ({ ...s, width }))} />
                  </Field>
                  <Field label={w.height}>
                    <NumberInput value={size.height} min={1} onChange={(height) => setSize((s) => ({ ...s, height }))} />
                  </Field>
                </div>
              </>
            )}
            <div className="flex justify-end gap-2.5">
              <Button onClick={() => setStep(1)}>{w.back}</Button>
              <Button variant="primary" disabled={!size.width || !size.height} onClick={() => setStep(3)}>
                {w.next}
              </Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="flex flex-col gap-4">
            <Field label={w.name} hint={name && nameError ? nameError : w.nameHint} help={w.nameHelp}>
              <TextInput value={name} onChange={setName} placeholder={w.namePlaceholder} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={w.place} help={w.placeHelp}>
                <TextInput value={place} onChange={setPlace} placeholder={name || w.namePlaceholder} list="places" />
                <datalist id="places">
                  {places.map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
              </Field>
              <Field label={w.kind} help={w.kindHelp}>
                <Select value={kind} options={[["indoor", t.events.kind.indoor], ["outdoor", t.events.kind.outdoor]] as const} onChange={setKind} />
              </Field>
            </div>
            <p className="m-0 flex items-center gap-2 text-[13px] text-dim">
              {w.detectNote}
              <Help label={w.steps.name}>{w.detectHelp}</Help>
            </p>
            <div className="flex justify-end gap-2.5">
              <Button onClick={() => setStep(2)}>{w.back}</Button>
              <Button variant="primary" disabled={!!nameError || busy} onClick={() => void create()}>
                {w.create}
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
