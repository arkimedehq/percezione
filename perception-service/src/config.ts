import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readSecrets } from "./secrets.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const envPath = resolve(ROOT, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);
// the secrets made by the setup service (src/setup.ts); the environment wins over them
const SECRETS_DIR = resolve(ROOT, "data", "secrets");
const secrets = readSecrets(resolve(SECRETS_DIR, "system.json"));

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing environment variable: ${name}`);
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} is not a number: ${v}`);
  return n;
}

export const UNCERTAIN = "uncertain";
export const WALKING = "walking";

export type Attributes = Record<string, boolean>;

/** A rule: when every attribute in `if` has the given value, the activity is `then`. The first one wins. */
export interface ActivityRule {
  if: Attributes;
  then: string;
}

export interface CameraActivities {
  rules: ActivityRule[];
  default: string;
}

/** Activities seed (`config/activities.json`): used only to create `data/config.json` the first time. */
export interface ActivitiesSeed {
  vocabulary: Record<string, string>;
  /** yes/no questions asked to the VLM: name → description */
  attributes: Record<string, string>;
  /** the rules a new camera starts with, by kind */
  rules: Record<"indoor" | "outdoor", CameraActivities>;
}

export const ACTIVITIES_SEED = resolve(import.meta.dirname, "..", "config", "activities.json");

export function loadActivitiesSeed(path = ACTIVITIES_SEED): ActivitiesSeed {
  return JSON.parse(readFileSync(path, "utf8")) as ActivitiesSeed;
}

/** Questions used by a camera's rules: only these are asked to the VLM. */
export function cameraAttributes(catalog: Record<string, string>, c: CameraActivities | undefined): Record<string, string> {
  const used = new Set(c?.rules.flatMap((r) => Object.keys(r.if)) ?? []);
  return Object.fromEntries(Object.entries(catalog).filter(([name]) => used.has(name)));
}

/** First matching rule, otherwise the camera's default. */
export function applyRules(attrs: Attributes, c: CameraActivities): string {
  const rule = c.rules.find((r) => Object.entries(r.if).every(([k, v]) => attrs[k] === v));
  return rule?.then ?? c.default;
}

export const config = {
  mqtt: {
    url: `mqtt://${str("MQTT_HOST", "localhost")}:${num("MQTT_PORT", 1883)}`,
    // a broker without login is allowed (e.g. a local one for tests)
    username: process.env.MQTT_USER_PERCEPTION || secrets?.mqtt?.percezione?.user,
    password: process.env.MQTT_PASS_PERCEPTION || secrets?.mqtt?.percezione?.password,
  },
  frigateUrl: str("FRIGATE_URL", "http://localhost:5001"),
  // go2rtc streams of the cameras (stream: { go2rtc: "name" } → <url>/name), e.g. rtsp://192.0.2.134:8554
  go2rtcRtspUrl: process.env.GO2RTC_RTSP_URL || undefined,
  // go2rtc API (the wall panel host): stream list and live video for the frontend, always behind the service's proxy
  // where Percezione writes go2rtc.yaml: the folder mounted as its /config (docker-compose.yml)
  go2rtcConfigDir: resolve(ROOT, str("GO2RTC_CONFIG_DIR", "data/go2rtc")),
  go2rtc: {
    apiUrl: process.env.GO2RTC_API_URL || undefined,
    user: process.env.GO2RTC_USER || secrets?.go2rtc?.user,
    password: process.env.GO2RTC_PASSWORD || secrets?.go2rtc?.password,
    // from the environment go2rtc reads its login itself (${GO2RTC_USER}); from the secrets it goes in go2rtc.yaml
    loginInFile: !process.env.GO2RTC_USER && !!secrets?.go2rtc,
  },
  // configuration frontend (src/http.ts): LAN only, behind a password
  ui: {
    port: num("UI_PORT", 8090),
    host: str("UI_HOST", "0.0.0.0"),
    password: process.env.UI_PASSWORD || undefined,
    distDir: resolve(ROOT, "frontend", "dist"),
    /** Frigate's UI behind the same login (0: off) */
    frigatePort: num("FRIGATE_PROXY_PORT", 8091),
    /** names of your own domain that point here, besides addresses and local names (src/host.ts) */
    hosts: (process.env.PERCEZIONE_HOSTS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  },
  ollamaUrl: str("OLLAMA_URL", "http://localhost:11434"),
  dataDir: resolve(ROOT, "data"),
  // short memory of the cameras (src/buffer.ts): a RAM folder (tmpfs in deploy/docker-compose.yml)
  bufferDir: str("BUFFER_DIR", resolve(tmpdir(), "percezione-buffer")),
  secretsDir: SECRETS_DIR,
  // Frigate's /config (deploy/docker-compose.yml): the setup service writes config.yml there once
  frigateConfigDir: resolve(ROOT, str("FRIGATE_CONFIG_DIR", "frigate/config")),
  hardware: str("PERCEZIONE_HARDWARE", "cpu"),
  coralDevice: str("CORAL_DEVICE", "usb"),
  yoloImgSize: num("YOLO_IMG_SIZE", 320),
  configPath: resolve(ROOT, str("CONFIG_PATH", "data/config.json")),
};
