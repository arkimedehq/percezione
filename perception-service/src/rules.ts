import type { Observation } from "./events.ts";
import { IMPORTANCE, type Importance, type Reaction, type Rule } from "./settings.ts";

/** A reaction decided for an event: the rule's, plus the rules that asked for it. */
export type AppliedReaction = Reaction & { rules: string[] };

type Subject = Observation & { place: string };

/**
 * The "when → then" rule engine (docs/events.md).
 * Every active rule is evaluated, not just the first; equal reactions (same kind, same recipient) merge: `urgent`
 * and `snapshot` when either asks, the highest importance.
 * The event's importance is the highest among its reactions (`urgent` counts as high); with no rules it is normal.
 */
export function evaluateRules(e: Subject, rules: Rule[], now: Date): { reactions: AppliedReaction[]; importance: Importance } {
  const merged = new Map<string, AppliedReaction>();
  for (const rule of rules) {
    if (!rule.enabled || !matches(rule.when, e, now)) continue;
    for (const r of rule.then) {
      const key = `${r.react}:${"to" in r ? (r.to ?? "") : ""}`;
      const prev = merged.get(key);
      merged.set(key, prev ? merge(prev, r, rule.id) : { ...r, rules: [rule.id] });
    }
  }
  const reactions = [...merged.values()];
  const levels = reactions.map((r) => ("urgent" in r && r.urgent ? "high" : (r.importance ?? "normal")));
  return { reactions, importance: levels.length ? maxImportance(levels) : "normal" };
}

export function matches(w: Rule["when"], e: Subject, now: Date): boolean {
  if (w.event !== undefined && ![w.event].flat().includes(e.type)) return false;
  if (w.cameras && !w.cameras.some((c) => c === e.camera || e.cameras?.includes(c))) return false;
  if (w.places && !w.places.includes(e.place)) return false;
  if (w.person !== undefined && ![w.person].flat().some((p) => names(e).some((n) => personMatches(p, n)))) return false;
  if (w.value !== undefined) {
    const v = e.type === "left" ? e.activity : e.value?.to;
    if (v == null || ![w.value].flat().includes(v)) return false;
  }
  if (w.zone !== undefined && e.zone !== w.zone) return false;
  if (w.hours !== undefined && !inHours(w.hours, now)) return false;
  if (w.for_s !== undefined && (e.duration_s === undefined || e.duration_s < w.for_s)) return false;
  return true;
}

/** Who an event is about: its person, or (external) everyone recognized plus null for those without a name. */
function names(e: Subject): (string | null)[] {
  if (!e.people) return [e.person?.name ?? null];
  const out: (string | null)[] = e.people.map((p) => p.name);
  if (e.unrecognized || !out.length) out.push(null);
  return out;
}

function personMatches(filter: string, name: string | null): boolean {
  switch (filter) {
    case "anyone":
      return true;
    case "unknown":
      return name === null;
    case "known":
      return name !== null;
    default:
      return name !== null && name.toLowerCase() === filter.toLowerCase();
  }
}

/** "23:00-06:00" in local time; the end is excluded. */
export function inHours(range: string, now: Date): boolean {
  const [from, to] = range.split("-").map((hm) => {
    const [h, m] = hm.split(":").map(Number);
    return h! * 60 + m!;
  }) as [number, number];
  const t = now.getHours() * 60 + now.getMinutes();
  return from <= to ? t >= from && t < to : t >= from || t < to;
}

function merge(a: AppliedReaction, b: Reaction, ruleId: string): AppliedReaction {
  const out = { ...a, rules: [...a.rules, ruleId] } as AppliedReaction & { urgent?: boolean; snapshot?: boolean };
  if ("urgent" in b && b.urgent) out.urgent = true;
  if ("snapshot" in b && b.snapshot) out.snapshot = true;
  // an unspecified importance counts as "normal", as it does for a reaction alone: otherwise the result would
  // depend on the order of the rules ("low" + unspecified gave "low" one way and "normal" the other)
  if (a.importance || b.importance) out.importance = maxImportance([a.importance ?? "normal", b.importance ?? "normal"]);
  return out;
}

function maxImportance(levels: Importance[]): Importance {
  return IMPORTANCE[Math.max(...levels.map((l) => IMPORTANCE.indexOf(l)))]!;
}
