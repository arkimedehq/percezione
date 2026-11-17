import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { FrigateFaces } from "./people.ts";
import { writePrivate } from "./secrets.ts";

/**
 * Faces from other programs (docs/people.md, "API di import"): a photo archive sends the faces it
 * has attributed to a person. The same photo is often sent again (every sync): its sha256 is remembered, and a photo
 * already imported is not given to Frigate twice.
 */
export class FaceImports {
  private seen: Record<string, { person: string; at: string }>;

  constructor(private readonly path: string) {
    this.seen = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as typeof this.seen) : {};
  }

  /** Gives the photo to the person, unless it was imported already. */
  async import(faces: Pick<FrigateFaces, "upload">, person: string, image: Blob, filename: string, now = new Date()): Promise<{ added: boolean; night?: boolean }> {
    const hash = createHash("sha256").update(Buffer.from(await image.arrayBuffer())).digest("hex");
    if (this.seen[hash]) return { added: false };
    const night = await faces.upload(person, image, filename);
    this.seen[hash] = { person, at: now.toISOString() };
    writePrivate(this.path, JSON.stringify(this.seen) + "\n");
    return { added: true, night };
  }

  /** A person's photos are no longer remembered (the person was deleted: the same photos may be sent again). */
  forget(person: string): void {
    const before = Object.keys(this.seen).length;
    for (const [hash, s] of Object.entries(this.seen)) if (s.person === person) delete this.seen[hash];
    if (Object.keys(this.seen).length !== before) writePrivate(this.path, JSON.stringify(this.seen) + "\n");
  }
}
