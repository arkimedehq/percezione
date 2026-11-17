import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writePrivate } from "./secrets.ts";

/**
 * Tokens of the MCP clients (agents) allowed to query the read-only MCP server (src/mcp.ts).
 * - One token per client, so each can be revoked alone.
 * - Only the sha256 of a token is stored: the token is shown once, when it is created.
 * - Separate from the UI password and sessions: an agent never gets to change the configuration.
 * - Two roles. An agent (an AI assistant) uses /mcp and /events and sees images only of the cameras the owner allowed;
 *   a device (a wall panel, a doorbell, a photo archive) reports external events, imports faces and gets their
 *   pictures, but has no MCP. A token without a role (made before roles existed) is an agent.
 */
export type ClientRole = "agent" | "device";
export const CLIENT_ROLES: readonly ClientRole[] = ["agent", "device"];

export interface McpClient {
  id: string;
  name: string;
  role: ClientRole;
  created: string;
  last_used: string | null;
}

interface Stored extends McpClient {
  hash: string;
}

const PREFIX = "pcz_";
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

export class McpTokens {
  private clients: Stored[];
  private dirty = false;

  constructor(
    private readonly path: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    const stored = existsSync(path) ? ((JSON.parse(readFileSync(path, "utf8")) as { clients: Stored[] }).clients ?? []) : [];
    this.clients = stored.map((c) => ({ ...c, role: c.role === "device" ? "device" : "agent" }));
  }

  list(): McpClient[] {
    return this.clients.map(({ hash: _hash, ...c }) => c);
  }

  /** New client; the token comes back only here. */
  create(name: string, role: ClientRole = "agent"): { client: McpClient; token: string } {
    const token = PREFIX + randomBytes(32).toString("hex");
    const stored: Stored = { id: randomUUID(), name, role, created: this.now().toISOString(), last_used: null, hash: hashOf(token) };
    this.clients.push(stored);
    this.save();
    const { hash: _hash, ...client } = stored;
    return { client, token };
  }

  revoke(id: string): boolean {
    const before = this.clients.length;
    this.clients = this.clients.filter((c) => c.id !== id);
    if (this.clients.length === before) return false;
    this.save();
    return true;
  }

  /** The client owning the token, or null. Last use is written at most once a minute. */
  verify(token: string | undefined): McpClient | null {
    if (!token?.startsWith(PREFIX)) return null;
    const h = Buffer.from(hashOf(token), "hex");
    const hit = this.clients.find((c) => timingSafeEqual(Buffer.from(c.hash, "hex"), h));
    if (!hit) return null;
    const now = this.now();
    if (!hit.last_used || now.getTime() - Date.parse(hit.last_used) > 60_000) {
      hit.last_used = now.toISOString();
      this.dirty = true;
    }
    if (this.dirty) this.save();
    const { hash: _hash, ...client } = hit;
    return client;
  }

  private save(): void {
    writePrivate(this.path, JSON.stringify({ clients: this.clients }, null, 2) + "\n");
    this.dirty = false;
  }
}
