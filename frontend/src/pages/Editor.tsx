import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { api, type Activity, type AnalyzerStatus, type Camera, type Config, type TryResult } from "../api.ts";
import { useApp } from "../App.tsx";
import { Button, Card, Chips, ConfirmButton, EmptyState, Field, Help, Icon, ICONS, LiveVideo, NumberInput, Select, Switch, TextInput, HelpList } from "../ui.tsx";
import { aspectOf, previewStream } from "./Cameras.tsx";
import { useLocale, useT } from "../i18n/index.tsx";
import { decimal, humanize, place } from "../i18n/format.ts";

type Point = [number, number];
type ShapeKind = "zone" | "mask";
type Selected = { kind: ShapeKind; name: string } | null;
/** A shape being drawn; `replace` names the existing shape whose points it will replace (redraw). */
type Drawing = { kind: ShapeKind; points: Point[]; replace?: string };

const TABS = ["zone", "observe", "vlm", "settings"] as const;
// the defaults of perception-service/src/settings.ts (here without importing zod into the bundle)
const LOOK = { memory: false, before_s: 10, after_s: 4 };
type Tab = (typeof TABS)[number];

const round = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;

export function Editor({ name }: { name: string }) {
  const { draft, edit, streams, navigate } = useApp();
  const t = useT();
  const cam = draft.cameras[name];
  const [tab, setTab] = useState<Tab>("zone");
  const [selected, setSelected] = useState<Selected>(() => {
    const z = cam && Object.keys(cam.zones)[0];
    return z ? { kind: "zone", name: z } : null;
  });
  const [drawing, setDrawing] = useState<Drawing | null>(null);

  if (!cam) {
    return (
      <div className="flex flex-col items-start gap-4">
        <p className="text-muted">{t.editor.missing(name)}</p>
        <Button onClick={() => navigate("/cameras")}>{t.editor.back}</Button>
      </div>
    );
  }
  const editCam = (fn: (c: Camera, d: Config) => void) => edit((d) => fn(d.cameras[name]!, d));
  const stream = cam.stream && "go2rtc" in cam.stream ? `go2rtc ${cam.stream.go2rtc}` : cam.stream ? "RTSP" : t.editor.noStream;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <Button aria-label={t.editor.back} onClick={() => navigate("/cameras")} className="w-11 px-0">
            <Icon d={ICONS.back} />
          </Button>
          <div className="flex flex-col gap-0.5">
            <h1 className="m-0 font-display text-2xl font-semibold">{cam.label ?? name}</h1>
            <span className="text-[13px] text-muted">
              {name} · {place(t, cam.place)} · {t.events.kind[cam.kind]} · {cam.detect ? t.editor.detect(cam.detect.width, cam.detect.height, cam.detect.fps) : t.editor.noDetect} · {stream}
            </span>
          </div>
        </div>
        <div role="tablist" aria-label={t.editor.tabs.label} className="flex flex-wrap gap-2">
          {TABS.map((id) => (
            <Button key={id} role="tab" aria-selected={tab === id} variant={tab === id ? "soft" : "secondary"} onClick={() => setTab(id)}>
              {t.editor.tabs[id]}
            </Button>
          ))}
        </div>
      </header>

      <div className="flex flex-wrap items-start gap-6">
        {/* zones are drawn on the large video; the other tabs need more room for their forms */}
        <section aria-label={t.editor.preview} className={`flex min-w-0 flex-col gap-3 ${tab === "zone" ? "flex-[999_1_640px]" : "flex-[1_1_420px]"}`}>
          <div className="overflow-hidden rounded-[14px] border border-line">
            <LiveVideo stream={previewStream(cam, streams, false)} camera={name} aspect={aspectOf(cam)}>
              <ShapeEditor
                cam={cam}
                interactive={tab === "zone"}
                selected={selected}
                onSelect={setSelected}
                drawing={drawing}
                onDraw={setDrawing}
                onMove={(sel, i, p) =>
                  editCam((c) => {
                    const pts = sel.kind === "zone" ? c.zones[sel.name]!.points : c.masks[sel.name]!;
                    pts[i] = p;
                  })
                }
                onInsert={(sel, i, p) =>
                  editCam((c) => {
                    const pts = sel.kind === "zone" ? c.zones[sel.name]!.points : c.masks[sel.name]!;
                    pts.splice(i, 0, p);
                  })
                }
                onRemovePoint={(sel, i) =>
                  editCam((c) => {
                    const pts = sel.kind === "zone" ? c.zones[sel.name]!.points : c.masks[sel.name]!;
                    if (pts.length > 3) pts.splice(i, 1);
                  })
                }
              />
            </LiveVideo>
          </div>
          <p className="m-0 text-[13px] text-dim">
            {drawing ? (
              t.editor.drawingHelp(drawing.points.length)
            ) : (
              <>
                {t.editor.editHelp} <Help label={t.editor.editHelpTitle}><HelpList items={t.editor.editHelpMore} /></Help>
              </>
            )}
          </p>
        </section>

        <aside className={`flex min-w-0 flex-col gap-4 ${tab === "zone" ? "flex-[1_1_360px]" : "flex-[2_1_560px]"}`}>
          {tab === "zone" && <ZonePanel name={name} cam={cam} selected={selected} onSelect={setSelected} drawing={drawing} onDraw={setDrawing} />}
          {tab === "observe" && <ObservePanel name={name} cam={cam} />}
          {tab === "vlm" && <VlmPanel name={name} cam={cam} onOpenObserve={() => setTab("observe")} />}
          {tab === "settings" && <SettingsPanel name={name} cam={cam} />}
        </aside>
      </div>
    </div>
  );
}

function shapesOf(cam: Camera): { kind: ShapeKind; name: string; points: Point[] }[] {
  return [
    ...Object.entries(cam.masks).map(([name, points]) => ({ kind: "mask" as const, name, points })),
    ...Object.entries(cam.zones).map(([name, z]) => ({ kind: "zone" as const, name, points: z.points })),
  ];
}

/** Zones and masks over the video: SVG polygons, points as buttons (draggable and keyboard-operable). */
function ShapeEditor(p: {
  cam: Camera;
  interactive: boolean;
  selected: Selected;
  onSelect(s: Selected): void;
  drawing: Drawing | null;
  onDraw(d: Drawing | null): void;
  onMove(s: NonNullable<Selected>, i: number, pt: Point): void;
  onInsert(s: NonNullable<Selected>, i: number, pt: Point): void;
  onRemovePoint(s: NonNullable<Selected>, i: number): void;
}) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ sel: NonNullable<Selected>; i: number } | null>(null);
  const at = (e: { clientX: number; clientY: number }): Point => {
    const r = box.current!.getBoundingClientRect();
    return [round((e.clientX - r.left) / r.width), round((e.clientY - r.top) / r.height)];
  };
  const shapes = shapesOf(p.cam);
  const sel = p.selected && shapes.find((s) => s.kind === p.selected!.kind && s.name === p.selected!.name);

  const startDrag = (e: ReactPointerEvent, s: NonNullable<Selected>, i: number) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { sel: s, i };
  };
  const onMove = (e: ReactPointerEvent) => {
    if (drag.current) p.onMove(drag.current.sel, drag.current.i, at(e));
  };

  return (
    <div
      ref={box}
      className={`absolute inset-0 ${p.interactive ? "" : "pointer-events-none"} ${p.drawing ? "cursor-crosshair" : ""}`}
      onPointerMove={onMove}
      onPointerUp={() => (drag.current = null)}
      onClick={(e) => {
        if (p.drawing) p.onDraw({ ...p.drawing, points: [...p.drawing.points, at(e)] });
      }}
    >
      <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" role="img" aria-label={t.editor.shapes.label}>
        {shapes.map((s) => {
          const active = sel === s;
          const zone = s.kind === "zone";
          return (
            <polygon
              key={`${s.kind}:${s.name}`}
              points={s.points.map((q) => q.join(",")).join(" ")}
              fill={zone ? (active ? "#F2A33A40" : "#F2A33A26") : active ? "#7A869850" : "#7A869833"}
              stroke={zone ? "#F2A33A" : "#9AA5B4"}
              strokeWidth={active ? 2 : 1.25}
              strokeDasharray={zone ? undefined : "6 4"}
              vectorEffect="non-scaling-stroke"
              className={p.interactive && !p.drawing ? "cursor-pointer" : ""}
              onClick={(e) => {
                if (p.drawing) return;
                e.stopPropagation();
                p.onSelect({ kind: s.kind, name: s.name });
              }}
            />
          );
        })}
        {p.drawing && p.drawing.points.length > 0 && (
          <polyline points={p.drawing.points.map((q) => q.join(",")).join(" ")} fill="none" stroke="#7DB4FF" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      {shapes.map((s) => (
        <span
          key={`l:${s.kind}:${s.name}`}
          className={`pointer-events-none absolute -translate-x-1/2 rounded-md px-2 py-0.5 text-xs font-semibold ${s.kind === "zone" ? "bg-amber-soft/90 text-amber-ink" : "bg-ground/80 text-muted"}`}
          style={{ left: `${(s.points.reduce((a, q) => a + q[0], 0) / s.points.length) * 100}%`, top: `${(s.points.reduce((a, q) => a + q[1], 0) / s.points.length) * 100}%` }}
        >
          {s.name}
        </span>
      ))}
      {p.interactive && sel && !p.drawing && (
        <>
          {sel.points.map((q, i) => {
            const next = sel.points[(i + 1) % sel.points.length]!;
            const mid: Point = [round((q[0] + next[0]) / 2), round((q[1] + next[1]) / 2)];
            return (
              <button
                key={`m${i}`}
                type="button"
                aria-label={t.editor.shapes.insert(i + 1, ((i + 1) % sel.points.length) + 1)}
                className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-accent bg-ground/80"
                style={{ left: `${mid[0] * 100}%`, top: `${mid[1] * 100}%` }}
                onPointerDown={(e) => {
                  p.onInsert(sel, i + 1, mid);
                  startDrag(e, sel, i + 1);
                }}
                onClick={(e) => e.stopPropagation()}
              />
            );
          })}
          {sel.points.map((q, i) => (
            <button
              key={`v${i}`}
              type="button"
              aria-label={t.editor.shapes.point(i + 1, sel.name)}
              className={`absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 ${sel.kind === "zone" ? "border-amber bg-ground" : "border-[#c9d1d9] bg-ground"}`}
              style={{ left: `${q[0] * 100}%`, top: `${q[1] * 100}%`, touchAction: "none" }}
              onPointerDown={(e) => startDrag(e, sel, i)}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => {
                e.stopPropagation();
                p.onRemovePoint(sel, i);
              }}
              onKeyDown={(e) => {
                const d = e.shiftKey ? 0.02 : 0.005;
                const moves: Record<string, Point> = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] };
                if (moves[e.key]) {
                  e.preventDefault();
                  p.onMove(sel, i, [round(q[0] + moves[e.key]![0]), round(q[1] + moves[e.key]![1])]);
                } else if (e.key === "Delete" || e.key === "Backspace") p.onRemovePoint(sel, i);
              }}
            />
          ))}
        </>
      )}
    </div>
  );
}

function ZonePanel({ name, cam, selected, onSelect, drawing, onDraw }: {
  name: string;
  cam: Camera;
  selected: Selected;
  onSelect(s: Selected): void;
  drawing: Drawing | null;
  onDraw(d: Drawing | null): void;
}) {
  const { draft, edit } = useApp();
  const t = useT();
  const z = t.editor.zones;
  const [newName, setNewName] = useState("");
  const shapes = shapesOf(cam);
  const zone = selected?.kind === "zone" ? cam.zones[selected.name] : undefined;
  const editCam = (fn: (c: Camera) => void) => edit((d) => fn(d.cameras[name]!));
  const exists = (n: string) => n in cam.zones || n in cam.masks;
  const shapeName = drawing?.replace ?? newName;
  const nameOk = !!drawing?.replace || (/^[a-z0-9_]+$/.test(newName) && !exists(newName));
  // why "Close the shape" is disabled, said in words instead of a silently greyed button
  const missing = !drawing
    ? null
    : drawing.points.length < 3
      ? z.missingPoints(3 - drawing.points.length)
      : !newName && !drawing.replace
        ? z.needName
        : !nameOk
          ? z.nameTaken(newName)
          : null;
  const close = () => {
    if (!drawing || missing) return;
    editCam((c) => {
      if (drawing.kind === "zone") {
        const old = c.zones[shapeName];
        c.zones[shapeName] = old ? { ...old, points: drawing.points } : { points: drawing.points, objects: ["person"], inertia: 3, loitering_time: 0 };
      } else c.masks[shapeName] = drawing.points;
    });
    onSelect({ kind: drawing.kind, name: shapeName });
    onDraw(null);
    setNewName("");
  };

  const usedBy = (zn: string) => [
    ...(cam.observe.approach?.zone === zn ? [z.usedByApproach] : []),
    ...draft.rules.filter((r) => r.when.zone === zn).map((r) => z.usedByRule(r.name)),
  ];

  const addButtons = (
    <div className="flex flex-wrap gap-2">
      <Button variant="ghost" className="border border-dashed border-line-strong" onClick={() => onDraw({ kind: "zone", points: [] })}>
        {z.addZone}
      </Button>
      <Button variant="ghost" className="border border-dashed border-line-strong" onClick={() => onDraw({ kind: "mask", points: [] })}>
        {z.addMask}
      </Button>
    </div>
  );

  if (drawing) {
    return (
      <Card className="flex flex-col gap-4 p-5">
        <h2 className="m-0 text-base font-semibold">
          {drawing.replace ? z.redrawTitle(drawing.replace) : drawing.kind === "zone" ? z.newZone : z.newMask}
        </h2>
        {drawing.replace ? (
          <p className="m-0 text-[13px] text-muted">{z.redrawHint}</p>
        ) : (
          <Field label={z.name} hint={z.nameHint} help={z.nameHelp}>
            <TextInput
              value={newName}
              onChange={(v) =>
                setNewName(
                  v
                    .toLowerCase()
                    .normalize("NFD")
                    .replace(/[\u0300-\u036f]/g, "")
                    .replace(/[\s-]+/g, "_")
                    .replace(/[^a-z0-9_]/g, ""),
                )
              }
              autoFocus
            />
          </Field>
        )}
        <div className="flex flex-wrap gap-2.5">
          <Button
            variant="primary"
            disabled={!!missing}
            onClick={close}
          >
            {z.close(drawing.points.length)}
          </Button>
          <Button onClick={() => onDraw({ ...drawing, points: drawing.points.slice(0, -1) })} disabled={!drawing.points.length}>
            {z.undoLast}
          </Button>
          <Button variant="ghost" onClick={() => onDraw(null)}>
            {z.cancel}
          </Button>
        </div>
        {missing && (
          <p role="status" className="m-0 text-[13px] text-amber-ink">
            {missing}
          </p>
        )}
      </Card>
    );
  }

  return (
    <>
      {shapes.length === 0 ? (
        <EmptyState title={z.emptyTitle} text={z.emptyText} action={addButtons} />
      ) : (
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex flex-wrap gap-2">
          {shapes.map((s) => {
            const on = selected?.kind === s.kind && selected.name === s.name;
            return (
              <Button key={`${s.kind}:${s.name}`} variant={on ? "soft" : "secondary"} onClick={() => onSelect({ kind: s.kind, name: s.name })} className={s.kind === "zone" && on ? "!border-amber !bg-amber-soft !text-amber-ink" : ""}>
                {s.kind === "zone" ? z.zone : z.mask} · {s.name}
              </Button>
            );
          })}
        </div>
        {addButtons}
      </Card>
      )}

      {selected && zone && (
        <Card className="flex flex-col gap-3.5 p-5">
          <h2 className="m-0 flex items-center gap-2 text-base font-semibold">
            {z.zoneTitle(selected.name)} <Help label={z.zoneTitle(selected.name)}>{z.zoneHelp}</Help>
          </h2>
          <Field label={z.objects} hint={z.objectsHint} help={z.objectsHelp}>
            <TextInput
              value={(zone.objects ?? []).join(", ")}
              onChange={(v) =>
                editCam((c) => {
                  const objs = v.split(",").map((s) => s.trim()).filter(Boolean);
                  c.zones[selected.name]!.objects = objs.length ? objs : undefined;
                })
              }
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={z.inertia} hint={z.inertiaHint} help={z.inertiaHelp}>
              <NumberInput value={zone.inertia} min={1} onChange={(v) => editCam((c) => void (c.zones[selected.name]!.inertia = v))} />
            </Field>
            <Field label={z.loitering} help={z.loiteringHelp}>
              <NumberInput value={zone.loitering_time} min={0} onChange={(v) => editCam((c) => void (c.zones[selected.name]!.loitering_time = v))} />
            </Field>
          </div>
          <p className="m-0 text-[13px] text-dim">{usedBy(selected.name).length ? z.usedBy(usedBy(selected.name).join(", ")) : z.unused}</p>
          <div className="flex flex-wrap gap-2.5">
            <Button onClick={() => onDraw({ kind: "zone", points: [], replace: selected.name })}>{z.redraw}</Button>
            <ConfirmButton
              confirm={z.confirmRemoveZone}
              onConfirm={() => {
                editCam((c) => void delete c.zones[selected.name]);
                onSelect(null);
              }}
            >
              <Icon d={ICONS.trash} /> {z.removeZone}
            </ConfirmButton>
          </div>
        </Card>
      )}
      {selected?.kind === "mask" && cam.masks[selected.name] && (
        <Card className="flex flex-col gap-3.5 p-5">
          <h2 className="m-0 flex items-center gap-2 text-base font-semibold">
            {z.maskTitle(selected.name)} <Help label={z.maskTitle(selected.name)}>{z.maskHelp}</Help>
          </h2>
          <p className="m-0 text-[13px] text-muted">{z.maskHint}</p>
          <div className="flex flex-wrap gap-2.5">
            <Button onClick={() => onDraw({ kind: "mask", points: [], replace: selected.name })}>{z.redraw}</Button>
            <ConfirmButton
              confirm={z.confirmRemoveMask}
              onConfirm={() => {
                editCam((c) => void delete c.masks[selected.name]);
                onSelect(null);
              }}
            >
              <Icon d={ICONS.trash} /> {z.removeMask}
            </ConfirmButton>
          </div>
        </Card>
      )}
    </>
  );
}

function ObservePanel({ name, cam }: { name: string; cam: Camera }) {
  const { draft, edit } = useApp();
  const t = useT();
  const ob = t.editor.observe;
  const o = cam.observe;
  const editObs = (fn: (o: Camera["observe"]) => void) => edit((d) => fn(d.cameras[name]!.observe));
  const vocab = Object.keys(draft.analyzers.vlm.vocabulary);
  const zones = Object.keys(cam.zones);
  const groups = [...new Set(Object.values(draft.cameras).flatMap((c) => (c.observe.passages ? [c.observe.passages.group] : [])))];
  const [analyzers, setAnalyzers] = useState<AnalyzerStatus[]>([]);
  useEffect(() => void api.analyzers().then(setAnalyzers, () => undefined), []);
  // available posture models: endpoint/model with the pose_estimation task
  const poseModels = analyzers.flatMap((a) => a.models.filter((m) => m.task === "pose_estimation").map((m) => [a.name, m.name] as const));
  // zero-shot models (CLIP) for left objects
  const clipModels = analyzers.flatMap((a) => a.models.filter((m) => m.task === "zero_shot_classification").map((m) => [a.name, m.name] as const));

  return (
    <div className="flex flex-col gap-3">
      <ObsItem title={ob.presence.title} on={!!o.presence} onToggle={(v) => editObs((x) => (v ? (x.presence = {}) : delete x.presence))} desc={ob.presence.desc} />
      <ObsItem
        title={ob.activity.title}
        on={!!o.activity}
        onToggle={(v) =>
          editObs((x) => {
            if (v) x.activity = { analyzer: "vlm", rules: [], default: vocab.includes("other") ? "other" : vocab.includes("altro") ? "altro" : vocab[0]!, interval_s: 20, stable_s: 120 };
            else delete x.activity;
          })
        }
        desc={ob.activity.desc}
        help={ob.activity.help}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label={ob.sampleEvery}>
            <NumberInput value={o.activity?.interval_s} min={1} onChange={(v) => editObs((x) => void (x.activity!.interval_s = v ?? 20))} />
          </Field>
          <Field label={ob.stableAfter}>
            <NumberInput value={o.activity?.stable_s} min={1} onChange={(v) => editObs((x) => void (x.activity!.stable_s = v ?? 120))} />
          </Field>
        </div>
      </ObsItem>
      <ObsItem
        title={ob.passages.title}
        on={!!o.passages}
        onToggle={(v) =>
          editObs((x) => {
            if (v) x.passages = { group: groups[0] ?? "street", merge_s: 15 };
            else {
              delete x.passages;
              delete x.approach;
            }
          })
        }
        desc={ob.passages.desc}
        help={ob.passages.help}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label={ob.passages.group}>
            <TextInput value={o.passages?.group ?? ""} list="groups" onChange={(v) => editObs((x) => void (x.passages!.group = v))} />
            <datalist id="groups">
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </Field>
          <Field label={ob.passages.merge}>
            <NumberInput value={o.passages?.merge_s} min={0} onChange={(v) => editObs((x) => void (x.passages!.merge_s = v ?? 15))} />
          </Field>
        </div>
      </ObsItem>
      <ObsItem
        title={ob.approach.title}
        on={!!o.approach}
        disabled={!o.passages ? ob.approach.needsPassages : zones.length === 0 ? ob.needsZone : undefined}
        onToggle={(v) => editObs((x) => (v ? (x.approach = { zone: zones[0]! }) : delete x.approach))}
        desc={ob.approach.desc}
      >
        <Field label={ob.zone}>
          <Select value={o.approach?.zone ?? ""} options={zones} onChange={(v) => editObs((x) => void (x.approach!.zone = v))} />
        </Field>
      </ObsItem>
      <ObsItem
        title={ob.posture.title}
        on={!!o.posture}
        disabled={poseModels.length === 0 ? ob.posture.noModel : undefined}
        onToggle={(v) =>
          editObs((x) => {
            if (v) x.posture = { analyzer: poseModels[0]![0], model: poseModels[0]![1], interval_s: 5, stable_s: 15, rest_zones: [], no_rest_place: false };
            else delete x.posture;
          })
        }
        desc={ob.posture.desc}
        help={ob.posture.help}
      >
        <Field label={ob.model}>
          <Select
            value={o.posture ? `${o.posture.analyzer}/${o.posture.model}` : ""}
            options={poseModels.map(([a, m]) => `${a}/${m}`)}
            onChange={(v) =>
              editObs((x) => {
                const [analyzer, model] = v.split("/") as [string, string];
                Object.assign(x.posture!, { analyzer, model });
              })
            }
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={ob.sampleEvery}>
            <NumberInput value={o.posture?.interval_s} min={1} onChange={(v) => editObs((x) => void (x.posture!.interval_s = v ?? 5))} />
          </Field>
          <Field label={ob.stableAfter} hint={ob.posture.stableHint}>
            <NumberInput value={o.posture?.stable_s} min={1} onChange={(v) => editObs((x) => void (x.posture!.stable_s = v ?? 15))} />
          </Field>
        </div>
        {o.posture?.no_rest_place ? null : (
          <Field
            label={ob.posture.restZones}
            hint={zones.length ? ob.posture.restZonesHint : ob.posture.restZonesNone}
            help={zones.length ? ob.posture.restZonesHelp : undefined}
          >
            <Chips label={ob.posture.restZones} options={zones} value={o.posture?.rest_zones ?? []} onChange={(v) => editObs((x) => void (x.posture!.rest_zones = v))} />
          </Field>
        )}
        {!o.posture?.rest_zones.length && (
          <div className="flex flex-col gap-1">
            <Switch
              label={ob.posture.noRestPlace}
              checked={!!o.posture?.no_rest_place}
              onChange={(v) => editObs((x) => void (x.posture!.no_rest_place = v))}
            />
            <span className="text-[13px] text-dim">{ob.posture.noRestPlaceHint}</span>
          </div>
        )}
      </ObsItem>
      <ObsItem
        title={ob.leftObject.title}
        on={!!o.left_object}
        disabled={zones.length === 0 ? ob.needsZone : clipModels.length === 0 ? ob.leftObject.noModel : undefined}
        onToggle={(v) =>
          editObs((x) => {
            if (v) x.left_object = { zone: zones[0]!, analyzer: clipModels[0]![0], model: clipModels[0]![1], check_s: 20, persist_s: 90, min_score: 0.5, min_cells: 2 };
            else delete x.left_object;
          })
        }
        desc={ob.leftObject.desc}
        help={ob.leftObject.help}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label={ob.leftObject.zone}>
            <Select value={o.left_object?.zone ?? ""} options={zones} onChange={(v) => editObs((x) => void (x.left_object!.zone = v))} />
          </Field>
          <Field label={ob.model}>
            <Select
              value={o.left_object ? `${o.left_object.analyzer}/${o.left_object.model}` : ""}
              options={clipModels.map(([a, m]) => `${a}/${m}`)}
              onChange={(v) =>
                editObs((x) => {
                  const [analyzer, model] = v.split("/") as [string, string];
                  Object.assign(x.left_object!, { analyzer, model });
                })
              }
            />
          </Field>
          <Field label={ob.leftObject.checkEvery}>
            <NumberInput value={o.left_object?.check_s} min={5} onChange={(v) => editObs((x) => void (x.left_object!.check_s = v ?? 20))} />
          </Field>
          <Field label={ob.leftObject.persist} hint={ob.leftObject.persistHint}>
            <NumberInput value={o.left_object?.persist_s} min={10} onChange={(v) => editObs((x) => void (x.left_object!.persist_s = v ?? 90))} />
          </Field>
        </div>
      </ObsItem>
    </div>
  );
}

function ObsItem({ title, on, onToggle, desc, help, disabled, children }: { title: string; on: boolean; onToggle(v: boolean): void; desc: string; help?: ReactNode; disabled?: string; children?: ReactNode }) {
  const t = useT();
  return (
    <Card className="flex flex-col gap-3 px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-[15px] font-semibold">
          {title}
          {help && <Help label={title}>{help}</Help>}
        </span>
        {disabled && !on ? <span className="text-[13px] text-dim">{disabled}</span> : <Switch checked={on} onChange={onToggle} label={t.editor.observe.enable(title)} />}
      </div>
      <span className="text-[13px] leading-relaxed text-muted">{desc}</span>
      {on && children}
    </Card>
  );
}

function VlmPanel({ name, cam, onOpenObserve }: { name: string; cam: Camera; onOpenObserve(): void }) {
  const { draft, edit, notify } = useApp();
  const t = useT();
  const { locale } = useLocale();
  const ac = t.editor.activity;
  const a = cam.observe.activity;
  const { vocabulary, attributes, model } = draft.analyzers.vlm;
  const [tried, setTried] = useState<TryResult | null>(null);
  const [busy, setBusy] = useState(false);
  const editAct = (fn: (a: Activity) => void) => edit((d) => fn(d.cameras[name]!.observe.activity!));
  const vocab = Object.keys(vocabulary);
  const attrs = Object.keys(attributes);

  const [analyzers, setAnalyzers] = useState<AnalyzerStatus[]>([]);
  useEffect(() => void api.analyzers().then(setAnalyzers, () => undefined), []);
  const fastModels = analyzers.flatMap((x) => x.models.filter((m) => m.task === "zero_shot_classification").map((m) => [x.name, m.name, m.outputs] as const));

  if (!a) return <EmptyState title={ac.inactiveTitle} text={ac.inactiveText} action={<Button onClick={onOpenObserve}>{ac.openObserve}</Button>} />;

  const addRule = (
    <Button variant="ghost" className="self-start border border-dashed border-line-strong" disabled={!attrs.length} onClick={() => editAct((x) => void x.rules.push({ if: { [attrs[0]!]: true }, then: x.default }))}>
      {ac.addRule}
    </Button>
  );

  return (
    <>
      <Card className="flex flex-col gap-3.5 p-5">
        <h2 className="m-0 flex items-center gap-2 text-base font-semibold">
          {ac.rulesTitle} <Help label={ac.rulesTitle}><HelpList items={ac.rulesHelp} /></Help>
        </h2>
        <p className="m-0 text-[13px] text-muted">{ac.rulesHint}</p>
        {a.rules.length === 0 ? (
          <EmptyState title={ac.noRulesTitle} text={ac.noRulesText} action={addRule} />
        ) : (
        <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
          {a.rules.map((r, i) => (
            <li key={i} className="flex flex-col gap-2 rounded-xl border border-line bg-ground p-3">
              {Object.entries(r.if).map(([attr, val]) => (
                <div key={attr} className="flex items-center gap-2">
                  <span className="w-6 text-[13px] text-muted">{ac.if}</span>
                  <div className="min-w-0 flex-1">
                    <Select
                      value={attr}
                      options={attrs.map((x) => [x, humanize(x)] as [string, string])}
                      onChange={(nv) =>
                        editAct((x) => {
                          const cond = x.rules[i]!.if;
                          const v = cond[attr]!;
                          delete cond[attr];
                          cond[nv] = v;
                        })
                      }
                    />
                  </div>
                  <Button variant={val ? "soft" : "secondary"} className="w-16" onClick={() => editAct((x) => void (x.rules[i]!.if[attr] = !val))}>
                    {val ? ac.yes : ac.no}
                  </Button>
                  <Button variant="ghost" aria-label={ac.removeCondition} className="w-11 px-0" onClick={() => editAct((x) => void delete x.rules[i]!.if[attr])}>
                    <Icon d={ICONS.close} />
                  </Button>
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="ghost"
                  className="border border-dashed border-line-strong"
                  disabled={attrs.every((x) => x in r.if)}
                  onClick={() => editAct((x) => void (x.rules[i]!.if[attrs.find((y) => !(y in r.if))!] = true))}
                >
                  {ac.addCondition}
                </Button>
                <span className="text-[13px] text-muted">→</span>
                <div className="min-w-[160px] flex-1">
                  <Select value={r.then} options={vocab} onChange={(v) => editAct((x) => void (x.rules[i]!.then = v))} />
                </div>
                <Button variant="ghost" aria-label={ac.moveUp} className="w-11 px-0" disabled={i === 0} onClick={() => editAct((x) => void x.rules.splice(i - 1, 0, x.rules.splice(i, 1)[0]!))}>
                  <Icon d={ICONS.up} />
                </Button>
                <Button variant="ghost" aria-label={ac.moveDown} className="w-11 px-0" disabled={i === a.rules.length - 1} onClick={() => editAct((x) => void x.rules.splice(i + 1, 0, x.rules.splice(i, 1)[0]!))}>
                  <Icon d={ICONS.down} />
                </Button>
                <Button variant="ghost" aria-label={ac.removeRule} className="w-11 px-0" onClick={() => editAct((x) => void x.rules.splice(i, 1))}>
                  <Icon d={ICONS.trash} />
                </Button>
              </div>
            </li>
          ))}
        </ol>
        )}
        {a.rules.length > 0 && addRule}
        {!attrs.length && <p className="m-0 text-[13px] text-dim">{ac.noQuestions}</p>}
        <Field label={ac.otherwise}>
          <Select value={a.default} options={vocab} onChange={(v) => editAct((x) => void (x.default = v))} />
        </Field>
        <Button
          variant="soft"
          className="self-start"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            api.tryActivity(name, a).then(
              (r) => (setTried(r.result), setBusy(false)),
              (e: Error) => (notify("error", ac.tryFailed(e.message)), setBusy(false)),
            );
          }}
        >
          {busy ? ac.trying : ac.tryNow}
        </Button>
        {tried && (
          <div className="rounded-[10px] border border-line-strong bg-ground px-3.5 py-3 text-[13px] leading-relaxed">
            {tried.error ? (
              <span className="text-ko-ink">{tried.error}</span>
            ) : (
              <>
                <div>
                  <span className="text-muted">{ac.answers}</span>
                  {Object.entries(tried.attributes ?? {}).map(([k, v]) => `${humanize(k)} ${v ? ac.yes : ac.no}`).join(" · ")}
                </div>
                <div>
                  <span className="text-muted">{ac.result}</span>
                  <strong>{tried.label}</strong> · {tried.model} · {decimal(locale, (tried.ms ?? 0) / 1000, 1)} s
                </div>
              </>
            )}
          </div>
        )}
      </Card>
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="m-0 flex items-center gap-2 text-base font-semibold">
            {ac.fastTitle} <Help label={ac.fastTitle}>{ac.fastHelp}</Help>
          </h2>
          {fastModels.length === 0 && !a.fast ? (
            <span className="text-[13px] text-dim">{ac.fastNoModel}</span>
          ) : (
            <Switch
              checked={!!a.fast}
              label={ac.fastEnable}
              onChange={(v) => editAct((x) => (v ? (x.fast = { analyzer: fastModels[0]![0], model: fastModels[0]![1], min_score: 0.6 }) : delete x.fast))}
            />
          )}
        </div>
        <p className="m-0 text-[13px] text-muted">{ac.fastHint}</p>
        {a.fast && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t.editor.observe.model}>
                <Select
                  value={`${a.fast.analyzer}/${a.fast.model}`}
                  options={fastModels.map(([x, m]) => `${x}/${m}`)}
                  onChange={(v) => editAct((x) => {
                    const [analyzer, model] = v.split("/") as [string, string];
                    Object.assign(x.fast!, { analyzer, model });
                  })}
                />
              </Field>
              <Field label={ac.minScore}>
                <NumberInput value={a.fast.min_score} min={0} step={0.05} onChange={(v) => editAct((x) => void (x.fast!.min_score = v ?? 0.6))} />
              </Field>
            </div>
            {(() => {
              const outs = fastModels.find(([x, m]) => x === a.fast!.analyzer && m === a.fast!.model)?.[2] ?? [];
              const missing = outs.filter((o) => !(o in vocabulary));
              return missing.length ? <p className="m-0 text-[13px] text-amber-ink">{ac.outsideVocabulary(missing.join(", "))}</p> : null;
            })()}
          </>
        )}
      </Card>
      <Catalog />
      <p className="m-0 text-[13px] text-dim">{ac.modelInUse(model)}</p>
    </>
  );
}

/** Questions and activities shared by all cameras. */
function Catalog() {
  const { draft, edit } = useApp();
  const t = useT();
  const c = t.editor.activity.catalog;
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"attributes" | "vocabulary">("attributes");
  const [newKey, setNewKey] = useState("");
  const items = draft.analyzers.vlm[kind];
  const used = new Set(
    Object.values(draft.cameras).flatMap((c) => {
      const a = c.observe.activity;
      if (!a) return [];
      return kind === "attributes" ? a.rules.flatMap((r) => Object.keys(r.if)) : [...a.rules.map((r) => r.then), a.default];
    }),
  );
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-center gap-2">
        <button type="button" className="flex min-h-11 flex-1 items-center justify-between gap-2 text-left text-base font-semibold" aria-expanded={open} onClick={() => setOpen(!open)}>
          {c.title}
          <Icon d={open ? ICONS.up : ICONS.down} />
        </button>
        <Help label={c.title}>{c.help}</Help>
      </div>
      {open && (
        <>
          <div className="flex gap-2">
            <Button variant={kind === "attributes" ? "soft" : "secondary"} onClick={() => setKind("attributes")}>
              {c.questions}
            </Button>
            <Button variant={kind === "vocabulary" ? "soft" : "secondary"} onClick={() => setKind("vocabulary")}>
              {c.activities}
            </Button>
          </div>
          {Object.keys(items).length === 0 && <p className="m-0 text-sm text-dim">{kind === "attributes" ? c.emptyQuestions : c.emptyActivities}</p>}
          {Object.entries(items).map(([k, desc]) => (
            <Field key={k} label={humanize(k)}>
              <div className="flex gap-2">
                <TextInput value={desc} onChange={(v) => edit((d) => void (d.analyzers.vlm[kind][k] = v))} />
                <Button variant="ghost" aria-label={c.remove(k)} className="w-11 shrink-0 px-0" disabled={used.has(k)} title={used.has(k) ? c.usedByRule : undefined} onClick={() => edit((d) => void delete d.analyzers.vlm[kind][k])}>
                  <Icon d={ICONS.trash} />
                </Button>
              </div>
            </Field>
          ))}
          <div className="flex gap-2">
            <TextInput value={newKey} onChange={setNewKey} placeholder={kind === "attributes" ? c.newQuestion : c.newActivity} />
            <Button
              disabled={!/^[a-z0-9_]+$/.test(newKey) || newKey in items}
              onClick={() => {
                edit((d) => void (d.analyzers.vlm[kind][newKey] = ""));
                setNewKey("");
              }}
            >
              {c.add}
            </Button>
          </div>
          {newKey && (!/^[a-z0-9_]+$/.test(newKey) || newKey in items) && <p className="m-0 text-[13px] text-amber-ink">{c.badKey}</p>}
        </>
      )}
    </Card>
  );
}

function SettingsPanel({ name, cam }: { name: string; cam: Camera }) {
  const { edit, streams, navigate, saveNow, draft } = useApp();
  const t = useT();
  const s = t.editor.settings;
  const editCam = (fn: (c: Camera) => void) => edit((d) => fn(d.cameras[name]!));
  const go2rtc = cam.stream && "go2rtc" in cam.stream ? cam.stream.go2rtc : null;
  const options = streams.filter((s) => !s.name.endsWith("_sub") && (!s.camera || s.camera === name)).map((s) => s.name);
  const usedInRules = draft.rules.filter((r) => r.when.cameras?.includes(name));
  return (
    <Card className="flex flex-col gap-4 p-5">
      <Field label={s.label}>
        <TextInput value={cam.label ?? ""} placeholder={name} onChange={(v) => editCam((c) => void (c.label = v || undefined))} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={s.place}>
          <TextInput value={cam.place} onChange={(v) => editCam((c) => void (c.place = v))} />
        </Field>
        <Field label={s.kind}>
          <Select value={cam.kind} options={[["indoor", t.events.kind.indoor], ["outdoor", t.events.kind.outdoor]] as const} onChange={(v) => editCam((c) => void (c.kind = v))} />
        </Field>
      </div>
      {go2rtc !== null ? (
        <Field label={s.stream}>
          <Select value={go2rtc} options={options.includes(go2rtc) ? options : [go2rtc, ...options]} onChange={(v) => editCam((c) => void (c.stream = { go2rtc: v }))} />
        </Field>
      ) : (
        <Field label={s.rtsp} hint={s.rtspHint} help={s.rtspHelp}>
          <TextInput className="font-mono text-sm" value={cam.stream && "rtsp" in cam.stream ? cam.stream.rtsp : ""} onChange={(v) => editCam((c) => void (c.stream = { rtsp: v }))} />
        </Field>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label={s.detect} help={s.detectHelp} hint={cam.detect ? `${cam.detect.width}×${cam.detect.height}` : undefined}>
          <NumberInput value={cam.detect?.fps} min={1} onChange={(v) => editCam((c) => void (c.detect && (c.detect.fps = v ?? 5)))} />
        </Field>
        <Field label={s.snapshots} hint={s.snapshotsHint} help={s.snapshotsHelp}>
          <NumberInput
            value={cam.snapshots?.enabled ? (cam.snapshots.retain_days ?? 0) : undefined}
            min={0}
            onChange={(v) => editCam((c) => void (c.snapshots = v === undefined ? { enabled: false } : { enabled: true, retain_days: v }))}
          />
        </Field>
        <Field label={s.faceMinArea} hint={s.faceMinAreaHint}>
          <NumberInput value={cam.face_min_area} min={1} step={100} onChange={(v) => editCam((c) => void (v === undefined ? delete c.face_min_area : (c.face_min_area = v)))} />
        </Field>
        <Field label={s.lookMemory} hint={s.lookMemoryHint}>
          <Switch checked={cam.look?.memory ?? LOOK.memory} label={s.lookMemory} onChange={(on) => editCam((c) => void (c.look = { ...c.look, memory: on }))} />
        </Field>
        <Field label={s.lookBefore} hint={s.lookBeforeHint}>
          <NumberInput value={cam.look?.before_s ?? LOOK.before_s} min={0} onChange={(v) => editCam((c) => void (c.look = { ...c.look, before_s: v ?? LOOK.before_s }))} />
        </Field>
        <Field label={s.lookAfter} hint={s.lookAfterHint}>
          <NumberInput value={cam.look?.after_s ?? LOOK.after_s} min={1} onChange={(v) => editCam((c) => void (c.look = { ...c.look, after_s: v ?? LOOK.after_s }))} />
        </Field>
      </div>
      <Field label={s.decode} help={s.decodeHelp}>
        <Select
          value={cam.decode ?? "auto"}
          options={[["auto", s.decodeAuto], ["cpu", s.decodeCpu]] as const}
          onChange={(v) => editCam((c) => void (v === "auto" ? delete c.decode : (c.decode = v)))}
        />
      </Field>
      <div className="flex flex-col gap-2 border-t border-line pt-4">
        {usedInRules.length > 0 && <p className="m-0 text-[13px] text-amber-ink">{s.usedInRules(usedInRules.map((r) => r.name).join(", "))}</p>}
        <div>
          <ConfirmButton
            confirm={s.confirmRemove}
            onConfirm={() => {
              const next = structuredClone(draft);
              delete next.cameras[name];
              void saveNow(next).then((ok) => ok && navigate("/cameras"));
            }}
          >
            <Icon d={ICONS.trash} /> {s.remove}
          </ConfirmButton>
        </div>
        <p className="m-0 text-xs text-dim">{s.removeHint}</p>
      </div>
    </Card>
  );
}
