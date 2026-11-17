import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Shot } from "./best-face.ts";
import type { Observation, Person } from "./events.ts";
import type { Pictures, WhoAt, WhoPerson } from "./who.ts";

/**
 * External events (docs/external-events.md, S2d): a device says something happened in front of a camera (a ring, a
 * call, a gate opening) and Percezione records it as one of its events, with a picture of the moment and who is there.
 * The kind is free ("ring", "call", …) and goes in `value.to`, so rules filter it with `value` like any other event.
 * The answer comes at once; a second look follows for a few seconds, because Frigate names a face ~3 s after it
 * appears: a name found meanwhile is sent again, and the event is written once, at the end, with everything seen.
 * With a look (S8b) it goes from `before_s` before the request to `after_s` after it, on the camera or all the cameras
 * of its group: each person gets the frame where Frigate saw their face best, from the short memory in RAM
 * (src/buffer.ts).
 */
export const EXTERNAL_TOPIC = { request: "perception/external", result: "perception/external/result" };

/** How long Percezione keeps looking after the request without a look (`after_s`). */
export const LOOK_MS = 12_000;
/** At most this many people get their pictures. */
export const MAX_PHOTOS = 6;
/**
 * Where to look for a person's frame around the instant of their best face (s), nearest first: the instant of an
 * attempt (Frigate's clock and stream) and the pieces of the short memory (ours) can differ by a second or two.
 */
export const FRAME_OFFSETS_S = [0, -0.5, 0.5, -1, 1, -1.5, 1.5, -2, 2];
export const LOOK_EVERY_MS = 1_000;
/** Pictures are kept this long. */
export const KEEP_DAYS = 30;

const Kind = /^[a-z0-9_]{1,40}$/;
/** A device's name or the event's label: what a person would write, no control characters or newlines. */
const Name = /^[\p{L}\p{N} .,'()_-]{1,60}$/u;

export interface ExternalRequest {
  /** the caller's id, echoed in every answer */
  id: string | null;
  kind: string;
  camera: string;
  /** the device that sent it (`Name`) */
  source?: string;
  /** what to call it in the text (`Name`) */
  label?: string;
}

/**
 * A request from MQTT or HTTP: {"kind": "ring", "camera": "front_door", "id": "…", "source": "…", "label": "…"}. The
 * camera may be a group's id (`groups`: id → main camera): the event is on its main camera.
 */
export function externalRequest(input: unknown, cameras: string[], groups: Record<string, string> = {}): ExternalRequest | { id: string | null; error: string } {
  const p = (typeof input === "string" ? safeJson(input) : input) as Record<string, unknown> | null;
  const id = typeof p?.id === "string" ? p.id : null;
  if (!p || typeof p !== "object") return { id, error: "a JSON object is expected" };
  const str = (k: string) => (typeof p[k] === "string" && (p[k] as string).trim() ? (p[k] as string).trim() : undefined);
  const kind = str("kind");
  const camera = groups[str("camera") ?? ""] ?? str("camera");
  if (!kind || !Kind.test(kind)) return { id, error: "kind: lowercase letters, digits and _ only (e.g. ring)" };
  if (!camera || !cameras.includes(camera)) return { id, error: `unknown camera "${camera ?? ""}"` };
  // the label ends up in the event's text, and so in what an agent reads: a short name, never free text
  for (const k of ["source", "label"] as const) if (str(k) && !Name.test(str(k)!)) return { id, error: `${k}: a short name (letters, digits, spaces and . , ' ( ) _ -, at most 60)` };
  return { id, kind, camera, ...(str("source") ? { source: str("source") } : {}), ...(str("label") ? { label: str("label") } : {}) };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** What goes back to the caller: who is there now, and whether Percezione is done looking. */
export interface ExternalResult extends WhoAt {
  id: string | null;
  event_id: string;
  kind: string;
  final: boolean;
}

export interface ExternalDeps {
  dir: string;
  who(camera: string): Promise<WhoAt>;
  /** a live frame of the camera; null when there is none */
  frame(camera: string): Promise<Buffer | null>;
  emit(o: Observation): void;
  answer(r: ExternalResult): void;
  /** the cameras of a request with the zones that count (none: anywhere: the camera, or its group), and the look around it */
  look?(camera: string): Look | undefined;
  /** keeps the short memory of the cameras for [from, to] (ms) until the returned function is called */
  hold?(cameras: string[], from: number, to: number): () => void;
  /** the best face of each person on the cameras in [from, to] (ms) (src/best-face.ts) */
  shots?(cameras: Record<string, string[]>, from: number, to: number): Promise<Shot[]>;
  /** a full frame of a camera at ts (ms), from its short memory */
  still?(camera: string, ts: number): Promise<Buffer | null>;
  /** an attempt's face, as JPEG */
  face?(file: string): Promise<Buffer | null>;
  /** the face Frigate finds in a frame, and its name; null: no face (src/people.ts, recognize) */
  faceIn?(jpeg: Buffer): Promise<{ name: string | null; score: number } | null>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface Look {
  cameras: Record<string, string[]>;
  before_s: number;
  after_s: number;
}

/** A person's best face and its pictures, files in `dir`. */
export interface Photo extends Pictures {
  camera: string;
  name: string | null;
  confidence: number | null;
  /** the instant of the face (ms) */
  at: number;
  /** Frigate found the person's face in `photo` too, not only in the attempt */
  faceSeen?: boolean;
}

/**
 * Who, with each person's best face (S8d). Frigate's view of who is in front of a camera can miss someone it named a
 * moment before: a named face counts too (seen_by when on another camera of the group). A name without a score
 * (Frigate's view gives none at times) takes its face's. Without a name only the main camera's: elsewhere it may be
 * anyone passing by.
 */
export function withPictures(people: WhoPerson[], unrecognized: number, photos: Photo[], camera: string) {
  const pics = (p?: Photo): Pictures => ({ ...(p?.photo ? { photo: p.photo } : {}), ...(p?.face ? { face: p.face } : {}) });
  const out: WhoPerson[] = people.map((p) => {
    const ph = photos.find((x) => x.name === p.name);
    return { ...p, confidence: p.confidence ?? ph?.confidence ?? null, ...pics(ph) };
  });
  for (const p of photos) {
    if (!p.name || out.some((x) => x.name === p.name)) continue;
    out.push({ name: p.name, confidence: p.confidence, ...(p.camera !== camera ? { seen_by: p.camera, seen_at: new Date(p.at).toISOString() } : {}), ...pics(p) });
  }
  const unknown = photos.filter((p) => !p.name && p.camera === camera && (p.photo || p.face)).map((p) => ({ camera: p.camera, ...pics(p) }));
  return { people: out, unrecognized: Math.max(unrecognized, unknown.length), unknown_people: unknown };
}

export class External {
  constructor(private readonly d: ExternalDeps) {
    mkdirSync(d.dir, { recursive: true });
  }

  /** Records the event; resolves when it is written (after the second look). */
  async handle(req: ExternalRequest): Promise<Observation> {
    const now = () => this.d.now?.() ?? new Date();
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const event_id = randomUUID();
    const start = now();
    const ts = start.toISOString();
    const look = this.d.look?.(req.camera);
    const from = start.getTime() - (look?.before_s ?? 0) * 1000;
    const release = look && this.d.hold ? this.d.hold(Object.keys(look.cameras), from, start.getTime() + (look.after_s + 1) * 1000) : () => undefined;
    try {
      return await this.look(req, event_id, ts, look, from, now, sleep);
    } finally {
      release();
    }
  }

  private async look(req: ExternalRequest, event_id: string, ts: string, look: Look | undefined, from: number, now: () => Date, sleep: (ms: number) => Promise<void>): Promise<Observation> {
    const [first, jpeg] = await Promise.all([this.d.who(req.camera), this.d.frame(req.camera).catch(() => null)]);
    const seen = new Seen();
    seen.add(first);
    let done = false;
    const answer = (who: WhoAt, final: boolean) => {
      done = final;
      this.d.answer({ id: req.id, event_id, kind: req.kind, final, ...who, people: seen.people() });
    };
    let last = first;
    // with a look the final answer waits for the best faces: they may name someone Frigate no longer reports in view
    if (look || !seen.complete(first)) {
      answer(first, false);
      for (let i = 0; i < (look ? look.after_s * 1000 : LOOK_MS) / LOOK_EVERY_MS; i++) {
        await sleep(LOOK_EVERY_MS);
        const who = await this.d.who(req.camera).catch(() => null);
        if (!who) continue;
        last = who;
        if (seen.add(who)) answer(who, !look && seen.complete(who));
        if (seen.complete(who)) break;
      }
    }
    if (!done && !look) answer(last, true);
    const photos = look ? await this.photos(event_id, look, from, now().getTime()) : [];
    const all = withPictures(seen.people(), seen.unrecognized(), photos, req.camera);
    const people = all.people.map((p): Person => ({ name: p.name, confidence: p.confidence, source: "face", ...(p.seen_by ? { seen_by: p.seen_by } : {}), ...(p.photo ? { photo: p.photo } : {}), ...(p.face ? { face: p.face } : {}) }));
    const unknown = all.unknown_people;
    const unrecognized = all.unrecognized;
    // the picture of the event: a frame where a face is seen, else the best face's frame, else the moment of the request
    const counts = (p: Photo) => !!p.photo && (!!p.name || p.camera === req.camera);
    let image = (photos.find((p) => counts(p) && p.faceSeen) ?? photos.find(counts))?.photo;
    if (!image && jpeg) {
      image = `${event_id}.jpg`;
      writeFileSync(resolve(this.d.dir, image), jpeg);
    }
    if (look) this.d.answer({ id: req.id, event_id, kind: req.kind, final: true, ...last, people: all.people, unrecognized, ...(unknown.length ? { unknown_people: unknown } : {}) });
    const o: Observation = {
      event_id,
      ts,
      type: "external",
      camera: req.camera,
      person: people[0] ?? null,
      people,
      unrecognized,
      ...(unknown.length ? { unknown_people: unknown } : {}),
      value: { from: null, to: req.kind },
      external: { request_id: req.id, ...(req.source ? { source: req.source } : {}), ...(req.label ? { label: req.label } : {}) },
      ...(image ? { image } : {}),
      ...(first.group ? { cameras: first.group.cameras } : {}),
      media: { frigate_ids: [] },
    };
    this.d.emit(o);
    return o;
  }

  /** A picture of `dir` by file name; null when there is none (or the name is not one of ours). */
  picture(file: string): Buffer | null {
    if (!/^[0-9a-f-]+\.jpg$/.test(file)) return null;
    try {
      return readFileSync(resolve(this.d.dir, file));
    } catch {
      return null;
    }
  }

  /** Who is at a camera or a group now, each person with their best face of the last `before_s` seconds (S8d). */
  async whoWithPictures(target: string): Promise<WhoAt> {
    const who = await this.d.who(target);
    const look = this.d.look?.(who.camera);
    if (!look) return who;
    const to = (this.d.now?.() ?? new Date()).getTime();
    const from = to - look.before_s * 1000;
    const release = this.d.hold?.(Object.keys(look.cameras), from, to) ?? (() => undefined);
    try {
      const all = withPictures(who.people, who.unrecognized, await this.photos(randomUUID(), look, from, to), who.camera);
      return { ...who, ...all };
    } finally {
      release();
    }
  }

  /** The frame and the face of each person's best shot, written in `dir` as <event>-<n>.jpg and <event>-<n>-face.jpg. */
  private async photos(event_id: string, look: Look, from: number, to: number): Promise<Photo[]> {
    const shots = (await this.d.shots?.(look.cameras, from, to).catch(() => [])) ?? [];
    // people at once: each one's frames one after the other, nearest first
    return Promise.all(
      shots.slice(0, MAX_PHOTOS).map(async (s, i) => {
        const [frame, face] = await Promise.all([this.frame(s), this.d.face?.(s.attempt.file).catch(() => null)]);
        const p: Photo = { camera: s.camera, name: s.name, confidence: s.confidence ?? (s.name ? s.attempt.score : null), at: s.attempt.ts * 1000 };
        if (frame) writeFileSync(resolve(this.d.dir, (p.photo = `${event_id}-${i + 1}.jpg`)), frame.jpeg);
        if (frame?.faceSeen) p.faceSeen = true;
        if (face) writeFileSync(resolve(this.d.dir, (p.face = `${event_id}-${i + 1}-face.jpg`)), face);
        return p;
      }),
    );
  }

  /**
   * The person's frame: the first one around the instant of their best face where Frigate finds their face (with a
   * name, the same name); none: the frame of that instant, maybe from behind.
   */
  private async frame(s: Shot): Promise<{ jpeg: Buffer; faceSeen: boolean } | null> {
    const at = s.attempt.ts * 1000;
    const still = (ms: number) => this.d.still?.(s.camera, ms).catch(() => null) ?? Promise.resolve(null);
    if (!this.d.faceIn) {
      const jpeg = await still(at);
      return jpeg ? { jpeg, faceSeen: false } : null;
    }
    let first: Buffer | null = null;
    for (const off of FRAME_OFFSETS_S) {
      const jpeg = await still(at + off * 1000);
      if (!jpeg) continue;
      first ??= jpeg;
      const r = await this.d.faceIn(jpeg).catch(() => null);
      if (r && (!s.name || r.name === s.name)) {
        console.log(`best face of ${s.name ?? "someone"} on ${s.camera}: frame at ${off >= 0 ? "+" : ""}${off} s (${r.score.toFixed(2)})`);
        return { jpeg, faceSeen: true };
      }
    }
    return first && { jpeg: first, faceSeen: false };
  }

  /** Drops the pictures older than KEEP_DAYS. */
  prune(now = Date.now()): number {
    let n = 0;
    for (const f of readdirSync(this.d.dir)) {
      const path = resolve(this.d.dir, f);
      if (f.endsWith(".jpg") && now - statSync(path).mtimeMs > KEEP_DAYS * 86_400_000) {
        unlinkSync(path);
        n++;
      }
    }
    return n;
  }
}

/**
 * Everyone seen during the look: names on the main camera (best score each), the most people in view there at once,
 * and the names other cameras of the group recognized on the way (`seen_by`), unless the main camera named them too.
 */
class Seen {
  private names = new Map<string, number | null>();
  private others = new Map<string, WhoPerson>();
  private most = 0;

  /** true when a name is new, so the caller learns something */
  add(w: WhoAt): boolean {
    let news = false;
    for (const p of w.people) {
      if (p.seen_by) {
        news ||= !this.names.has(p.name) && !this.others.has(p.name);
        const prev = this.others.get(p.name);
        if (!prev || (p.confidence ?? 0) > (prev.confidence ?? 0)) this.others.set(p.name, p);
        continue;
      }
      const prev = this.names.get(p.name);
      if (!this.names.has(p.name) || (p.confidence ?? 0) > (prev ?? 0)) {
        news ||= !this.names.has(p.name) && !this.others.has(p.name);
        this.names.set(p.name, p.confidence ?? prev ?? null);
      }
    }
    this.most = Math.max(this.most, main(w).length + w.unrecognized);
    return news;
  }

  /** everyone in view on the main camera has a name: nothing more to wait for */
  complete(w: WhoAt): boolean {
    return main(w).length > 0 && w.unrecognized === 0;
  }

  people(): WhoPerson[] {
    const here = [...this.names].map(([name, confidence]) => ({ name, confidence }));
    return [...here, ...[...this.others.values()].filter((p) => !this.names.has(p.name))];
  }

  unrecognized(): number {
    return Math.max(0, this.most - this.names.size);
  }
}

const main = (w: WhoAt) => w.people.filter((p) => !p.seen_by);
