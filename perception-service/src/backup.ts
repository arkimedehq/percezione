import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { NIGHT_PREFIX, type FrigateFaces } from "./people.ts";
import { writePrivate } from "./secrets.ts";
import type { Config, Validation } from "./settings.ts";

/**
 * Backup and restore (docs/backup.md): one gzipped JSON file with the configuration, the people with their faces,
 * the client tokens and webhook secrets, the UI password (its hash) and, only when asked, the cameras' passwords.
 * Not included: the event history, the pictures of events, the system secrets (a new installation makes its own).
 */
export const BACKUP_FORMAT = "percezione-backup";

/** Files of data/ that go in every backup. */
export const DATA_FILES = ["mcp-clients.json", "webhook-secrets.json", "secrets/ui.json", "people-imports.json"] as const;
/** Only with "with the cameras' passwords". */
export const SECRET_FILES = ["source-passwords.json"] as const;

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: 1;
  created: string;
  config: Config;
  /** data/ path → text */
  files: Record<string, string>;
  /** faces as Frigate lists them (night ones as `~ir/<file>`), base64 */
  people: { id: string; faces: { file: string; data: string }[] }[];
}

export interface BackupDeps {
  config: Config;
  dataDir: string;
  faces?: Pick<FrigateFaces, "list" | "image">;
}

export async function makeBackup(d: BackupDeps, withSecrets: boolean, now = new Date()): Promise<Buffer> {
  const files: Record<string, string> = {};
  for (const name of [...DATA_FILES, ...(withSecrets ? SECRET_FILES : [])]) {
    const path = resolve(d.dataDir, name);
    if (existsSync(path)) files[name] = readFileSync(path, "utf8");
  }
  const people: BackupFile["people"] = [];
  for (const p of (await d.faces?.list()) ?? []) {
    const faces: BackupFile["people"][number]["faces"] = [];
    for (const file of p.faces) {
      const res = await d.faces!.image(p.id, file);
      if (res.ok) faces.push({ file, data: Buffer.from(await res.arrayBuffer()).toString("base64") });
    }
    people.push({ id: p.id, faces });
  }
  const b: BackupFile = { format: BACKUP_FORMAT, version: 1, created: now.toISOString(), config: d.config, files, people };
  return gzipSync(JSON.stringify(b));
}

export function readBackup(gz: Buffer): BackupFile {
  let b: Partial<BackupFile>;
  try {
    // a crafted file could expand to gigabytes: a real backup is a few MB (faces included)
    b = JSON.parse(gunzipSync(gz, { maxOutputLength: 300_000_000 }).toString("utf8")) as Partial<BackupFile>;
  } catch {
    throw new Error("not a Percezione backup (a .json.gz file is expected)");
  }
  if (b.format !== BACKUP_FORMAT) throw new Error("not a Percezione backup");
  if (b.version !== 1) throw new Error(`backup version ${b.version} not supported`);
  return b as BackupFile;
}

export interface RestoreDeps {
  dataDir: string;
  save(config: unknown): Validation;
  faces?: Pick<FrigateFaces, "list" | "upload" | "create">;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A new Frigate answers "No face was detected" until it has downloaded its face models (~320 MB from GitHub) and
 * loaded them, a couple of minutes on a home connection. The first face waits up to 5.
 */
const WARMUP_TRIES = 60;
const WARMUP_MS = 5_000;

export interface RestoreResult {
  config_version?: number;
  files: string[];
  /** faces added per person; a person who already has faces is left as is */
  people: { id: string; added: number; kept?: true }[];
  errors: string[];
}

/**
 * Puts a backup back. The configuration becomes a new version (so it reaches Frigate and go2rtc like any change);
 * files are rewritten; faces go to people who have none. The caller restarts the service afterwards, because
 * tokens, secrets and passwords are read at start.
 */
export async function restoreBackup(b: BackupFile, d: RestoreDeps): Promise<RestoreResult> {
  const r: RestoreResult = { files: [], people: [], errors: [] };
  const allowed = new Set<string>([...DATA_FILES, ...SECRET_FILES]);
  for (const [name, text] of Object.entries(b.files ?? {})) {
    if (!allowed.has(name)) {
      r.errors.push(`${name}: not a file a backup restores`);
      continue;
    }
    writePrivate(resolve(d.dataDir, name), text);
    r.files.push(name);
  }
  const v = d.save(b.config);
  if (v.ok) r.config_version = v.config.version;
  else r.errors.push(...v.errors.map((e) => `configuration: ${e}`));
  if (!d.faces) return r;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const have = new Map((await d.faces.list()).map((p) => [p.id, p.faces.length]));
  // the first face waits for Frigate to be ready; after one has gone in, a refused face is a bad face, not a cold start
  let warm = false;
  for (const p of b.people ?? []) {
    if (have.get(p.id)) {
      r.people.push({ id: p.id, added: 0, kept: true });
      continue;
    }
    if (!have.has(p.id)) await d.faces.create(p.id).catch(() => undefined);
    let added = 0;
    for (const f of p.faces) {
      try {
        const name = f.file.split("/").pop()!;
        const type = { webp: "image/webp", png: "image/png" }[name.split(".").pop()!.toLowerCase()] ?? "image/jpeg";
        const upload = () => d.faces!.upload(p.id, new Blob([Buffer.from(f.data, "base64")], { type }), name, f.file.startsWith(NIGHT_PREFIX));
        for (let i = 1; ; i++) {
          try {
            await upload();
            break;
          } catch (err) {
            if (warm || i >= WARMUP_TRIES || !/no face/i.test((err as Error).message)) throw err;
            await sleep(WARMUP_MS);
          }
        }
        warm = true;
        added++;
      } catch (err) {
        r.errors.push(`${p.id}/${f.file}: ${(err as Error).message}`);
      }
    }
    r.people.push({ id: p.id, added });
  }
  return r;
}
