import { UNCERTAIN } from "./config.ts";

export interface Sample {
  label: string;
  conf: number;
  ts: number; // ms
}

export interface ActivityParams {
  stableMs: number;
  minConf: number;
  minSamples: number;
  enterRatio: number;
}

export interface Transition {
  from: string | null;
  to: string;
  /** ts of the first agreeing sample in the window: measures the detection delay */
  firstSampleTs: number;
}

/**
 * Windowed debounce with hysteresis.
 * Window = valid samples (not uncertain, conf >= minConf) of the last stableMs.
 * An activity is entered when it has at least enterRatio of the votes with at least minSamples samples;
 * the current activity stays until another one reaches the same share, so a third of the votes
 * is enough to stay in it (hysteresis).
 */
export class ActivityStateMachine {
  private samples: Sample[] = [];
  current: string | null = null;

  constructor(private readonly p: ActivityParams) {}

  /** `stableMs` overrides the one in the params: the window is per camera and changes live. */
  push(s: Sample, stableMs = this.p.stableMs): Transition | null {
    if (s.label !== UNCERTAIN && s.conf >= this.p.minConf) this.samples.push(s);
    this.samples = this.samples.filter((x) => x.ts > s.ts - stableMs);
    if (this.samples.length < this.p.minSamples) return null;

    const counts = new Map<string, number>();
    for (const x of this.samples) counts.set(x.label, (counts.get(x.label) ?? 0) + 1);
    const [best, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;

    if (best === this.current || n / this.samples.length < this.p.enterRatio) return null;
    const t: Transition = {
      from: this.current,
      to: best,
      firstSampleTs: this.samples.find((x) => x.label === best)!.ts,
    };
    this.current = best;
    return t;
  }

  reset(): void {
    this.samples = [];
    this.current = null;
  }
}
