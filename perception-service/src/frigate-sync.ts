import { describeOp, parseRaw, planImport, planPush, sameFaces, type Op, type RawConfig } from "./frigate-config.ts";
import type { Config, ConfigStore } from "./settings.ts";

export interface SyncLog {
  info(msg: string): void;
  error(msg: string): void;
}

/**
 * Keeps Frigate's cameras and face recognition settings aligned with `data/config.json`, live (`PUT /api/config/set`):
 * - on every new version it sends only the changed sections, one at a time; if Frigate rejects one, the cameras
 *   go back to the previous version (and the sections already sent go back as they were);
 * - a version that changes no camera (rules, sources, outputs…) is not Frigate's business: nothing is sent;
 * - with Frigate unreachable a version is not rejected: it is sent when Frigate is back, before any import (an
 *   import first would take Frigate's older cameras back);
 * - every `importEveryMs` it brings the changes made in Frigate's UI back into the configuration, and turns detection
 *   back on where Frigate has it off.
 * One operation at a time: the import skips a round while a push is in progress.
 */
/** Frigate did not answer (down, restarting): unlike a rejection, the change is kept and sent later. */
class FrigateDown extends Error {}

const sameFrigate = (a: Config, b: Config) => JSON.stringify(a.cameras) === JSON.stringify(b.cameras) && sameFaces(a.faces, b.faces);

export class FrigateSync {
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  /** version created to go back after a rejection: if that fails too, we stop */
  private revertVersion?: number;
  /** the configuration Frigate still has, while changes wait for Frigate to answer */
  private behind?: Config;
  private lastImportError = "";
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(
    private readonly frigateUrl: string,
    private readonly store: ConfigStore,
    private readonly go2rtcBase?: string,
    private readonly log: SyncLog = { info: console.log, error: console.error },
  ) {}

  /** To be called on every config change. */
  onChange(next: Config, prev: Config): Promise<void> {
    this.pending++;
    const run = () => this.push(prev, next).finally(() => this.pending--);
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  /** `importEveryMs` is read before every wait: a change applies from the next round. */
  start(importEveryMs: () => number): Promise<void> {
    const next = () => {
      if (this.stopped) return;
      this.timer = setTimeout(() => void this.importChanges().finally(next), importEveryMs());
      this.timer.unref?.();
    };
    return this.importChanges().finally(next);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** Resolves when the changes sent so far are done (e.g. before a restart). */
  idle(): Promise<void> {
    return this.queue;
  }

  /** Changes are waiting for Frigate to come back. */
  get waiting(): boolean {
    return this.behind !== undefined;
  }

  async fetchRaw(): Promise<RawConfig> {
    const res = await reach(`${this.frigateUrl}/api/config/raw`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Frigate /api/config/raw ${res.status}`);
    return parseRaw(await res.text());
  }

  async importChanges(): Promise<void> {
    if (this.pending > 0) return;
    if (this.behind) {
      // Frigate is behind: catch it up first, never import its older cameras
      await this.onChange(this.store.current, this.behind);
      if (this.behind) return;
    }
    try {
      const raw = await this.fetchRaw();
      // detection off in Frigate (its default, e.g. a camera added in its UI) is turned back on without waiting for a change
      for (const op of planPush(this.store.current, this.store.current, raw, this.go2rtcBase).ops) {
        await this.send(op);
        this.log.info(`Frigate ← ${describeOp(op)} (detection was off)`);
      }
      const { next, changes } = planImport(this.store.current, raw, this.go2rtcBase);
      if (this.pending > 0 || changes.length === 0) return;
      const r = this.store.save(next);
      if (r.ok) {
        this.lastImportError = "";
        this.log.info(`from Frigate: ${changes.join(", ")} → configuration v${this.store.current.version}`);
      } else this.reportImportError(`Frigate changes not imported (${changes.join(", ")}):\n  ${r.errors.join("\n  ")}`);
    } catch (err) {
      this.reportImportError(`import from Frigate failed: ${(err as Error).message}`);
    }
  }

  private reportImportError(msg: string): void {
    // every round would retry with the same outcome: log it only once
    if (msg !== this.lastImportError) this.log.error(msg);
    this.lastImportError = msg;
  }

  private async push(changedFrom: Config, next: Config): Promise<void> {
    const isRevert = next.version === this.revertVersion;
    // with changes still waiting, the difference is from what Frigate really has
    const prev = this.behind ?? changedFrom;
    if (sameFrigate(prev, next)) {
      this.behind = undefined;
      return;
    }
    let done = 0;
    try {
      const { ops, errors } = planPush(prev, next, await this.fetchRaw(), this.go2rtcBase);
      if (errors.length) throw new Error(errors.join("; "));
      for (const op of ops) {
        await this.send(op);
        done++;
        this.log.info(`Frigate ← ${describeOp(op)}`);
      }
      if (this.behind) this.log.info(`Frigate caught up with v${next.version}`);
      this.behind = undefined;
    } catch (err) {
      if (err instanceof FrigateDown && done === 0) {
        if (!this.behind) this.log.error(`Frigate unreachable: v${next.version} will be sent when it is back (${err.message})`);
        this.behind = prev;
        return;
      }
      this.behind = undefined;
      this.log.error(`Frigate: v${next.version} not applied: ${(err as Error).message}`);
      if (isRevert) {
        this.log.error("going back to the previous version failed too: Frigate and the configuration may differ");
        return;
      }
      // a new version with the previous cameras (the rest stays as it is: Frigate does not care); pushing it
      // (from the store listener) restores the sections already applied
      const r = this.store.save({ ...this.store.current, cameras: prev.cameras, faces: prev.faces });
      if (r.ok) {
        this.revertVersion = this.store.current.version;
        this.log.info(`configuration brought back to the content of v${prev.version} (now v${this.revertVersion}, ${done} sections to undo)`);
      }
    } finally {
      if (isRevert) this.revertVersion = undefined;
    }
  }

  private async send(op: Op): Promise<void> {
    const body =
      op.kind === "faces"
        ? { requires_restart: 0, update_topic: "config/face_recognition", config_data: { face_recognition: op.data } }
        : op.kind === "section"
        ? { requires_restart: 0, update_topic: `config/cameras/${op.camera}/${op.section}`, config_data: { cameras: { [op.camera]: op.data } } }
        : op.kind === "add"
          ? { requires_restart: 0, update_topic: `config/cameras/${op.camera}/add`, config_data: { cameras: { [op.camera]: op.data } } }
          : { requires_restart: 0, update_topic: `config/cameras/${op.camera}/remove`, config_data: { cameras: { [op.camera]: null } } };
    const res = await reach(`${this.frigateUrl}/api/config/set`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const r = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
    if (res.ok && r.success) return;
    let msg = `${describeOp(op)}: ${r.message ?? `HTTP ${res.status}`}`;
    // a new {FRIGATE_*} variable in .env is seen by Frigate only after recreating the container
    if (/parsing config/i.test(msg) && JSON.stringify(op).includes("{FRIGATE_")) msg += " (new credentials in .env? `docker compose up -d`)";
    throw new Error(msg);
  }
}

/** fetch, with "no answer" (connection refused, timeout) told apart from an answer that says no. */
async function reach(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw new FrigateDown((err as Error).message);
  }
}
