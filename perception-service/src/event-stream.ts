import type { IncomingMessage, ServerResponse } from "node:http";
import type { PerceptionEvent } from "./events.ts";
import { bearer } from "./mcp.ts";
import type { McpClient, McpTokens } from "./mcp-tokens.ts";
import { eventFor } from "./pictures.ts";

/**
 * Live events for any program (docs/live-events.md): `GET /events` as Server-Sent Events, with the same client
 * tokens as the MCP server. Each event is the full v3 event (an agent's without the pictures it may not see), with its `event_id` as the SSE id, so a client that
 * reconnects with `Last-Event-ID` gets what it missed from the timeline and nothing is lost while it was away.
 */
export interface EventStreamDeps {
  tokens: McpTokens;
  /** the timeline, oldest first */
  events(): PerceptionEvent[];
  /** cameras whose pictures agents may see (outputs.mcp.snapshots); none when missing */
  allowed?: () => string[];
  now?: () => Date;
  heartbeatMs?: number;
}

// replay window when the client's last id is no longer in the timeline, or for `since`
const MAX_REPLAY_MS = 7 * 86400_000;
const UNKNOWN_ID_REPLAY_MS = 86400_000;

export function frame(e: PerceptionEvent): string {
  return `id: ${e.event_id}\nevent: perception\ndata: ${JSON.stringify(e)}\n\n`;
}

/** What a reconnecting client missed: after its last id, or since a time; nothing for a new client. */
export function missed(all: PerceptionEvent[], lastId: string | undefined, since: string | undefined, now: Date): PerceptionEvent[] {
  const floor = new Date(now.getTime() - MAX_REPLAY_MS).toISOString();
  if (lastId) {
    const i = all.findLastIndex((e) => e.event_id === lastId);
    if (i >= 0) return all.slice(i + 1).filter((e) => e.ts >= floor);
    // an id we no longer have: the last day (clients drop duplicates by id)
    const from = new Date(now.getTime() - UNKNOWN_ID_REPLAY_MS).toISOString();
    return all.filter((e) => e.ts >= from);
  }
  if (since) {
    const t = new Date(since);
    if (Number.isNaN(t.getTime())) return [];
    const from = t.toISOString() > floor ? t.toISOString() : floor;
    return all.filter((e) => e.ts >= from);
  }
  return [];
}

export class EventStream {
  private clients = new Map<ServerResponse, McpClient>();

  constructor(private readonly d: EventStreamDeps) {}

  get size(): number {
    return this.clients.size;
  }

  push(e: PerceptionEvent): void {
    for (const [res, client] of this.clients) res.write(frame(this.for(e, client)));
  }

  private for(e: PerceptionEvent, client: McpClient): PerceptionEvent {
    return eventFor(e, client, this.d.allowed?.() ?? []);
  }

  handle(req: IncomingMessage, res: ServerResponse): void {
    const client = this.d.tokens.verify(bearer(req.headers.authorization));
    if (!client) {
      res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer realm="percezione"' });
      res.end(JSON.stringify({ ok: false, errors: ["missing or invalid token"] }));
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { Allow: "GET", "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, errors: ["method not allowed"] }));
      return;
    }
    const url = new URL(req.url ?? "/", "http://x");
    const lastId = (req.headers["last-event-id"] as string | undefined) || url.searchParams.get("after") || undefined;
    const since = url.searchParams.get("since") ?? undefined;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 5000\n\n");
    // replay and subscription in the same tick: no event can fall in between
    for (const e of missed(this.d.events(), lastId, since, this.d.now?.() ?? new Date())) res.write(frame(this.for(e, client)));
    this.clients.set(res, client);
    console.log(`live events: connected "${client.name}"${lastId ? ` (resuming from ${lastId})` : ""}`);
    const ping = setInterval(() => res.write(": ping\n\n"), this.d.heartbeatMs ?? 20_000);
    res.on("close", () => {
      clearInterval(ping);
      this.clients.delete(res);
      console.log(`live events: disconnected "${client.name}"`);
    });
  }
}
