import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { writePrivate } from "./secrets.ts";
import type { Config } from "./settings.ts";

/**
 * Percezione's own go2rtc: one connection per camera, shared by Frigate, the live video of the frontend and, when
 * the owner turns sharing on, other apps on the network (the wall panel, Home Assistant, VLC).
 * - The streams are the configuration's `sources`: `<id>` and `<id>_sub`.
 * - Source passwords never go in config.json: they live in a file of their own (`SourcePasswords`), mode 600, and in
 *   go2rtc's credentials folder (`writeCredentials`), never in go2rtc.yaml: go2rtc masks them in its logs.
 * - go2rtc's own login comes from its environment (`${GO2RTC_USER}`, `${GO2RTC_PASSWORD}`, the same .env Frigate
 *   reads); in a packaged installation (deploy/) it is in the file, from the secrets of the setup service.
 * - Sharing off: RTSP and the API stay behind that login, which nobody else is given; WebRTC is off. Sharing on:
 *   WebRTC listens on 8555 with this machine's address as its candidate, and the frontend shows the login and the
 *   addresses.
 * go2rtc reads its config only at start: a changed file means a restart (POST /api/restart, a second or two).
 */

/** Source passwords, by source id. */
export class SourcePasswords {
  private values: Record<string, string>;

  constructor(private readonly path: string) {
    this.values = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, string>) : {};
  }

  get(id: string): string | undefined {
    return this.values[id];
  }

  has(id: string): boolean {
    return id in this.values;
  }

  set(id: string, password: string): void {
    this.values[id] = password;
    this.save();
  }

  /** Forgets the passwords of sources that are gone. */
  keepOnly(ids: string[]): void {
    const gone = Object.keys(this.values).filter((id) => !ids.includes(id));
    if (!gone.length) return;
    for (const id of gone) delete this.values[id];
    this.save();
  }

  private save(): void {
    writePrivate(this.path, JSON.stringify(this.values, null, 1) + "\n");
  }
}

/** API paths go2rtc answers to: the streams list, live video (MSE, MP4, WebRTC), snapshots, and the restart. */
const ALLOW_PATHS = ["/api", "/api/streams", "/api/ws", "/api/stream.mp4", "/api/webrtc", "/api/frame.jpeg", "/api/restart"];

/** The address with the password put back, and `#backchannel=0` on RTSP (see below). */
export function sourceUrl(url: string, password?: string): string {
  let out = url;
  if (password) {
    const u = new URL(url);
    if (u.username) {
      u.password = password;
      out = u.toString();
    }
  }
  // go2rtc otherwise asks RTSP cameras for the two-way audio channel, and some Hikvision cameras with a microphone
  // answer by resetting the connection, over and over
  if (/^rtsps?:/.test(out) && !out.includes("#")) out += "#backchannel=0";
  return out;
}

/** Where go2rtc reads the credentials of go2rtc.yaml (CREDENTIALS_DIRECTORY, deploy/docker-compose.yml): one file each. */
export const CREDENTIALS_DIR = "credentials";

/** The credential holding a source's password, e.g. SOURCE_FRONT_DOOR_PASSWORD. */
export function sourceCredential(id: string): string {
  return `SOURCE_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PASSWORD`;
}

/** A source address with `${NAME}` where its password goes; the value is the password as it is written in a URL. */
function sourceTemplate(url: string, password: string | undefined, name: string): { url: string; value?: string } {
  const full = sourceUrl(url, password);
  if (!password || full === sourceUrl(url)) return { url: full };
  const u = new URL(full);
  const value = u.password;
  return { url: full.replace(`${u.username}:${value}@`, () => `${u.username}:\${${name}}@`), value };
}

export interface Go2rtcFiles {
  yaml: string;
  /** file name in CREDENTIALS_DIR → value */
  credentials: Record<string, string>;
}

/**
 * go2rtc.yaml for the configuration, and its credentials. No password is in the YAML: each is a `${NAME}` that go2rtc
 * reads from CREDENTIALS_DIR (or, for our own installation's login, from its environment), and go2rtc writes every
 * value read that way as *** in its logs and API answers. A password written in the YAML would show up in its
 * warnings, e.g. on every reconnection to a camera. JSON strings are valid YAML scalars: any address stays intact.
 */
export function renderConfig(cfg: Pick<Config, "sources" | "restream">, passwords: Pick<SourcePasswords, "get">, login?: { user: string; password: string }): Go2rtcFiles {
  const q = JSON.stringify;
  const share = cfg.restream.share && !!cfg.restream.address;
  const credentials: Record<string, string> = {};
  // packaged installation: the login made by setup; our own: GO2RTC_USER and GO2RTC_PASSWORD in go2rtc's environment
  const [user, pass] = login ? ["PERCEZIONE_GO2RTC_USER", "PERCEZIONE_GO2RTC_PASSWORD"] : ["GO2RTC_USER", "GO2RTC_PASSWORD"];
  if (login) Object.assign(credentials, { [user]: login.user, [pass]: login.password });
  const auth = [`  username: "\${${user}}"`, `  password: "\${${pass}}"`];
  const lines = [
    "# Written by Percezione from data/config.json (sources, restream): do not edit here.",
    "api:",
    '  listen: ":1984"',
    ...auth,
    `  allow_paths: ${q(ALLOW_PATHS)}`,
    "rtsp:",
    '  listen: ":8554"',
    ...auth,
    "webrtc:",
    ...(share ? ['  listen: ":8555"', `  candidates: [${q(`${cfg.restream.address}:8555`)}]`] : ['  listen: ""']),
    "srtp:",
    '  listen: ""',
    "log:",
    "  level: warn",
    // the one warning that prints a source's address (a camera dropping); a saved source's password is masked there,
    // a probe's would not be (Api /api/sources/probe)
    "  streams: error",
    "streams:",
  ];
  for (const [id, s] of Object.entries(cfg.sources)) {
    const password = passwords.get(id);
    const name = sourceCredential(id);
    const main = sourceTemplate(s.url, password, name);
    if (main.value) credentials[name] = main.value;
    lines.push(`  ${q(id)}: ${q(main.url)}`);
    if (s.sub) {
      const sub = sourceTemplate(s.sub, password, name);
      if (sub.value) credentials[name] = sub.value;
      lines.push(`  ${q(`${id}_sub`)}: ${q(sub.url)}`);
    }
  }
  return { yaml: lines.join("\n") + "\n", credentials };
}

/**
 * Writes the credentials folder (mode 700, a file each, mode 600), removing the ones no longer used. Returns whether
 * anything changed.
 */
export function writeCredentials(dir: string, credentials: Record<string, string>): boolean {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  let changed = false;
  for (const name of readdirSync(dir)) {
    if (!(name in credentials)) {
      unlinkSync(resolve(dir, name));
      changed = true;
    }
  }
  for (const [name, value] of Object.entries(credentials)) {
    const path = resolve(dir, name);
    if (existsSync(path) && readFileSync(path, "utf8") === value) continue;
    writePrivate(path, value);
    changed = true;
  }
  return changed;
}

export interface RestreamDeps {
  /** where go2rtc.yaml goes: the folder mounted as go2rtc's /config */
  dir: string;
  /** go2rtc's API, e.g. http://127.0.0.1:1984, with its login */
  apiUrl?: string;
  user?: string;
  password?: string;
  /** write the login into go2rtc.yaml (the secrets of deploy/) instead of ${GO2RTC_USER} */
  loginInFile?: boolean;
  log?(message: string): void;
}

export interface RestreamStatus {
  /** go2rtc answers */
  up: boolean;
  version?: string;
  /** streams go2rtc has, with whether each one has a live connection to its source */
  streams: { name: string; active: boolean }[];
  error?: string;
}

export class Restream {
  readonly file: string;

  constructor(private readonly d: RestreamDeps) {
    mkdirSync(d.dir, { recursive: true });
    this.file = resolve(d.dir, "go2rtc.yaml");
  }

  /** Writes go2rtc.yaml when it changed and restarts go2rtc so it reads it. Returns whether it changed. */
  async apply(cfg: Config, passwords: SourcePasswords): Promise<boolean> {
    const login = this.d.loginInFile && this.d.user && this.d.password ? { user: this.d.user, password: this.d.password } : undefined;
    const next = renderConfig(cfg, passwords, login);
    const credentialsChanged = writeCredentials(resolve(this.d.dir, CREDENTIALS_DIR), next.credentials);
    if (!credentialsChanged && existsSync(this.file) && readFileSync(this.file, "utf8") === next.yaml) return false;
    writePrivate(this.file, next.yaml);
    this.d.log?.(`go2rtc: configuration written (${Object.keys(cfg.sources).length} sources)`);
    if (!this.d.apiUrl) return true;
    // go2rtc drops the connection while it restarts, so the answer itself says little: it counts if it is back
    await this.call("/api/restart", { method: "POST" }).catch(() => undefined);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if ((await this.status()).up) {
        this.d.log?.("go2rtc: restarted");
        return true;
      }
    }
    // not running: it reads the file when it starts
    this.d.log?.("go2rtc: not running, it will read the configuration when it starts");
    return true;
  }

  async status(): Promise<RestreamStatus> {
    try {
      const info = (await (await this.call("/api")).json()) as { version?: string };
      const list = (await (await this.call("/api/streams")).json()) as Record<string, { producers?: { state?: string; url?: string }[] | null }>;
      const streams = Object.entries(list).map(([name, s]) => ({ name, active: !!s.producers?.some((p) => p.state === "start" || p.state === "connect" || !!p.url) }));
      return { up: true, version: info.version, streams };
    } catch (err) {
      return { up: false, streams: [], error: (err as Error).message };
    }
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.d.apiUrl) throw new Error("GO2RTC_API_URL not set");
    const auth = `Basic ${Buffer.from(`${this.d.user ?? ""}:${this.d.password ?? ""}`).toString("base64")}`;
    const res = await fetch(`${this.d.apiUrl}${path}`, { ...init, headers: { Authorization: auth }, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`go2rtc ${path}: HTTP ${res.status}`);
    return res;
  }
}

/**
 * Sources from another go2rtc (e.g. the wall panel's): one per stream, `<name>_sub` as its light stream, read over
 * RTSP with that go2rtc's login. Names that are not valid source ids are skipped.
 */
export async function importSources(apiUrl: string, user: string, password: string): Promise<Record<string, { url: string; sub?: string }>> {
  const base = new URL(apiUrl);
  const auth = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  const res = await fetch(new URL("/api/streams", base), { headers: { Authorization: auth }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${base.origin}/api/streams`);
  const names = Object.keys((await res.json()) as Record<string, unknown>);
  const rtsp = (name: string) => `rtsp://${encodeURIComponent(user)}@${base.hostname}:8554/${encodeURIComponent(name)}`;
  const out: Record<string, { url: string; sub?: string }> = {};
  for (const name of names) {
    if (name.endsWith("_sub") || !/^[a-z0-9][a-z0-9-]*$/.test(name)) continue;
    out[name] = { url: rtsp(name), ...(names.includes(`${name}_sub`) ? { sub: rtsp(`${name}_sub`) } : {}) };
  }
  return out;
}
