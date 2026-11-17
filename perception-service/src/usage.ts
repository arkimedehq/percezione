import { execFile } from "node:child_process";
import { readdir, stat, statfs } from "node:fs/promises";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * Disk and resource usage for the Usage page: what takes space (Frigate media, our data, model weights) and
 * what takes CPU and memory (Frigate, the analyzers, our processes). Everything is read on demand; folder sizes
 * are cached because walking the media folders is the slow part.
 */

export interface FolderUsage {
  group: string;
  name: string;
  path: string;
  bytes: number;
  files: number;
}

export interface ProcessUsage {
  name: string;
  /** resident memory, bytes (sum over the matching processes) */
  rss: number;
  cpu: number;
  count: number;
}

export interface Usage {
  ts: string;
  disk: { total: number; free: number; used: number };
  folders: FolderUsage[];
  host: { memTotal: number; memFree: number; load: number[]; cpus: number };
  processes: ProcessUsage[];
  frigate: {
    cpu: number | null;
    mem: number | null;
    detector: { name: string; inferenceMs: number; cpu: number } | null;
    faceRecognitionMs: number | null;
    shm: { used: number; total: number } | null;
    cameras: { name: string; fps: number; detectionFps: number; stallsLastHour: number; reconnectsLastHour: number; quality: string | null }[];
  } | null;
}

export interface UsageDeps {
  frigateUrl: string;
  root: string;
  dataDir: string;
  storageDir: string;
}

const run = promisify(execFile);

/** Folders worth knowing about, grouped as on the page. Missing ones are skipped. */
function folderList(d: UsageDeps): Omit<FolderUsage, "bytes" | "files">[] {
  const clips = join(d.storageDir, "clips");
  return [
    { group: "Frigate", name: "Recordings", path: join(d.storageDir, "recordings") },
    { group: "Frigate", name: "Event snapshots", path: clips },
    { group: "Frigate", name: "Previews", path: join(clips, "previews") },
    { group: "Frigate", name: "Review items", path: join(clips, "review") },
    { group: "Frigate", name: "Thumbnails", path: join(clips, "thumbs") },
    { group: "Frigate", name: "Face library", path: join(clips, "faces") },
    { group: "Frigate", name: "Exports", path: join(d.storageDir, "exports") },
    { group: "Percezione", name: "Event timeline", path: join(d.dataDir, "timeline.jsonl") },
    { group: "Percezione", name: "Activity and posture samples", path: join(d.dataDir, "samples.jsonl") },
    { group: "Percezione", name: "Configuration history", path: join(d.dataDir, "config-history") },
    { group: "Percezione", name: "Left object photos", path: join(d.dataDir, "left-objects") },
    { group: "Models", name: "Analyzer weights", path: join(d.root, "analyzers", "models") },
  ];
}

/** Size of a file, or of a folder walked recursively. `shallow` counts only the files directly inside. */
async function sizeOf(path: string, shallow = false): Promise<{ bytes: number; files: number } | null> {
  const s = await stat(path).catch(() => null);
  if (!s) return null;
  if (!s.isDirectory()) return { bytes: s.size, files: 1 };
  let bytes = 0;
  let files = 0;
  for (const e of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const p = join(path, e.name);
    if (e.isDirectory()) {
      if (shallow) continue;
      const sub = await sizeOf(p);
      if (sub) {
        bytes += sub.bytes;
        files += sub.files;
      }
    } else if (e.isFile()) {
      bytes += (await stat(p).catch(() => null))?.size ?? 0;
      files++;
    }
  }
  return { bytes, files };
}

/** Our processes and the heavy neighbours, matched on the command line from `ps`. */
const PROCESS_PATTERNS: [string, RegExp][] = [
  ["Percezione (service)", /src\/index\.ts/],
  ["ONNX analyzers", /uvicorn app:app/],
  ["Ollama (VLM)", /ollama (serve|runner)/],
  ["Docker (Frigate)", /com\.apple\.Virtualization\.VirtualMachine|qemu-system/],
];

export function parsePs(out: string): ProcessUsage[] {
  const acc = new Map<string, ProcessUsage>();
  for (const line of out.split("\n").slice(1)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/);
    if (!m) continue;
    const [, , rssKb, cpu, command] = m;
    const hit = PROCESS_PATTERNS.find(([, re]) => re.test(command!));
    if (!hit) continue;
    const p = acc.get(hit[0]) ?? { name: hit[0], rss: 0, cpu: 0, count: 0 };
    p.rss += Number(rssKb) * 1024;
    p.cpu += Number(cpu);
    p.count++;
    acc.set(hit[0], p);
  }
  return PROCESS_PATTERNS.flatMap(([name]) => (acc.has(name) ? [acc.get(name)!] : []));
}

/**
 * Memory that can be handed out without swapping. On macOS `os.freemem()` is only the truly free pages (near
 * zero most of the time, the rest is file cache), so free + inactive + speculative + purgeable from `vm_stat`.
 */
export function availableFromVmStat(out: string): number | null {
  const page = Number(out.match(/page size of (\d+) bytes/)?.[1] ?? 0);
  if (!page) return null;
  const pages = (key: string) => Number(out.match(new RegExp(`Pages ${key}:\\s+(\\d+)`))?.[1] ?? 0);
  return (pages("free") + pages("inactive") + pages("speculative") + pages("purgeable")) * page;
}

interface FrigateStats {
  cpu_usages?: Record<string, { cpu?: string; mem?: string }>;
  detectors?: Record<string, { inference_speed?: number; cpu?: string }>;
  embeddings?: { face_recognition_speed?: number };
  service?: { storage?: Record<string, { total?: number; used?: number }> };
  cameras?: Record<
    string,
    { camera_fps?: number; detection_fps?: number; stalls_last_hour?: number; reconnects_last_hour?: number; connection_quality?: string }
  >;
}

export function frigateUsage(s: FrigateStats): NonNullable<Usage["frigate"]> {
  const sys = s.cpu_usages?.["frigate.full_system"];
  const [detName, det] = Object.entries(s.detectors ?? {})[0] ?? [];
  const shm = s.service?.storage?.["/dev/shm"];
  return {
    cpu: sys?.cpu != null ? Number(sys.cpu) : null,
    mem: sys?.mem != null ? Number(sys.mem) : null,
    detector: detName && det ? { name: detName, inferenceMs: det.inference_speed ?? 0, cpu: Number(det.cpu ?? 0) } : null,
    faceRecognitionMs: s.embeddings?.face_recognition_speed ?? null,
    // Frigate reports MB
    shm: shm?.total ? { used: (shm.used ?? 0) * 1024 * 1024, total: shm.total * 1024 * 1024 } : null,
    cameras: Object.entries(s.cameras ?? {}).map(([name, c]) => ({
      name,
      fps: c.camera_fps ?? 0,
      detectionFps: c.detection_fps ?? 0,
      stallsLastHour: c.stalls_last_hour ?? 0,
      reconnectsLastHour: c.reconnects_last_hour ?? 0,
      quality: c.connection_quality ?? null,
    })),
  };
}

export class UsageCollector {
  private folders?: { at: number; list: FolderUsage[] };

  constructor(
    private readonly d: UsageDeps,
    private readonly folderTtlMs = 5 * 60_000,
  ) {}

  async collect(refresh = false): Promise<Usage> {
    const [disk, folders, processes, frigate, available] = await Promise.all([
      statfs(this.d.root).then((s) => ({ total: s.blocks * s.bsize, free: s.bavail * s.bsize, used: (s.blocks - s.bfree) * s.bsize })),
      this.folderSizes(refresh),
      run("ps", ["-axo", "pid,rss,%cpu,command"], { maxBuffer: 8 * 1024 * 1024 }).then((r) => parsePs(r.stdout), () => []),
      fetch(`${this.d.frigateUrl}/api/stats`, { signal: AbortSignal.timeout(5_000) })
        .then((r) => r.json() as Promise<FrigateStats>)
        .then(frigateUsage, () => null),
      process.platform === "darwin" ? run("vm_stat").then((r) => availableFromVmStat(r.stdout), () => null) : Promise.resolve(null),
    ]);
    return {
      ts: new Date().toISOString(),
      disk,
      folders,
      host: { memTotal: totalmem(), memFree: available ?? freemem(), load: loadavg(), cpus: cpus().length },
      processes,
      frigate,
    };
  }

  private async folderSizes(refresh: boolean): Promise<FolderUsage[]> {
    if (!refresh && this.folders && Date.now() - this.folders.at < this.folderTtlMs) return this.folders.list;
    const list: FolderUsage[] = [];
    for (const f of folderList(this.d)) {
      // event photos sit directly in clips/, next to the other folders listed separately
      const s = await sizeOf(f.path, f.name === "Event snapshots");
      if (s) list.push({ ...f, ...s });
    }
    this.folders = { at: Date.now(), list };
    return list;
  }
}
