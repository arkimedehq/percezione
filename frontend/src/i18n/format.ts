import type { PerceptionEvent } from "../api.ts";
import type { Locale, Messages } from "./index.tsx";

/** A name for display: underscores become spaces. */
export const humanize = (s: string) => s.replaceAll("_", " ");

/** A label in the current language: a built-in one is translated, one of the user's vocabulary is shown as it is. */
export function label(t: Messages, value: string | null | undefined): string {
  if (!value) return t.common.none;
  return t.events.label[value] ?? humanize(value);
}

export function place(t: Messages, value: string): string {
  return t.events.place[value] ?? humanize(value);
}

/** The event's sentence in the current language, from its fields (the service's `text` is English). */
export function describeEvent(t: Messages, e: PerceptionEvent): string {
  const s = t.events.sentence;
  const who = e.person?.name ?? t.events.unknownPerson;
  const where = place(t, e.place);
  switch (e.type) {
    case "arrived":
      return s.arrived(who, where);
    case "left":
      return s.left(who, where);
    case "activity_changed":
    case "posture_changed":
      return s.changed(who, where, label(t, e.value?.to));
    case "approach":
      return s.approach(who);
    case "passage":
      return s.passage(who, (e.cameras ?? [e.camera]).map(humanize).join(t.events.and), e.duration_s ?? 0, !!e.approached);
    case "object_left":
      return s.objectLeft(humanize(e.zone ?? ""), label(t, e.value?.to), e.person?.name ?? null, !!e.object?.passersby);
    case "external":
      // the device's own name (e.g. "Doorbell") as given; otherwise the kind, translated when known
      return s.external(e.external?.label ?? label(t, e.value?.to), place(t, e.place), (e.people ?? []).map((p) => (p.seen_by ? s.seenBy(humanize(p.name), humanize(p.seen_by)) : humanize(p.name))), e.unrecognized ?? 0);
    default:
      return e.text;
  }
}

/** A decimal in the current language (0,82 in Italian). */
export function decimal(locale: Locale, n: number, digits = 2): string {
  return n.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function time(locale: Locale, ts: string | number | Date): string {
  return new Date(ts).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

export function dateTime(locale: Locale, ts: string | number | Date): string {
  return new Date(ts).toLocaleString(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
