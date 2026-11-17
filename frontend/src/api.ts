import type { Config, Rule } from "../../perception-service/src/settings.ts";
import type { Broadcast, PerceptionEvent } from "../../perception-service/src/events.ts";
import type { AnalyzerStatus } from "../../perception-service/src/analyzers.ts";
import type { Usage } from "../../perception-service/src/usage.ts";
import type { McpClient } from "../../perception-service/src/mcp-tokens.ts";
import type { OutputStatus } from "../../perception-service/src/outputs.ts";

export type { Config, Rule, PerceptionEvent, Broadcast, AnalyzerStatus, Usage, McpClient, OutputStatus };
export type Camera = Config["cameras"][string];
export type Activity = NonNullable<Camera["observe"]["activity"]>;
export type Reaction = Rule["then"][number];

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly errors: string[],
  ) {
    super(errors.join("; ") || `HTTP ${status}`);
  }
}

export const UNAUTHORIZED = "percezione:unauthorized";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  // session expired or lost: the app goes back to the login screen
  if (res.status === 401 && path !== "/api/login" && path !== "/api/setup") window.dispatchEvent(new Event(UNAUTHORIZED));
  if (!res.ok) throw new ApiError(res.status, (data as { errors?: string[] }).errors ?? []);
  return data as T;
}

export interface RestoreResult {
  ok: boolean;
  restarting: boolean;
  config_version?: number;
  files: string[];
  people: { id: string; added: number; kept?: true }[];
  errors: string[];
}

export interface Status {
  version: number;
  frigate: { uptime: number; version: string; ui_port: number | null };
  cameras: Record<string, { fps: number; detection_fps: number; quality?: string }>;
}
export interface AttemptGroup {
  event: string;
  camera: string | null;
  place: string | null;
  ts: string;
  attempts: { file: string; name: string | null; score: number }[];
  best: { name: string; score: number } | null;
  recognized: boolean;
}
export interface PersonInfo {
  id: string;
  /** files in the person's folder, newest first */
  faces: string[];
  last_seen: string | null;
}
export const faceUrl = (id: string, file: string) => `/api/people/${encodeURIComponent(id)}/faces/${encodeURIComponent(file)}`;
export interface Restream {
  up: boolean;
  version?: string;
  error?: string;
  streams: { name: string; active: boolean }[];
  share: boolean;
  sources: Record<string, { has_password: boolean }>;
  login?: { user?: string; password?: string };
  addresses?: { name: string; rtsp: string; mp4: string; webrtc: string }[];
}
export interface Presence {
  present: { name: string; camera: string; place: string; activity: string | null; posture: string | null; confidence: number | null; source: string }[];
  unrecognized: { camera: string; place: string; people: number }[];
}
export interface HistoryItem {
  file: string;
  version: number;
  ts: string;
}
export interface TryResult {
  attributes?: Record<string, boolean>;
  label?: string;
  ms?: number;
  model?: string;
  error?: string;
}

export const api = {
  me: () => call<{ ok: boolean }>("GET", "/api/me"),
  login: (password: string) => call<{ ok: boolean }>("POST", "/api/login", { password }),
  /** first start: whether the password is chosen yet, and choosing it (opens a session) */
  setupState: () => call<{ password_set: boolean }>("GET", "/api/setup"),
  setPassword: (password: string) => call<{ ok: boolean }>("POST", "/api/setup", { password }),
  /** a backup file (src/backup.ts) put back; the service restarts afterwards */
  restoreBackup: async (file: File): Promise<RestoreResult> => {
    const res = await fetch("/api/restore", { method: "POST", headers: { "Content-Type": "application/gzip" }, body: file });
    const data = (await res.json().catch(() => ({}))) as RestoreResult & { errors?: string[] };
    if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED));
    if (res.status !== 200) throw new ApiError(res.status, data.errors ?? []);
    return data;
  },
  logout: () => call("POST", "/api/logout"),
  config: () => call<Config>("GET", "/api/config"),
  preview: (config: Config) => call<{ ok: boolean; errors: string[]; frigate?: string[]; frigateDown?: boolean }>("POST", "/api/config/preview", { config }),
  save: (config: Config, base_version: number) => call<{ ok: true; version: number }>("PUT", "/api/config", { config, base_version }),
  history: () => call<HistoryItem[]>("GET", "/api/config/history"),
  historyFile: (file: string) => call<Config>("GET", `/api/config/history/${encodeURIComponent(file)}`),
  restore: (file: string) => call<{ ok: true; version: number }>("POST", "/api/config/restore", { file }),
  events: (limit = 300) => call<PerceptionEvent[]>("GET", `/api/events?limit=${limit}`),
  testRule: (rule: Rule) => call<{ total: number; hits: PerceptionEvent[] }>("POST", "/api/rules/test", { rule }),
  status: () => call<Status>("GET", "/api/status"),
  streams: () => call<{ name: string; camera: string | null }[]>("GET", "/api/streams"),
  tryActivity: (camera: string, activity: Activity) => call<{ result: TryResult }>("POST", `/api/cameras/${camera}/try`, { activity }),
  usage: (refresh = false) => call<Usage>("GET", `/api/usage${refresh ? "?refresh=1" : ""}`),
  mcpClients: () => call<McpClient[]>("GET", "/api/mcp/clients"),
  /** the people of the face library */
  people: () => call<PersonInfo[]>("GET", "/api/people"),
  /** "to name": Frigate's recent attempts by passage; `all` includes the ones already recognized */
  unknown: (all = false) => call<AttemptGroup[]>("GET", `/api/people/unknown${all ? "?all=1" : ""}`),
  assignAttempts: (files: string[], to: string) => call<{ ok: true; id: string }>("POST", "/api/people/unknown/assign", { files, to }),
  discardAttempts: (files: string[]) => call<{ ok: true }>("POST", "/api/people/unknown/discard", { files }),
  createPerson: (name: string) => call<{ ok: true; id: string }>("POST", "/api/people", { name }),
  renamePerson: (id: string, name: string) => call<{ ok: true; id: string }>("PUT", `/api/people/${encodeURIComponent(id)}`, { name }),
  deletePerson: (id: string) => call<{ ok: true }>("DELETE", `/api/people/${encodeURIComponent(id)}`),
  mergePerson: (id: string, into: string) => call<{ ok: true; moved: number }>("POST", `/api/people/${encodeURIComponent(id)}/merge`, { into }),
  deleteFace: (id: string, file: string) => call<{ ok: true }>("DELETE", `/api/people/${encodeURIComponent(id)}/faces/${encodeURIComponent(file)}`),
  moveFace: (id: string, file: string, to: string) => call<{ ok: true }>("POST", `/api/people/${encodeURIComponent(id)}/faces/${encodeURIComponent(file)}/move`, { to }),
  /** a photo of the person: Frigate finds the face and keeps the crop */
  uploadFace: async (id: string, photo: File) => {
    const form = new FormData();
    form.set("file", photo, photo.name);
    const res = await fetch(`/api/people/${encodeURIComponent(id)}/faces`, { method: "POST", body: form });
    const data = (await res.json().catch(() => ({}))) as { errors?: string[] };
    if (!res.ok) throw new ApiError(res.status, data.errors ?? []);
  },
  /** Percezione's go2rtc: status, sources with a password, and (sharing on) login and addresses */
  restream: () => call<Restream>("GET", "/api/restream"),
  /** a source's password: kept by the service, never sent back */
  sourcePassword: (id: string, password: string) => call<{ ok: true }>("PUT", `/api/sources/${id}/password`, { password }),
  /** a frame from an address not saved yet (the add-camera wizard) */
  probeSource: async (url: string, password: string) => {
    const res = await fetch("/api/sources/probe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, password }) });
    if (!res.ok) throw new ApiError(res.status, ((await res.json().catch(() => ({}))) as { errors?: string[] }).errors ?? []);
    return res.blob();
  },
  importSources: (url: string, user: string, password: string) => call<{ ok: true; added: string[]; version: number }>("POST", "/api/sources/import", { url, user, password }),
  /** who is in view now */
  presence: () => call<Presence>("GET", "/api/presence"),
  /** the token comes back only here, once */
  mcpCreate: (name: string, role: McpClient["role"]) => call<{ client: McpClient; token: string }>("POST", "/api/mcp/clients", { name, role }),
  mcpRevoke: (id: string) => call("DELETE", `/api/mcp/clients/${id}`),
  outputs: () => call<OutputStatus[]>("GET", "/api/outputs"),
  /** a new secret; it comes back only here, once */
  webhookSecret: (name: string) => call<{ secret: string }>("POST", `/api/outputs/webhooks/${name}/secret`),
  webhookTest: (name: string) => call<{ ok: boolean; errors: string[] }>("POST", `/api/outputs/webhooks/${name}/test`),
  analyzers: (refresh = false) => call<AnalyzerStatus[]>("GET", `/api/analyzers${refresh ? "?refresh=1" : ""}`),
  /** model.onnx + model.yml onto a runner; the service forwards the upload as it is */
  uploadModel: async (endpoint: string, name: string, onnx: File, manifest: File) => {
    const form = new FormData();
    form.set("model", onnx, "model.onnx");
    form.set("manifest", manifest, "model.yml");
    const res = await fetch(`/api/analyzers/${endpoint}/models/${encodeURIComponent(name)}`, { method: "PUT", body: form });
    const data = (await res.json().catch(() => ({}))) as { errors?: string[] };
    if (!res.ok) throw new ApiError(res.status, data.errors ?? []);
    return data;
  },
};

/** Messages from the service (events, new versions, outcomes towards Frigate), with reconnection. */
export function subscribe(onMessage: (m: Broadcast) => void): () => void {
  let ws: WebSocket | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const open = () => {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`);
    ws.onmessage = (e) => onMessage(JSON.parse(e.data as string) as Broadcast);
    ws.onclose = () => {
      if (!stopped) timer = setTimeout(open, 3_000);
    };
  };
  open();
  return () => {
    stopped = true;
    clearTimeout(timer);
    ws?.close();
  };
}
