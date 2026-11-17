import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, createReadStream, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { Readable, Transform } from "node:stream";
import type { Analyzers } from "./analyzers.ts";
import { SCHEMA_VERSION, type Broadcast, type PerceptionEvent } from "./events.ts";
import { describeOp, planPush } from "./frigate-config.ts";
import { makeBackup, readBackup, restoreBackup } from "./backup.ts";
import type { FaceImports } from "./face-import.ts";
import { type UiPassword, writePrivate } from "./secrets.ts";
import type { FrigateSync } from "./frigate-sync.ts";
import { evaluateRules } from "./rules.ts";
import type { EventStream } from "./event-stream.ts";
import { bearer, handleMcp, type McpDeps } from "./mcp.ts";
import { externalRequest, type External } from "./external.ts";
import { CLIENT_ROLES, type ClientRole, type McpClient } from "./mcp-tokens.ts";
import { canSeePictures, eventFor } from "./pictures.ts";
import { hostAllowed, sameOrigin } from "./host.ts";
import type { Outputs } from "./outputs.ts";
import type { UsageCollector } from "./usage.ts";
import { groupAttempts, personId, type FrigateFaces } from "./people.ts";
import type { WhoAt } from "./who.ts";
import { importSources, sourceUrl, type Restream, type SourcePasswords } from "./restream.ts";
import { groupMains, RuleSchema, validate, type CameraConfig, type ConfigStore } from "./settings.ts";

/**
 * Configuration API and frontend, on the LAN and behind a password.
 * Frigate's (admin) API and the go2rtc login stay here: the browser sees only this service.
 */
export interface ApiDeps {
  store: ConfigStore;
  sync: FrigateSync;
  analyzers: Analyzers;
  frigateUrl: string;
  go2rtc: { apiUrl?: string; user?: string; password?: string; rtspBase?: string };
  timelinePath: string;
  /** before/after photos of left objects */
  mediaDir: string;
  /** the UI password: UI_PASSWORD, or the one chosen at first start (src/secrets.ts) */
  password: Pick<UiPassword, "isSet" | "set" | "check">;
  distDir: string;
  /** disk and resource usage for the Usage page */
  usage?: UsageCollector;
  /** names of your own domain the UI answers to, besides addresses and local names (src/host.ts) */
  hosts?: string[];
  /** port of Frigate's UI behind this login (src/frigate-proxy.ts), for the link in the frontend */
  frigateUiPort?: number;
  /** sessions survive a restart here (token hashes and expiry); without it they live in memory only */
  sessionsPath?: string;
  /** read-only MCP server for agents at /mcp, with its own tokens (not the UI login) */
  mcp?: McpDeps;
  /** live events at /events (SSE), with the same client tokens as /mcp */
  events?: EventStream;
  /** deliveries with an outbox: MQTT and webhooks (the Outputs page) */
  outputs?: Outputs;
  /** webhook secrets: rotated (and shown once) from the Outputs page */
  webhookSecrets?: { rotate(name: string): string };
  /** the people of Frigate's face library (src/people.ts) */
  faces?: FrigateFaces;
  /** photos already imported by other programs (src/face-import.ts) */
  faceImports?: FaceImports;
  /** who is at one camera right now (src/who.ts) */
  /** with photos: each person's best face (S8d) */
  whoIsAt?(camera: string, photos?: boolean): Promise<WhoAt>;
  /** external events (src/external.ts) and the folder of their pictures */
  external?: { handler: External; dir: string };
  /** data/: backup and restore read and write its files (src/backup.ts) */
  dataDir?: string;
  /** after a restore: tokens, secrets and passwords are read at start (in Docker the container comes back by itself) */
  restart?(): void;
  /**
   * Resolves when the last configuration change has reached go2rtc and Frigate. Restarting before that would leave
   * cameras out of Frigate, and the import at start would take them out of the configuration too.
   */
  settled?(): Promise<void>;
  /** what /healthz reports: each part Percezione needs, up or not */
  health?(): Promise<Record<string, boolean>>;
  /** the camera of a Frigate track, for faces whose event Frigate no longer keeps (src/track-log.ts) */
  trackCamera?(id: string): string | undefined;
  /** Percezione's own go2rtc: sources' passwords, status, and the login shown when sharing is on */
  restream?: { restream: Restream; passwords: SourcePasswords; apply(): Promise<void>; login: { user?: string; password?: string } };
  /** "Try now": activity on the camera's current frame, with the given rules */
  tryActivity(camera: string, activity: NonNullable<CameraConfig["observe"]["activity"]>): Promise<unknown>;
}

type Handler = (req: IncomingMessage, res: ServerResponse, params: string[]) => Promise<void> | void;

const SESSION_MS = 12 * 3600_000;
const COOKIE = "percezione";
/** reachable without a session */
const PUBLIC = new Set(["/api/login", "/api/setup"]);
const COOKIE_RE = /(?:^|;\s*)percezione=([a-f0-9]{64})/;

export class Api {
  readonly server: Server;
  private sessions = new Map<string, number>();
  /**
   * Wrong passwords, counted for everyone (parallel requests or many addresses don't help): from the third one the next
   * check waits longer, 1, 2, 4… up to 60 s; a right one starts again. Checks run one at a time.
   */
  private login_ = { failures: 0, openAt: 0, queue: Promise.resolve(false) };
  private clients = new Set<WebSocket>();
  private streamsCache?: { at: number; names: Set<string> };
  private routes: [string, RegExp, Handler][] = [];

  constructor(private readonly d: ApiDeps) {
    this.loadSessions();
    this.routeTable();
    this.server = createServer((req, res) => void this.handle(req, res));
    const wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (!hostAllowed(req.headers.host, this.d.hosts) || !sameOrigin(req.headers.origin, req.headers.host) || !this.authed(req) || !["/api/ws", "/api/live"].includes(url.pathname)) {
        socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (url.pathname === "/api/ws") this.addClient(ws);
        else void this.live(ws, url.searchParams.get("src") ?? "");
      });
    });
  }

  listen(port: number, host: string): Promise<void> {
    return new Promise((done) => this.server.listen(port, host, done));
  }

  close(): void {
    for (const ws of this.clients) ws.terminate();
    this.server.close();
  }

  /** Message to every open frontend: events, new versions, outcomes towards Frigate. */
  broadcast(msg: Broadcast): void {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }

  private routeTable(): void {
    const r = (method: string, path: string, h: Handler) => this.routes.push([method, new RegExp(`^${path}$`), h]);
    r("POST", "/api/login", (req, res) => this.login(req, res));
    // first start: anyone who reaches the UI chooses the password, once; afterwards these say only that it is set
    r("GET", "/api/setup", (_q, res) => json(res, 200, { password_set: this.d.password.isSet }));
    r("POST", "/api/setup", async (req, res) => {
      if (this.d.password.isSet) return json(res, 409, { ok: false, errors: ["the password is already set: log in"] });
      const { password } = (await body(req)) as { password?: unknown };
      if (typeof password !== "string" || password.length < 8) return json(res, 422, { ok: false, errors: ["at least 8 characters"] });
      this.d.password.set(password);
      this.openSession(res);
      json(res, 200, { ok: true });
    });
    r("POST", "/api/logout", (req, res) => {
      this.sessions.delete(sessionKey(this.token(req) ?? ""));
      this.saveSessions();
      res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      json(res, 200, { ok: true });
    });
    r("GET", "/api/me", (_q, res) => json(res, 200, { ok: true }));
    r("GET", "/api/backup", async (req, res) => {
      if (!this.d.dataDir) return json(res, 404, { ok: false, errors: ["backup not available"] });
      const secrets = new URL(req.url ?? "/", "http://x").searchParams.get("secrets") === "1";
      const gz = await makeBackup({ config: this.d.store.current, dataDir: this.d.dataDir, faces: this.d.faces }, secrets);
      const day = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="percezione-backup-${day}.json.gz"`,
        "Content-Length": gz.length,
      });
      res.end(gz);
    });
    r("POST", "/api/restore", async (req, res) => {
      if (!this.d.dataDir) return json(res, 404, { ok: false, errors: ["restore not available"] });
      let backup;
      try {
        backup = readBackup(await raw(req, 100_000_000));
      } catch (err) {
        return json(res, 422, { ok: false, errors: [(err as Error).message] });
      }
      const result = await restoreBackup(backup, { dataDir: this.d.dataDir, save: (c) => this.d.store.save(c), faces: this.d.faces });
      await (this.d.settled ? this.d.settled() : this.d.sync.idle());
      json(res, 200, { ok: result.errors.length === 0, restarting: !!this.d.restart, ...result });
      if (this.d.restart) setTimeout(() => this.d.restart!(), 500);
    });
    r("GET", "/api/config", (_q, res) => json(res, 200, this.d.store.current));
    r("POST", "/api/config/preview", async (req, res) => {
      const { config } = (await body(req)) as { config: unknown };
      json(res, 200, await this.preview(config));
    });
    r("PUT", "/api/config", async (req, res) => {
      const { config, base_version } = (await body(req)) as { config: unknown; base_version: number };
      // another change (by hand, from Frigate, from another tab) arrived in the meantime
      if (base_version !== this.d.store.current.version) {
        return json(res, 409, { ok: false, errors: [`the configuration moved to v${this.d.store.current.version}: reload`] });
      }
      const v = this.d.store.save(config);
      json(res, v.ok ? 200 : 422, v.ok ? { ok: true, version: this.d.store.current.version } : v);
    });
    r("GET", "/api/config/history", (_q, res) => json(res, 200, this.d.store.history()));
    r("GET", "/api/config/history/([^/]+)", (_q, res, [file]) => json(res, 200, this.d.store.historyFile(file!)));
    r("POST", "/api/config/restore", async (req, res) => {
      const { file } = (await body(req)) as { file: string };
      const v = this.d.store.save(this.d.store.historyFile(file));
      json(res, v.ok ? 200 : 422, v.ok ? { ok: true, version: this.d.store.current.version } : v);
    });
    r("GET", "/api/events", (req, res) => {
      const q = new URL(req.url!, "http://x").searchParams;
      const since = q.get("since") ?? "";
      const limit = Math.min(Number(q.get("limit") ?? 200), 2000);
      json(res, 200, recentEvents(this.d.timelinePath).filter((e) => e.ts >= since).slice(-limit).reverse());
    });
    r("POST", "/api/rules/test", async (req, res) => {
      const { rule, hours = 24 } = (await body(req)) as { rule: unknown; hours?: number };
      const parsed = RuleSchema.safeParse(rule);
      if (!parsed.success) {
        return json(res, 422, { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
      }
      const since = new Date(Date.now() - hours * 3600_000).toISOString();
      const events = recentEvents(this.d.timelinePath).filter((e) => e.ts >= since);
      const rule1 = { ...parsed.data, enabled: true };
      const hits = events.filter((e) => evaluateRules(e, [rule1], new Date(e.ts)).reactions.length > 0).reverse();
      json(res, 200, { ok: true, total: events.length, hits });
    });
    r("GET", "/api/status", async (_q, res) => {
      const stats = (await (await fetch(`${this.d.frigateUrl}/api/stats`, { signal: AbortSignal.timeout(5_000) })).json()) as {
        service: { uptime: number; version: string };
        cameras: Record<string, { camera_fps: number; detection_fps: number; connection_quality?: string }>;
      };
      json(res, 200, {
        version: this.d.store.current.version,
        frigate: { uptime: stats.service.uptime, version: stats.service.version, ui_port: this.d.frigateUiPort ?? null },
        cameras: Object.fromEntries(
          Object.entries(stats.cameras).map(([k, v]) => [k, { fps: v.camera_fps, detection_fps: v.detection_fps, quality: v.connection_quality }]),
        ),
      });
    });
    r("GET", "/api/streams", async (_q, res) => {
      const names = [...(await this.streamNames())].sort();
      const used = new Map<string, string>();
      for (const [cam, c] of Object.entries(this.d.store.current.cameras)) if (c.stream && "go2rtc" in c.stream) used.set(c.stream.go2rtc, cam);
      json(res, 200, names.map((name) => ({ name, camera: used.get(name) ?? null })));
    });
    r("GET", "/api/streams/([^/]+)/frame\\.jpg", async (_q, res, [name]) => {
      if (!(await this.streamNames()).has(name!)) return json(res, 404, { ok: false });
      await pipe(res, await this.go2rtcFetch(`/api/frame.jpeg?src=${encodeURIComponent(name!)}`));
    });
    r("GET", "/api/cameras/([a-z0-9_]+)/frame\\.jpg", async (_q, res, [cam]) => {
      await pipe(res, await fetch(`${this.d.frigateUrl}/api/${cam}/latest.jpg?height=720`, { signal: AbortSignal.timeout(10_000) }));
    });
    r("POST", "/api/cameras/([a-z0-9_]+)/try", async (req, res, [cam]) => {
      const { activity } = (await body(req)) as { activity?: NonNullable<CameraConfig["observe"]["activity"]> };
      const a = activity ?? this.d.store.current.cameras[cam!]?.observe.activity;
      if (!a) return json(res, 422, { ok: false, errors: ["the camera has no activity observation"] });
      json(res, 200, { ok: true, result: await this.d.tryActivity(cam!, a) });
    });
    r("GET", "/api/mcp/clients", (_q, res) => json(res, 200, this.d.mcp?.tokens.list() ?? []));
    // Percezione's go2rtc: status, which sources have a password, and (sharing on) the login and addresses
    r("GET", "/api/restream", async (_q, res) => {
      const rs = this.d.restream;
      if (!rs) return json(res, 404, { ok: false, errors: ["restream not available"] });
      const cfg = this.d.store.current;
      const status = await rs.restream.status();
      const host = cfg.restream.address;
      const streams = Object.entries(cfg.sources).flatMap(([id, x]) => (x.sub ? [id, `${id}_sub`] : [id]));
      json(res, 200, {
        ...status,
        share: cfg.restream.share,
        sources: Object.fromEntries(Object.keys(cfg.sources).map((id) => [id, { has_password: rs.passwords.has(id) }])),
        // the login and the addresses only when the owner shares the streams
        ...(cfg.restream.share && host
          ? {
              login: rs.login,
              // go2rtc's web pages are closed (allow_paths): RTSP, the MP4 stream and WebRTC (WHEP) are what other apps use
              addresses: streams.map((name) => {
                const src = encodeURIComponent(name);
                return { name, rtsp: `rtsp://${host}:8554/${name}`, mp4: `http://${host}:1984/api/stream.mp4?src=${src}`, webrtc: `http://${host}:1984/api/webrtc?src=${src}` };
              }),
            }
          : {}),
      });
    });
    r("PUT", "/api/sources/([a-z0-9-]+)/password", async (req, res, [id]) => {
      const rs = this.d.restream;
      if (!rs) return json(res, 404, { ok: false, errors: ["restream not available"] });
      const { password } = (await body(req)) as { password?: string };
      if (typeof password !== "string" || !password) return json(res, 422, { ok: false, errors: ["a password is needed"] });
      rs.passwords.set(id!, password);
      // a source not saved yet (a new camera): its password waits for the configuration that adds it
      if (id! in this.d.store.current.sources) await rs.apply();
      json(res, 200, { ok: true });
    });
    // a frame from an address not saved yet (the add-camera wizard): go2rtc opens it once, the password stays here
    r("POST", "/api/sources/probe", async (req, res) => {
      const { url, password } = (await body(req)) as { url?: string; password?: string };
      if (!url || !/^(rtsps?|https?):\/\//.test(url)) return json(res, 422, { ok: false, errors: ["an rtsp:// or http:// address is needed"] });
      try {
        // a stream of its own with a random name: without `name`, go2rtc would name it after the address, password
        // included, and print that name in its warnings. It lives in go2rtc's memory only (not in go2rtc.yaml) until
        // go2rtc restarts, which saving the camera does.
        const name = `_probe_${randomBytes(4).toString("hex")}`;
        const upstream = await this.go2rtcFetch(`/api/frame.jpeg?name=${name}&src=${encodeURIComponent(sourceUrl(url, password || undefined))}`, 20_000);
        const jpeg = Buffer.from(await upstream.arrayBuffer());
        // go2rtc answers 200 with nothing when it cannot open the address
        if (!upstream.ok || jpeg.length === 0) return json(res, 502, { ok: false, errors: ["no frame: check the address and the password"] });
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store" });
        res.end(jpeg);
      } catch (err) {
        json(res, 502, { ok: false, errors: [(err as Error).message] });
      }
    });
    // sources from another go2rtc (e.g. the wall panel's): added to the configuration with that go2rtc's password
    r("POST", "/api/sources/import", async (req, res) => {
      const rs = this.d.restream;
      if (!rs) return json(res, 404, { ok: false, errors: ["restream not available"] });
      const { url, user, password } = (await body(req)) as { url?: string; user?: string; password?: string };
      if (!url || !user || !password) return json(res, 422, { ok: false, errors: ["address, user and password are needed"] });
      let found: Awaited<ReturnType<typeof importSources>>;
      try {
        found = await importSources(url, user, password);
      } catch (err) {
        return json(res, 502, { ok: false, errors: [(err as Error).message] });
      }
      const cfg = this.d.store.current;
      const added = Object.keys(found).filter((id) => !(id in cfg.sources));
      for (const id of added) rs.passwords.set(id, password);
      const v = this.d.store.save({ ...cfg, sources: { ...cfg.sources, ...Object.fromEntries(added.map((id) => [id, found[id]])) } });
      json(res, v.ok ? 200 : 422, v.ok ? { ok: true, added, version: this.d.store.current.version } : v);
    });
    r("GET", "/api/groups/([a-z0-9_]+)/who", async (q, res, [id]) => {
      if (!this.d.whoIsAt) return json(res, 404, { ok: false, errors: ["not available"] });
      if (!(id! in this.d.store.current.groups)) return json(res, 404, { ok: false, errors: [`unknown group "${id}"`] });
      json(res, 200, await this.d.whoIsAt(id!, new URL(q.url!, "http://x").searchParams.get("photos") === "1"));
    });
    r("GET", "/api/cameras/([a-z0-9_]+)/who", async (q, res, [cam]) => {
      if (!this.d.whoIsAt) return json(res, 404, { ok: false, errors: ["not available"] });
      if (!(cam! in this.d.store.current.cameras)) return json(res, 404, { ok: false, errors: [`unknown camera "${cam}"`] });
      json(res, 200, await this.d.whoIsAt(cam!, new URL(q.url!, "http://x").searchParams.get("photos") === "1"));
    });
    // who is in view now, recognized or not (the home page)
    r("GET", "/api/presence", (_q, res) => {
      if (!this.d.mcp) return json(res, 404, { ok: false, errors: ["presence not available"] });
      const cfg = this.d.store.current;
      const placeOf = (c: string) => cfg.cameras[c]?.place ?? c;
      const { present, unnamed } = this.d.mcp.presence();
      json(res, 200, {
        present: present.map((p) => ({ ...p, place: placeOf(p.camera) })),
        unrecognized: [...unnamed].map(([camera, people]) => ({ camera, place: placeOf(camera), people })),
      });
    });
    // the people of the face library, with their faces and when they were last seen (the People page, the setup guide)
    r("GET", "/api/people", async (_q, res) => {
      const faces = this.d.faces;
      if (!faces) return json(res, 404, { ok: false, errors: ["people not available"] });
      const last = new Map<string, string>();
      for (const e of recentEvents(this.d.timelinePath)) if (e.person) last.set(e.person.name, e.ts);
      try {
        json(res, 200, (await faces.list()).map((p) => ({ ...p, last_seen: last.get(p.id) ?? null })));
      } catch (err) {
        json(res, 502, { ok: false, errors: [(err as Error).message] });
      }
    });
    // "to name": Frigate's recent attempts by passage, with camera and place from the timeline (or Frigate)
    r("GET", "/api/people/unknown", async (req, res) => {
      const faces = this.d.faces;
      if (!faces) return json(res, 404, { ok: false, errors: ["people not available"] });
      const all = new URL(req.url!, "http://x").searchParams.has("all");
      let attempts;
      try {
        attempts = await faces.attempts();
      } catch (err) {
        return json(res, 502, { ok: false, errors: [(err as Error).message] });
      }
      const cfg = this.d.store.current;
      const seen = new Map<string, { camera: string; place: string }>();
      for (const e of recentEvents(this.d.timelinePath)) for (const id of e.media.frigate_ids) seen.set(id, { camera: e.camera, place: e.place });
      // passages that made no event of ours (nobody recognized): the track log, else Frigate's event
      for (const event of new Set(attempts.map((a) => a.event))) {
        if (seen.has(event)) continue;
        const logged = this.d.trackCamera?.(event);
        if (logged) {
          seen.set(event, { camera: logged, place: cfg.cameras[logged]?.place ?? logged });
          continue;
        }
        const r = await fetch(`${this.d.frigateUrl}/api/events/${event}`, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
        const camera = r?.ok ? ((await r.json()) as { camera?: string }).camera : undefined;
        if (camera) seen.set(event, { camera, place: cfg.cameras[camera]?.place ?? camera });
      }
      const groups = groupAttempts(attempts, (event) => seen.get(event));
      json(res, 200, all ? groups : groups.filter((g) => !g.recognized));
    });
    r("POST", "/api/people/unknown/assign", async (req, res) => {
      const { files, to } = (await body(req)) as { files?: string[]; to?: string };
      const id = personId(to ?? "");
      if (!id || !files?.length) return json(res, 422, { ok: false, errors: ["faces and a valid name are needed"] });
      await this.people(res, async (f) => {
        // "alice" for an existing "Alice" is Alice, not someone new
        const existing = (await f.list()).find((p) => p.id.toLowerCase() === id.toLowerCase())?.id ?? id;
        await f.assign(files, existing);
        return { id: existing };
      });
    });
    r("POST", "/api/people/unknown/discard", async (req, res) => {
      const { files } = (await body(req)) as { files?: string[] };
      if (!files?.length) return json(res, 422, { ok: false, errors: ["faces are needed"] });
      await this.people(res, async (f) => (await f.discard(files), {}));
    });
    r("POST", "/api/people", async (req, res) => {
      const { name } = (await body(req)) as { name?: string };
      const id = personId(name ?? "");
      if (!id) return json(res, 422, { ok: false, errors: ["letters, digits, spaces, ' and - only, at most 50"] });
      await this.people(res, async (f) => {
        if ((await f.list()).some((p) => p.id.toLowerCase() === id.toLowerCase())) throw new Error(`"${id}" already exists`);
        await f.create(id);
        return { id };
      });
    });
    r("PUT", "/api/people/([^/]+)", async (req, res, [id]) => {
      const { name } = (await body(req)) as { name?: string };
      const to = personId(name ?? "");
      if (!to) return json(res, 422, { ok: false, errors: ["letters, digits, spaces, ' and - only, at most 50"] });
      await this.people(res, async (f) => (await f.rename(pid(id!), to), { id: to }));
    });
    r("DELETE", "/api/people/([^/]+)", async (_q, res, [id]) => {
      await this.people(res, async (f) => {
        await f.remove(pid(id!));
        // the same photos may be imported again for a new person with that name
        this.d.faceImports?.forget(pid(id!));
        return {};
      });
    });
    r("POST", "/api/people/([^/]+)/merge", async (req, res, [id]) => {
      const { into } = (await body(req)) as { into?: string };
      if (!into) return json(res, 422, { ok: false, errors: ["who to merge into is needed"] });
      await this.people(res, async (f) => ({ moved: await f.merge(pid(id!), pid(into)) }));
    });
    // a photo of the person, multipart field "file": Frigate crops the face; an infrared photo goes to the night folder
    r("POST", "/api/people/([^/]+)/faces", async (req, res, [id]) => {
      const file = await formFile(req);
      if (!file) return json(res, 422, { ok: false, errors: ["a photo is needed (field \"file\")"] });
      if (!this.d.faces) return json(res, 404, { ok: false, errors: ["people not available"] });
      try {
        const night = await this.d.faces.upload(pid(id!), file, (file as File).name || "photo.jpg");
        json(res, 200, { ok: true, night });
      } catch (err) {
        json(res, 422, { ok: false, errors: [(err as Error).message] });
      }
    });
    r("DELETE", "/api/people/([^/]+)/faces/([^/]+)", async (_q, res, [id, file]) => {
      await this.people(res, async (f) => (await f.removeFaces(pid(id!), [decodeURIComponent(file!)]), {}));
    });
    r("POST", "/api/people/([^/]+)/faces/([^/]+)/move", async (req, res, [id, file]) => {
      const { to } = (await body(req)) as { to?: string };
      if (!to) return json(res, 422, { ok: false, errors: ["who to move it to is needed"] });
      await this.people(res, async (f) => (await f.move(pid(id!), decodeURIComponent(file!), pid(to)), {}));
    });
    r("GET", "/api/people/([^/]+)/faces/([^/]+)", async (_q, res, [id, file]) => {
      if (!this.d.faces) return json(res, 404, { ok: false, errors: ["people not available"] });
      const up = await this.d.faces.image(pid(id!), decodeURIComponent(file!)).catch((err: Error) => err);
      if (up instanceof Error) return json(res, 502, { ok: false, errors: [up.message] });
      if (!up.ok) return json(res, up.status, { ok: false, errors: [`HTTP ${up.status}`] });
      res.writeHead(200, { "Content-Type": up.headers.get("content-type") ?? "image/webp", "Cache-Control": "private, max-age=3600" });
      res.end(Buffer.from(await up.arrayBuffer()));
    });
    r("POST", "/api/mcp/clients", async (req, res) => {
      const { name, role = "agent" } = (await body(req)) as { name?: string; role?: ClientRole };
      if (!this.d.mcp) return json(res, 404, { ok: false, errors: ["MCP server not active"] });
      if (!name?.trim() || name.length > 60) return json(res, 422, { ok: false, errors: ["a name is required (at most 60 characters)"] });
      if (!CLIENT_ROLES.includes(role)) return json(res, 422, { ok: false, errors: ["role: agent or device"] });
      // the token goes back only in this answer: it is never stored in clear
      json(res, 200, { ok: true, ...this.d.mcp.tokens.create(name.trim(), role) });
    });
    r("DELETE", "/api/mcp/clients/([0-9a-f-]+)", (_q, res, [id]) => {
      const ok = this.d.mcp?.tokens.revoke(id!) ?? false;
      json(res, ok ? 200 : 404, { ok });
    });
    r("GET", "/api/outputs", (_q, res) => json(res, 200, this.d.outputs?.status() ?? []));
    r("POST", "/api/outputs/webhooks/([a-z0-9_]+)/secret", (_q, res, [name]) => {
      if (!this.d.webhookSecrets || !(name! in this.d.store.current.outputs.webhooks)) return json(res, 404, { ok: false, errors: ["webhook not defined: save the configuration first"] });
      // the secret goes back only in this answer
      json(res, 200, { ok: true, secret: this.d.webhookSecrets.rotate(name!) });
    });
    r("POST", "/api/outputs/webhooks/([a-z0-9_]+)/test", async (_q, res, [name]) => {
      if (!this.d.outputs) return json(res, 404, { ok: false, errors: ["outputs not active"] });
      const r = await this.d.outputs.testWebhook(name!);
      json(res, 200, { ok: r.ok, errors: r.error ? [r.error] : [] });
    });
    r("GET", "/api/usage", async (req, res) => {
      if (!this.d.usage) return json(res, 404, { ok: false, errors: ["usage not available"] });
      json(res, 200, await this.d.usage.collect(new URL(req.url ?? "/", "http://x").searchParams.has("refresh")));
    });
    r("GET", "/api/analyzers", async (req, res) => {
      if (new URL(req.url!, "http://x").searchParams.has("refresh")) await this.d.analyzers.refresh();
      json(res, 200, this.d.analyzers.list());
    });
    // upload of a model (model.onnx + model.yml) to a runner: the multipart body passes through as is
    r("PUT", "/api/analyzers/([a-z0-9_]+)/models/([a-z0-9_-]+)", async (req, res, [endpoint, name]) => {
      const e = this.d.store.current.analyzers.endpoints[endpoint!];
      if (!e) return json(res, 404, { ok: false, errors: [`analyzer "${endpoint}" not defined`] });
      const up = await fetch(`${e.url}/models/${name}`, {
        method: "PUT",
        headers: { "Content-Type": req.headers["content-type"] ?? "application/octet-stream" },
        body: Readable.toWeb(req) as ReadableStream,
        duplex: "half",
        signal: AbortSignal.timeout(600_000),
      } as RequestInit);
      const body = (await up.json().catch(() => ({}))) as { detail?: string };
      await this.d.analyzers.refresh();
      json(res, up.status, up.ok ? { ok: true, ...body } : { ok: false, errors: [body.detail ?? `HTTP ${up.status}`] });
    });
    r("GET", "/api/left-objects/([0-9a-f-]+-(?:before|after)\\.jpg)", (_q, res, [file]) => {
      const path = resolve(this.d.mediaDir, file!);
      if (!existsSync(path)) return json(res, 404, { ok: false, errors: ["photo not found"] });
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" });
      createReadStream(path).pipe(res);
    });
    r("GET", "/api/external", (req, res) => this.external(req, res, new URL(req.url!, "http://x"), ""));
    r("POST", "/api/external", (req, res) => this.external(req, res, new URL(req.url!, "http://x"), ""));
    r("GET", "/api/external/([0-9a-f-]+\\.jpg)", (req, res, [file]) => this.external(req, res, new URL(req.url!, "http://x"), `/${file}`));
    r("GET", "/api/events/([\\w.-]+)/snapshot\\.jpg", async (_q, res, [id]) => {
      await pipe(res, await fetch(`${this.d.frigateUrl}/api/events/${id}/snapshot.jpg`, { signal: AbortSignal.timeout(10_000) }));
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    try {
      // for Docker and monitors: no login, nothing but up or down
      if (url.pathname === "/healthz") return await this.healthz(res);
      // agents authenticate with their MCP token, never with the UI cookie
      if (url.pathname === "/mcp") return this.d.mcp ? await handleMcp(this.d.mcp, req, res) : json(res, 404, { ok: false });
      if (url.pathname === "/events") return this.d.events ? this.d.events.handle(req, res) : json(res, 404, { ok: false });
      // devices (a wall panel, a doorbell) report external events and get their pictures; agents only read them, with
      // the pictures of the cameras the owner allowed. The UI reaches the same through /api/external
      if (url.pathname === "/external" || url.pathname.startsWith("/external/")) {
        const client = this.d.mcp?.tokens.verify(bearer(req.headers.authorization));
        if (!client) return json(res, 401, { ok: false, errors: ["token required"] });
        if (req.method !== "GET" && client.role !== "device") return json(res, 403, { ok: false, errors: ["only a device token can report external events"] });
        return await this.external(req, res, url, url.pathname.slice("/external".length), client);
      }
      // other programs (a photo archive): the people and their faces; agents only read the list
      if (url.pathname === "/people" || url.pathname.startsWith("/people/")) {
        const client = this.d.mcp?.tokens.verify(bearer(req.headers.authorization));
        if (!client) return json(res, 401, { ok: false, errors: ["token required"] });
        if (req.method !== "GET" && client.role !== "device") return json(res, 403, { ok: false, errors: ["only a device token can add people or faces"] });
        return await this.peopleImport(req, res, url.pathname.slice("/people".length));
      }
      // the UI, for browsers: only under a local name, and changes only from its own pages (src/host.ts)
      if (!hostAllowed(req.headers.host, this.d.hosts)) return json(res, 403, { ok: false, errors: ["unknown host name: open Percezione by its address, or add the name to PERCEZIONE_HOSTS"] });
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET") && !sameOrigin(req.headers.origin, req.headers.host)) return json(res, 403, { ok: false, errors: ["request from another site"] });
      if (!url.pathname.startsWith("/api/")) return this.static(url.pathname, res);
      const route = this.routes.find(([m, re]) => m === req.method && re.test(url.pathname));
      if (!route) return json(res, 404, { ok: false, errors: ["unknown path"] });
      if (!PUBLIC.has(url.pathname) && !this.authed(req)) return json(res, 401, { ok: false, errors: ["login required"] });
      const params = (url.pathname.match(route[1]) ?? []).slice(1).map(decodeURIComponent);
      await route[2](req, res, params);
    } catch (err) {
      if (!res.headersSent) json(res, err instanceof TooLarge ? 413 : err instanceof Unprocessable ? 422 : 500, { ok: false, errors: [(err as Error).message] });
      else res.end();
    }
  }

  /** 200 when every part answers, 503 otherwise; the body says which one is down. */
  private async healthz(res: ServerResponse): Promise<void> {
    const parts = (await this.d.health?.()) ?? {};
    const ok = Object.values(parts).every(Boolean);
    json(res, ok ? 200 : 503, { ok, ...parts });
  }

  /**
   * External events (docs/external-events.md): GET the latest ("?kind=ring&limit=20"), GET "/<event>.jpg" a picture,
   * POST a new one (answered when it is written, after the second look).
   */
  private async external(req: IncomingMessage, res: ServerResponse, url: URL, rest: string, client?: McpClient): Promise<void> {
    const x = this.d.external;
    const allowed = this.d.store.current.outputs.mcp.snapshots;
    if (!x) return json(res, 404, { ok: false, errors: ["external events not available"] });
    if (req.method === "POST" && rest === "") {
      const r = externalRequest(await body(req).catch(() => null), Object.keys(this.d.store.current.cameras), groupMains(this.d.store.current));
      if ("error" in r) return json(res, 422, { ok: false, errors: [r.error] });
      return json(res, 200, { ok: true, event: eventFor(await x.handler.handle(r), client, allowed) });
    }
    if (req.method !== "GET") return json(res, 405, { ok: false, errors: ["GET or POST"] });
    if (rest === "") {
      const kind = url.searchParams.get("kind");
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 20) || 20, 200);
      const list = recentEvents(this.d.timelinePath).filter((e) => e.type === "external" && (!kind || e.value?.to === kind));
      return json(res, 200, list.slice(-limit).reverse().map((e) => eventFor(e, client, allowed)));
    }
    const file = rest.match(/^\/([0-9a-f-]+\.jpg)$/)?.[1];
    const path = file && resolve(x.dir, file);
    if (!path || !existsSync(path)) return json(res, 404, { ok: false, errors: ["picture not found"] });
    // a picture is named after its event (<event id>[-<n>[-face]].jpg): an agent sees it only if it may see the event's
    if (client?.role !== "device" && client) {
      const event = recentEvents(this.d.timelinePath).find((e) => e.type === "external" && file.startsWith(e.event_id));
      if (!event || !canSeePictures(client, event.cameras ?? [event.camera], allowed)) return json(res, 404, { ok: false, errors: ["picture not found"] });
    }
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" });
    createReadStream(path).pipe(res);
  }

  /**
   * The face import API (docs/people.md): GET /people (names and how many faces), POST /people {"name"} to create a
   * person, POST /people/<id>/faces with a photo (multipart "file") for a person who exists. A photo sent again is
   * skipped (src/face-import.ts).
   */
  private async peopleImport(req: IncomingMessage, res: ServerResponse, rest: string): Promise<void> {
    const faces = this.d.faces;
    if (!faces || !this.d.faceImports) return json(res, 404, { ok: false, errors: ["people not available"] });
    try {
      if (rest === "" && req.method === "GET") return json(res, 200, (await faces.list()).map((p) => ({ id: p.id, faces: p.faces.length })));
      if (rest === "" && req.method === "POST") {
        const { name } = ((await body(req).catch(() => ({}))) ?? {}) as { name?: string };
        const id = personId(name ?? "");
        if (!id) return json(res, 422, { ok: false, errors: ["name: letters, digits, spaces, ' and - only, at most 50"] });
        const same = (await faces.list()).find((p) => p.id.toLowerCase() === id.toLowerCase());
        if (same) return json(res, 409, { ok: false, id: same.id, errors: [`"${same.id}" already exists`] });
        await faces.create(id);
        return json(res, 201, { ok: true, id });
      }
      const id = rest.match(/^\/([^/]+)\/faces$/)?.[1];
      if (id && req.method === "POST") {
        const person = decodeURIComponent(id);
        if (!(await faces.list()).some((p) => p.id === person)) return json(res, 404, { ok: false, errors: [`no person "${person}": create it first`] });
        const file = await formFile(req);
        if (!file) return json(res, 422, { ok: false, errors: ["a photo is needed (field \"file\")"] });
        if (file.size > 10_000_000) return json(res, 413, { ok: false, errors: ["photo too large (10 MB at most)"] });
        return json(res, 200, { ok: true, ...(await this.d.faceImports.import(faces, person, file, (file as File).name || "photo.jpg")) });
      }
      json(res, 404, { ok: false, errors: ["GET /people, POST /people, POST /people/<id>/faces"] });
    } catch (err) {
      // too large, or Frigate refused the photo (no face in it) or is down
      json(res, err instanceof TooLarge ? 413 : 422, { ok: false, errors: [(err as Error).message] });
    }
  }

  /** What would change: validation errors and, if valid, what would be sent to Frigate. */
  /** A change to the face library: the result, or Frigate's message. */
  private async people(res: ServerResponse, fn: (f: FrigateFaces) => Promise<object>): Promise<void> {
    if (!this.d.faces) return json(res, 404, { ok: false, errors: ["people not available"] });
    try {
      json(res, 200, { ok: true, ...(await fn(this.d.faces)) });
    } catch (err) {
      json(res, err instanceof Unprocessable ? 422 : 502, { ok: false, errors: [(err as Error).message] });
    }
  }

  private async preview(input: unknown) {
    const v = validate({ ...(input as object), version: this.d.store.current.version + 1 });
    if (!v.ok) return { ok: false, errors: v.errors };
    const current = this.d.store.current;
    // rules, sources, outputs…: nothing for Frigate, and no need for it to be up
    if (JSON.stringify(current.cameras) === JSON.stringify(v.config.cameras)) return { ok: true, errors: [], frigate: [] };
    let raw;
    try {
      raw = await this.d.sync.fetchRaw();
    } catch {
      // Frigate down: the change is saved and sent when it is back (src/frigate-sync.ts)
      return { ok: true, errors: [], frigate: [], frigateDown: true };
    }
    const { ops, errors } = planPush(current, v.config, raw, this.d.go2rtc.rtspBase);
    return { ok: errors.length === 0, errors, frigate: ops.map(describeOp) };
  }

  private async login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { password } = (await body(req)) as { password?: string };
    const l = this.login_;
    const wait = l.openAt - Date.now();
    if (wait > 0) return json(res, 429, { ok: false, errors: [`too many wrong passwords: try again in ${Math.ceil(wait / 1000)} s`] });
    const check = typeof password === "string" ? l.queue.catch(() => false).then(() => this.d.password.check(password)) : Promise.resolve(false);
    l.queue = check;
    if (!(await check.catch(() => false))) {
      l.failures++;
      // two typing slips are free
      if (l.failures >= 3) l.openAt = Date.now() + Math.min(2 ** (l.failures - 3), 60) * 1000;
      return json(res, 401, { ok: false, errors: ["wrong password"] });
    }
    l.failures = 0;
    this.openSession(res);
    json(res, 200, { ok: true });
  }

  private openSession(res: ServerResponse): void {
    const token = randomBytes(32).toString("hex");
    this.sessions.set(sessionKey(token), Date.now() + SESSION_MS);
    this.saveSessions();
    res.setHeader("Set-Cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
  }

  private token(req: IncomingMessage): string | undefined {
    return (req.headers.cookie ?? "").match(COOKIE_RE)?.[1];
  }

  authed(req: IncomingMessage): boolean {
    const t = this.token(req);
    const exp = t ? this.sessions.get(sessionKey(t)) : undefined;
    if (!exp) return false;
    if (exp < Date.now()) {
      this.sessions.delete(sessionKey(t!));
      return false;
    }
    return true;
  }

  private loadSessions(): void {
    if (!this.d.sessionsPath || !existsSync(this.d.sessionsPath)) return;
    try {
      const saved = JSON.parse(readFileSync(this.d.sessionsPath, "utf8")) as Record<string, number>;
      const now = Date.now();
      for (const [k, exp] of Object.entries(saved)) if (exp > now) this.sessions.set(k, exp);
    } catch {
      // unreadable file: everyone logs in again
    }
  }

  private saveSessions(): void {
    if (!this.d.sessionsPath) return;
    const now = Date.now();
    const live = Object.fromEntries([...this.sessions].filter(([, exp]) => exp > now));
    writePrivate(this.d.sessionsPath, JSON.stringify(live));
  }

  private addClient(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
  }

  /** Live video: go2rtc's MSE WebSocket, with the login added here. */
  private async live(client: WebSocket, src: string): Promise<void> {
    if (!this.d.go2rtc.apiUrl || !(await this.streamNames().catch(() => new Set<string>())).has(src)) {
      client.close(4404, "unknown stream");
      return;
    }
    const upstream = new WebSocket(`${this.d.go2rtc.apiUrl.replace(/^http/, "ws")}/api/ws?src=${encodeURIComponent(src)}`, {
      headers: { Authorization: this.basic() },
    });
    const pending: [WebSocket.RawData, boolean][] = [];
    client.on("message", (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else pending.push([data, isBinary]);
    });
    upstream.on("open", () => {
      for (const [data, binary] of pending.splice(0)) upstream.send(data, { binary });
    });
    upstream.on("message", (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });
    const close = () => {
      client.close();
      upstream.close();
    };
    upstream.on("close", close);
    upstream.on("error", close);
    client.on("close", close);
  }

  private basic(): string {
    return `Basic ${Buffer.from(`${this.d.go2rtc.user ?? ""}:${this.d.go2rtc.password ?? ""}`).toString("base64")}`;
  }

  private go2rtcFetch(path: string, timeoutMs = 10_000): Promise<Response> {
    if (!this.d.go2rtc.apiUrl) throw new Error("GO2RTC_API_URL not set");
    return fetch(`${this.d.go2rtc.apiUrl}${path}`, { headers: { Authorization: this.basic() }, signal: AbortSignal.timeout(timeoutMs) });
  }

  private async streamNames(): Promise<Set<string>> {
    if (this.streamsCache && Date.now() - this.streamsCache.at < 60_000) return this.streamsCache.names;
    const res = await this.go2rtcFetch("/api/streams");
    if (!res.ok) throw new Error(`go2rtc /api/streams ${res.status}`);
    const names = new Set(Object.keys((await res.json()) as Record<string, unknown>));
    this.streamsCache = { at: Date.now(), names };
    return names;
  }

  private static(path: string, res: ServerResponse): void {
    const root = this.d.distDir;
    let file = resolve(root, `.${decodeURIComponent(path)}`);
    if (file !== root && !file.startsWith(root + sep)) return json(res, 404, { ok: false });
    // SPA: frontend routes fall back to index.html
    if (!existsSync(file) || statSync(file).isDirectory()) file = resolve(root, "index.html");
    if (!existsSync(file)) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("frontend not built: npm run build in frontend/");
      return;
    }
    // files with a hash in their name never change
    const cache = file.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache";
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": cache });
    createReadStream(file).pipe(res);
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

/** The "file" field of a multipart request, or null. */
/** A body over its limit: answered 413. */
class TooLarge extends Error {}

/** A request with a value that can't be right: answered 422. */
class Unprocessable extends Error {}

/** A person's id from the request: never a path (`..`, `/`) or a name Frigate would refuse. */
function pid(raw: string): string {
  const id = personId(raw);
  if (!id) throw new Unprocessable(`"${raw.slice(0, 60)}" is not a person's name: letters, digits, spaces, ' and - only, at most 50`);
  return id;
}

/** The "file" of a multipart body, read only up to `limit` bytes: a larger body is cut off, not kept in memory. */
async function formFile(req: IncomingMessage, limit = 12_000_000): Promise<Blob | null> {
  const tooLarge = () => new TooLarge(`photo too large (${Math.floor(limit / 1_000_000)} MB at most)`);
  if (Number(req.headers["content-length"] ?? 0) > limit) throw tooLarge();
  let size = 0;
  const counted = req.pipe(
    new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        done(size > limit ? tooLarge() : null, chunk);
      },
    }),
  );
  const form = await new Request("http://x", {
    method: "POST",
    headers: { "Content-Type": req.headers["content-type"] ?? "application/octet-stream" },
    body: Readable.toWeb(counted) as ReadableStream,
    duplex: "half",
  } as RequestInit)
    .formData()
    .catch(() => null);
  if (size > limit) {
    req.destroy();
    throw tooLarge();
  }
  const file = form?.get("file");
  return file instanceof Blob ? file : null;
}

/** The request's bytes, up to `max`. */
async function raw(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new Error("file too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error("request too large");
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

/** Only the token's hash is kept, so the sessions file is useless to whoever reads it. */
function sessionKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function pipe(res: ServerResponse, upstream: Response): Promise<void> {
  if (!upstream.ok) return json(res, upstream.status, { ok: false, errors: [`HTTP ${upstream.status}`] });
  res.writeHead(200, { "Content-Type": upstream.headers.get("content-type") ?? "image/jpeg", "Cache-Control": "no-store" });
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

/** The v3 events of the last ~4 MB of the timeline, oldest first. */
export function recentEvents(path: string, maxBytes = 4_000_000): PerceptionEvent[] {
  if (!existsSync(path)) return [];
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // the first line may be cut in half
    return lines.flatMap((l) => {
      try {
        const e = JSON.parse(l) as PerceptionEvent;
        return e.schema_version === SCHEMA_VERSION ? [e] : [];
      } catch {
        return [];
      }
    });
  } finally {
    closeSync(fd);
  }
}
