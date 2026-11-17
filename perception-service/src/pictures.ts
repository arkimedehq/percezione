import type { Observation } from "./events.ts";
import type { McpClient } from "./mcp-tokens.ts";

/**
 * What a client may see of an event's pictures (external events: `image`, each person's `photo` and `face`). A device
 * (a wall panel) sees them all; an agent only when every camera of the event is one whose images the owner allowed
 * (Agents → Camera images, `outputs.mcp.snapshots`): a group's picture may come from any of its cameras.
 */
export function canSeePictures(client: McpClient | null | undefined, cameras: string[], allowed: string[]): boolean {
  if (!client || client.role === "device") return true;
  return cameras.length > 0 && cameras.every((c) => allowed.includes(c));
}

/** The event as the client may see it: without picture names when it may not. */
export function eventFor<T extends Observation>(e: T, client: McpClient | null | undefined, allowed: string[]): T {
  if (canSeePictures(client, e.cameras ?? [e.camera], allowed)) return e;
  const noPictures = <T extends { photo?: string; face?: string }>({ photo: _p, face: _f, ...rest }: T) => rest;
  const { image: _image, ...rest } = e;
  return {
    ...rest,
    ...(e.person ? { person: noPictures(e.person) } : {}),
    ...(e.people ? { people: e.people.map(noPictures) } : {}),
    ...(e.unknown_people ? { unknown_people: e.unknown_people.map(noPictures) } : {}),
  } as T;
}
