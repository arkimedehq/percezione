import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { Observation, Person } from "./events.ts";
import type { FrigateEvent } from "./frigate.ts";
import type { ActiveObject } from "./perception.ts";
import { inside } from "./posture.ts";
import { OBJECTS } from "./settings.ts";

type Point = [number, number];
export type Box = [number, number, number, number];

/**
 * CLIP prompts (English, as CLIP was trained): label → phrases. `nothing` collects changes that are not left
 * objects (shadows, rain, cars, plants), so a lighting change does not become an event.
 */
export const OBJECT_PROMPTS: Record<string, string[]> = {
  trash: ["a photo of garbage bags left on the sidewalk", "a pile of trash bags on the street", "litter and rubbish dumped on the ground"],
  parcel: ["a photo of a cardboard box left on the ground", "a delivered parcel on the doorstep", "a package wrapped in plastic on the ground"],
  bulky: [
    "an old mattress dumped on the street",
    "discarded furniture left on the sidewalk",
    "an abandoned household appliance on the street",
  ],
  nothing: [
    "a photo of an empty sidewalk",
    "a photo of empty paving stones",
    "a photo of asphalt road",
    "a photo of a plain wall",
    "a shadow on the pavement",
    "a wet pavement after the rain",
    "a photo of a parked car",
    "a photo of a potted plant",
  ],
};

/**
 * Minimum rise of the object's probability from the "before" crop to the "after" crop. CLIP alone is biased on
 * a single crop (bare paving or a wall can score 0.7 as a parcel); the same crop before the change carries the
 * same bias, so only the rise counts.
 */
const MIN_RISE = 0.25;

// grid over the zone's bounding rectangle: 4×4-pixel cells after resizing
const GRID = 24;
const CELL = 4;
/** brightness difference (0–255), beyond the zone-wide shift, for a cell to count as changed */
const CELL_THRESHOLD = 18;
/** above this changed fraction it is lighting (a cloud, night IR switching on): take a new reference */
const MAX_CHANGE = 0.5;
/** two prints differing in at most this fraction of cells are the same scene */
const SAME_SCENE = 0.02;

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Zone fingerprint: mean brightness per cell, and which cells fall inside the polygon. */
export interface Print {
  cells: Float32Array;
  mask: Uint8Array;
  rect: Rect;
}

export async function zonePrint(jpeg: Buffer, polygon: Point[]): Promise<Print> {
  const { width = 0, height = 0 } = await sharp(jpeg).metadata();
  const xs = polygon.map((p) => p[0] * width);
  const ys = polygon.map((p) => p[1] * height);
  const left = Math.max(0, Math.floor(Math.min(...xs)));
  const top = Math.max(0, Math.floor(Math.min(...ys)));
  const rect = {
    left,
    top,
    width: Math.max(1, Math.min(width, Math.ceil(Math.max(...xs))) - left),
    height: Math.max(1, Math.min(height, Math.ceil(Math.max(...ys))) - top),
  };
  const side = GRID * CELL;
  const raw = await sharp(jpeg).extract(rect).resize(side, side, { fit: "fill" }).greyscale().blur(1).raw().toBuffer();
  const cells = new Float32Array(GRID * GRID);
  const mask = new Uint8Array(GRID * GRID);
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      let sum = 0;
      for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) sum += raw[(i * CELL + y) * side + j * CELL + x]!;
      cells[i * GRID + j] = sum / (CELL * CELL);
      const center: Point = [(rect.left + ((j + 0.5) * rect.width) / GRID) / width, (rect.top + ((i + 0.5) * rect.height) / GRID) / height];
      mask[i * GRID + j] = inside(center, polygon) ? 1 : 0;
    }
  }
  return { cells, mask, rect };
}

/**
 * Changed cells between two prints of the same zone. The zone-wide shift (median of the differences: the
 * setting sun brightens or darkens the whole zone) is removed first; only what remains counts.
 */
export function compare(a: Print, b: Print): { fraction: number; changed: number[] } {
  const idx: number[] = [];
  for (let k = 0; k < a.cells.length; k++) if (a.mask[k]) idx.push(k);
  if (idx.length === 0) return { fraction: 0, changed: [] };
  const diffs = idx.map((k) => b.cells[k]! - a.cells[k]!);
  const median = [...diffs].sort((x, y) => x - y)[Math.floor(diffs.length / 2)]!;
  const changed = idx.filter((_k, n) => Math.abs(diffs[n]! - median) > CELL_THRESHOLD);
  return { fraction: changed.length / idx.length, changed };
}

/** Frame-pixel rectangle enclosing the changed cells. */
export function changedBox(p: Print, changed: number[]): Box {
  const rows = changed.map((k) => Math.floor(k / GRID));
  const cols = changed.map((k) => k % GRID);
  const cw = p.rect.width / GRID;
  const ch = p.rect.height / GRID;
  return [
    Math.round(p.rect.left + Math.min(...cols) * cw),
    Math.round(p.rect.top + Math.min(...rows) * ch),
    Math.round(p.rect.left + (Math.max(...cols) + 1) * cw),
    Math.round(p.rect.top + (Math.max(...rows) + 1) * ch),
  ];
}

function blend(base: Print, cur: Print, w: number): Print {
  const cells = new Float32Array(base.cells.length);
  for (let k = 0; k < cells.length; k++) cells[k] = base.cells[k]! * (1 - w) + cur.cells[k]! * w;
  return { ...base, cells };
}

export interface WatchParams {
  camera: string;
  zone: string;
  polygon: Point[];
  checkMs: number;
  persistMs: number;
  minScore: number;
  /** minimum changed cells: below this it is noise */
  minCells: number;
}

export interface LeftObjectDeps {
  now(): number;
  frame(camera: string): Promise<Buffer>;
  /** CLIP on the crop: probability of each OBJECT_PROMPTS label */
  classify(camera: string, frame: Buffer, box: Box): Promise<Record<string, number>>;
  /** stores an event image and returns its name */
  save(name: string, jpeg: Buffer): Promise<string>;
  emit(o: Observation): void;
  log?(message: string): void;
}

interface Seen {
  id: string;
  camera: string;
  name: string | null;
  score: number | null;
  startMs: number;
  lastMs: number;
}

/** No person seen on the camera for at least this long: the zone is clear and can be compared. */
const QUIET_MS = 15_000;
const SEEN_KEEP_MS = 60 * 60_000;

/**
 * Objects left in a zone (`left_object` observation): trash, parcels, bulky items.
 * - While nobody is on the camera, every `checkMs` the zone is compared, cell by cell, with a reference (the
 *   empty zone); the reference slowly follows daylight.
 * - A change that stays the same for `persistMs` (not a moving shadow, not someone passing by) is cropped and
 *   classified by CLIP: an object above `minScore` is an `object_left` event. Either way the new scene becomes the
 *   reference, so the same object never fires twice.
 * - The event carries whoever was on the camera between the last empty zone and the change (recognized or not)
 *   and before/after photos, stored by the service because Frigate does not keep the empty zone.
 */
export class LeftObjects {
  private watches = new Map<string, Watch>();
  private seen = new Map<string, Seen>();
  private active = new Set<string>(); // cameras where Frigate has an active person

  constructor(private readonly deps: LeftObjectDeps) {}

  /** Hot reconfiguration: an unchanged zone keeps its reference. */
  configure(params: WatchParams[]): void {
    const next = new Map<string, Watch>();
    for (const p of params) {
      const key = `${p.camera}/${p.zone}`;
      const w = this.watches.get(key);
      if (w && JSON.stringify(w.p.polygon) === JSON.stringify(p.polygon)) {
        w.p = p;
        next.set(key, w);
      } else next.set(key, new Watch(p));
    }
    this.watches = next;
  }

  handleEvent(ev: FrigateEvent): void {
    const o = ev.after;
    if (o.label !== "person" || o.false_positive) return;
    const now = this.deps.now();
    const s = this.seen.get(o.id) ?? { id: o.id, camera: o.camera, name: null, score: null, startMs: o.start_time * 1000, lastMs: now };
    s.lastMs = o.end_time ? o.end_time * 1000 : now;
    if (o.sub_label) [s.name, s.score] = o.sub_label;
    this.seen.set(o.id, s);
  }

  syncActive(objects: ActiveObject[]): void {
    this.active = new Set(objects.filter((o) => o.label === "person").map((o) => o.camera));
    const now = this.deps.now();
    for (const o of objects) {
      const s = this.seen.get(o.id);
      if (s) s.lastMs = now;
    }
  }

  quiet(camera: string): boolean {
    const now = this.deps.now();
    if (this.active.has(camera)) return false;
    return ![...this.seen.values()].some((s) => s.camera === camera && now - s.lastMs < QUIET_MS);
  }

  /** Call every second: checks the zones that are due. */
  async tick(): Promise<void> {
    const now = this.deps.now();
    for (const [id, s] of this.seen) if (now - s.lastMs > SEEN_KEEP_MS) this.seen.delete(id);
    await Promise.all(
      [...this.watches.values()].filter((w) => !w.busy && now - w.lastCheck >= w.p.checkMs && this.quiet(w.p.camera)).map((w) => this.check(w)),
    );
  }

  private async check(w: Watch): Promise<void> {
    w.busy = true;
    w.lastCheck = this.deps.now();
    try {
      const frame = await this.deps.frame(w.p.camera);
      // someone walked in while the frame was downloading
      if (!this.quiet(w.p.camera)) return;
      const print = await zonePrint(frame, w.p.polygon);
      w.lastError = "";
      await this.step(w, frame, print);
    } catch (err) {
      // the same error at every check (e.g. Frigate down) is written once
      const msg = (err as Error).message;
      if (msg !== w.lastError) this.deps.log?.(`left object ${w.p.camera}/${w.p.zone}: ${msg}`);
      w.lastError = msg;
    } finally {
      w.busy = false;
    }
  }

  private async step(w: Watch, frame: Buffer, print: Print): Promise<void> {
    const now = this.deps.now();
    if (!w.base) {
      w.base = { print, frame, ts: now };
      return;
    }
    const diff = compare(w.base.print, print);
    if (diff.changed.length < w.p.minCells || diff.fraction > MAX_CHANGE) {
      // zone as before (or the whole lighting changed): the reference follows the scene
      w.base = diff.fraction > MAX_CHANGE ? { print, frame, ts: now } : { print: blend(w.base.print, print, 0.3), frame, ts: now };
      w.cand = undefined;
      return;
    }
    if (!w.cand || compare(w.cand.print, print).fraction > SAME_SCENE) {
      w.cand = { print, since: now };
      return;
    }
    if (now - w.cand.since < w.p.persistMs) return;

    const base = w.base;
    w.base = { print, frame, ts: now };
    w.cand = undefined;
    const box = changedBox(print, diff.changed);
    const [before, after] = await Promise.all([this.deps.classify(w.p.camera, base.frame, box), this.deps.classify(w.p.camera, frame, box)]);
    const { label, score, rise } = pickObject(before, after);
    this.deps.log?.(`left object ${w.p.camera}/${w.p.zone}: ${diff.changed.length} cells, ${label} ${score.toFixed(2)} (+${rise.toFixed(2)})`);
    if (score < w.p.minScore || rise < MIN_RISE) return;

    const event_id = randomUUID();
    const [before_, after_] = await Promise.all([
      this.deps.save(`${event_id}-before.jpg`, await cropAround(base.frame, box)),
      this.deps.save(`${event_id}-after.jpg`, await cropAround(frame, box)),
    ]);
    // whoever was on the camera from the last empty zone until the object appeared
    const who = [...this.seen.values()].filter((s) => s.camera === w.p.camera && s.lastMs >= base.ts - QUIET_MS && s.startMs <= now);
    const named = who.find((s) => s.name);
    const person: Person | null = named ? { name: named.name!, confidence: named.score, source: "face" } : null;
    this.deps.emit({
      event_id,
      ts: new Date(now).toISOString(),
      type: "object_left",
      camera: w.p.camera,
      person,
      value: { from: null, to: label },
      zone: w.p.zone,
      object: { score, rise, box, passersby: who.length, images: { before: before_, after: after_ } },
      media: { frigate_ids: who.map((s) => s.id) },
    });
  }
}

/** The object whose probability rose the most from before to after; `nothing` is never an object. */
export function pickObject(before: Record<string, number>, after: Record<string, number>): { label: string; score: number; rise: number } {
  let best = { label: "nothing", score: 0, rise: 0 };
  for (const label of OBJECTS) {
    const rise = (after[label] ?? 0) - (before[label] ?? 0);
    if (rise > best.rise) best = { label, score: after[label] ?? 0, rise };
  }
  return best;
}

class Watch {
  base?: { print: Print; frame: Buffer; ts: number };
  cand?: { print: Print; since: number };
  lastCheck = 0;
  busy = false;
  lastError = "";
  constructor(public p: WatchParams) {}
}

/** Wide crop around the object for the before/after photos. */
async function cropAround(jpeg: Buffer, [x1, y1, x2, y2]: Box, maxSide = 640): Promise<Buffer> {
  const img = sharp(jpeg);
  const { width = 0, height = 0 } = await img.metadata();
  const m = Math.max(x2 - x1, y2 - y1, 120);
  const left = Math.max(0, Math.floor(x1 - m));
  const top = Math.max(0, Math.floor(y1 - m));
  const right = Math.min(width, Math.ceil(x2 + m));
  const bottom = Math.min(height, Math.ceil(y2 + m));
  return img
    .extract({ left, top, width: right - left, height: bottom - top })
    .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}
