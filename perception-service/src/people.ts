/**
 * The people Percezione knows, over Frigate's face library (docs/people.md). Frigate's library stays the only store
 * of faces (one folder per person under clips/faces/); this is the API the frontend and agents use on top of it.
 * - A person's id is the folder name, which is also the name in events (`person.name`, Frigate's `sub_label`).
 * - `train` is not a person: it holds Frigate's recent recognition attempts (S2b, "to name").
 * - Every change makes Frigate rebuild its classifier from the files at the next face.
 * - Night faces (infrared, black and white) live in a second folder, `<id>~ir`: Frigate averages a person's faces and
 *   drops the ones far from the mean, so one infrared face among colour photos is ignored (docs/people.md, volti
 *   notturni). Percezione picks the folder by looking at the image, and shows one person: in the list those faces are
 *   `~ir/<file>`, and every name read from Frigate loses the suffix (`baseName`).
 * Frigate 0.18 talks to its embeddings process over one shared ZMQ socket: calls made while Frigate is starting can
 * hang it until a restart. Nothing here runs on its own at startup.
 */

import sharp from "sharp";

export const TRAIN = "train";

/** Suffix of a person's night folder: "~" is not allowed in a person's name, so it cannot collide. */
export const NIGHT = "~ir";
/** How night faces are listed among a person's faces. */
export const NIGHT_PREFIX = `${NIGHT}/`;

/** The person a Frigate name or folder is about: "Alice~ir" is Alice. */
export function baseName(name: string): string {
  return name.endsWith(NIGHT) ? name.slice(0, -NIGHT.length) : name;
}

/** The folder and file of a listed face: "~ir/x.webp" of Alice is "Alice~ir"/"x.webp". */
export function faceFolder(id: string, file: string): { folder: string; file: string } {
  return file.startsWith(NIGHT_PREFIX) ? { folder: id + NIGHT, file: file.slice(NIGHT_PREFIX.length) } : { folder: id, file };
}

/**
 * An infrared picture: no colour. The mean spread between the channels of a small copy is near zero (measured on
 * real camera frames: 0 at night, 9–20 by day).
 */
export async function isInfrared(image: Buffer): Promise<boolean> {
  const { data, info } = await sharp(image).resize(64, 64, { fit: "inside" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.channels < 3) return true;
  let spread = 0;
  for (let i = 0; i < data.length; i += info.channels) spread += Math.max(data[i]!, data[i + 1]!, data[i + 2]!) - Math.min(data[i]!, data[i + 1]!, data[i + 2]!);
  return spread / (data.length / info.channels) < 3;
}

/** Names Frigate accepts as a folder: letters, digits, space, ' _ - (spaces become _), at most 50. */
export function personId(name: string): string | null {
  const id = name.trim().replace(/\s+/g, "_");
  // "unknown" is Frigate's own label for a face with no name
  return /^[\p{L}\p{N}'_-]{1,50}$/u.test(id) && id !== TRAIN && id.toLowerCase() !== "unknown" ? id : null;
}

export interface Person {
  id: string;
  /** its faces; the night ones as `~ir/<file>` */
  faces: string[];
}

/** One recognition attempt in `train`: Frigate names it `<event id>-<time>-<name or unknown>-<score>.webp`. */
export interface Attempt {
  file: string;
  /** Frigate's event (one tracked person) */
  event: string;
  /** seconds */
  ts: number;
  /** Frigate's guess; null when unknown */
  name: string | null;
  score: number;
}

const ATTEMPT = /^(\d+\.\d+-[a-z0-9]+)-(\d+(?:\.\d+)?)-(.+)-(\d+(?:\.\d+)?)\.webp$/;

export function parseAttempt(file: string): Attempt | null {
  const m = ATTEMPT.exec(file);
  if (!m) return null;
  return { file, event: m[1]!, ts: Number(m[2]), name: m[3] === "unknown" ? null : baseName(m[3]!), score: Number(m[4]) };
}

/** A guess this sure is already a recognition: Frigate's guide says such faces add little and risk over-fitting. */
export const SURE = 0.9;

/** The faces of one passage: one Frigate event, one person. */
export interface AttemptGroup {
  event: string;
  camera: string | null;
  place: string | null;
  /** the latest attempt, ISO */
  ts: string;
  attempts: Attempt[];
  /** Frigate's best guess in the group */
  best: { name: string; score: number } | null;
  /** already recognized with confidence: nothing to name */
  recognized: boolean;
}

/** Attempts by event, newest passage first; each group's attempts best score first. */
export function groupAttempts(attempts: Attempt[], where: (event: string) => { camera: string; place: string } | undefined): AttemptGroup[] {
  const by = new Map<string, Attempt[]>();
  for (const a of attempts) by.set(a.event, [...(by.get(a.event) ?? []), a]);
  return [...by]
    .map(([event, list]) => {
      const sorted = [...list].sort((x, y) => y.score - x.score);
      const named = sorted.filter((x) => x.name);
      const best = named[0] ? { name: named[0].name!, score: named[0].score } : null;
      const w = where(event);
      return {
        event,
        camera: w?.camera ?? null,
        place: w?.place ?? null,
        ts: new Date(Math.max(...list.map((x) => x.ts)) * 1000).toISOString(),
        attempts: sorted,
        best,
        recognized: !!best && best.score >= SURE,
      };
    })
    .sort((a, b) => b.ts.localeCompare(a.ts));
}

export class FrigateFaces {
  constructor(private readonly frigateUrl: string) {}

  async list(): Promise<Person[]> {
    // Frigate's nginx keeps API answers for 5 s: a list read right after a change would show the old one
    const all = (await (await this.call(`/api/faces?ts=${Date.now()}`)).json()) as Record<string, string[]>;
    const people = new Map<string, string[]>();
    for (const [folder, files] of Object.entries(all)) {
      if (folder === TRAIN) continue;
      const id = baseName(folder);
      const listed = folder === id ? files : files.map((f) => NIGHT_PREFIX + f);
      people.set(id, [...(people.get(id) ?? []), ...listed]);
    }
    return [...people]
      // day faces, then night ones, each newest first (Frigate's names end with the time)
      .map(([id, faces]) => ({ id, faces: [...faces.filter((f) => !f.startsWith(NIGHT_PREFIX)).sort().reverse(), ...faces.filter((f) => f.startsWith(NIGHT_PREFIX)).sort().reverse()] }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** The folders a person has: the day one and, when there are night faces, the night one. */
  private async folders(id: string): Promise<string[]> {
    const all = (await (await this.call(`/api/faces?ts=${Date.now()}`)).json()) as Record<string, string[]>;
    return [id, id + NIGHT].filter((f) => f in all);
  }

  async create(id: string): Promise<void> {
    await this.call(`/api/faces/${encodeURIComponent(id)}/create`, { method: "POST" });
  }

  /**
   * A photo of the person: Frigate finds the face in it and keeps only the crop. An infrared photo goes to the night
   * folder (`night` decides it instead, e.g. for a restored face). Returns whether it was a night face.
   */
  async upload(id: string, image: Blob, filename = "photo.jpg", forceNight?: boolean): Promise<boolean> {
    const night = forceNight ?? (await isInfrared(Buffer.from(await image.arrayBuffer())).catch(() => false));
    const form = new FormData();
    form.set("file", image, filename);
    const res = await this.call(`/api/faces/${encodeURIComponent(night ? id + NIGHT : id)}/register`, { method: "POST", body: form }, false);
    const body = (await res.clone().json().catch(() => ({}))) as { success?: boolean };
    if (!res.ok || body.success === false) throw new Error(await message(res));
    return night;
  }

  /** Faces as listed (`~ir/<file>` for night ones). */
  async removeFaces(id: string, files: string[]): Promise<void> {
    // no files: Frigate removes the folder if it is empty (a person with no faces yet)
    for (const [folder, list] of files.length ? byFolder(id, files) : new Map([[id, []]])) {
      await this.call(`/api/faces/${encodeURIComponent(folder)}/delete`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ ids: list }) });
    }
  }

  /** The whole person, night faces too: Frigate removes a folder once it is empty. */
  async remove(id: string): Promise<void> {
    const person = (await this.list()).find((p) => p.id === id);
    if (!person) throw new Error(`no person "${id}"`);
    await this.removeFaces(id, person.faces);
  }

  async rename(id: string, to: string): Promise<void> {
    const folders = await this.folders(id);
    if (!folders.length) throw new Error(`no person "${id}"`);
    for (const folder of folders) {
      const target = folder === id ? to : to + NIGHT;
      await this.call(`/api/faces/${encodeURIComponent(folder)}/rename`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ new_name: target }) });
    }
  }

  /** One face (as listed) to another person, a night face to their night folder. */
  async move(id: string, file: string, to: string): Promise<void> {
    const f = faceFolder(id, file);
    const target = f.folder === id ? to : to + NIGHT;
    await this.call(`/api/faces/${encodeURIComponent(f.folder)}/reclassify`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ id: f.file, new_name: target }) });
  }

  /** Two folders of the same person: every face of `id` goes to `into`, and `id` disappears. */
  async merge(id: string, into: string): Promise<number> {
    const people = await this.list();
    const from = people.find((p) => p.id === id);
    if (!from) throw new Error(`no person "${id}"`);
    if (!people.some((p) => p.id === into)) await this.create(into);
    for (const file of from.faces) await this.move(id, file, into);
    // the empty folders: Frigate removes a folder on a delete with no files left
    for (const folder of [id, id + NIGHT]) await this.call(`/api/faces/${encodeURIComponent(folder)}/delete`, { method: "POST", headers: JSON_HEADERS, body: '{"ids":[]}' }, false).catch(() => undefined);
    return from.faces.length;
  }

  /** Frigate's recent recognition attempts (`train`), parsed; files it names otherwise are left out. */
  async attempts(): Promise<Attempt[]> {
    const all = (await (await this.call(`/api/faces?ts=${Date.now()}`)).json()) as Record<string, string[]>;
    return (all[TRAIN] ?? []).flatMap((f) => parseAttempt(f) ?? []);
  }

  /**
   * Attempts become faces of `to` (created when new): the person was seen by the cameras. Infrared attempts go to the
   * night folder. Returns how many were night faces.
   */
  async assign(files: string[], to: string): Promise<number> {
    let nights = 0;
    for (const file of files) {
      const img = await this.image(TRAIN, file).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
      const night = img ? await isInfrared(Buffer.from(img)).catch(() => false) : false;
      if (night) nights++;
      const folder = night ? to + NIGHT : to;
      await this.call(`/api/faces/${TRAIN}/${encodeURIComponent(folder)}/classify`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ training_file: file }) });
    }
    return nights;
  }

  /**
   * The face Frigate finds in a picture and who it is (`/api/faces/recognize`, nothing saved): null when it finds no
   * face, name null when it cannot name it.
   */
  async recognize(jpeg: Buffer): Promise<{ name: string | null; score: number } | null> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "frame.jpg");
    const res = await this.call("/api/faces/recognize", { method: "POST", body: form }, false);
    const r = (await res.json().catch(() => ({}))) as { success?: boolean; face_name?: string; score?: number };
    if (!r.success) return null;
    const name = r.face_name && r.face_name !== "unknown" ? baseName(r.face_name) : null;
    return { name, score: r.score ?? 0 };
  }

  async discard(files: string[]): Promise<void> {
    await this.removeFaces(TRAIN, files);
  }

  /** A face image (as listed), from Frigate's static files. */
  image(id: string, file: string): Promise<Response> {
    const f = faceFolder(id, file);
    return fetch(`${this.frigateUrl}/clips/faces/${encodeURIComponent(f.folder)}/${encodeURIComponent(f.file)}`, { signal: AbortSignal.timeout(10_000) });
  }

  private async call(path: string, init: RequestInit = {}, check = true): Promise<Response> {
    const res = await fetch(`${this.frigateUrl}${path}`, { ...init, signal: AbortSignal.timeout(30_000) });
    if (check && !res.ok) throw new Error(await message(res));
    return res;
  }
}

const JSON_HEADERS = { "Content-Type": "application/json" };

/** Listed faces by the folder they are in. */
function byFolder(id: string, files: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const listed of files) {
    const f = faceFolder(id, listed);
    out.set(f.folder, [...(out.get(f.folder) ?? []), f.file]);
  }
  return out;
}

async function message(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { message?: string; detail?: unknown };
  return body.message ?? (typeof body.detail === "string" ? body.detail : `Frigate HTTP ${res.status}`);
}
