/** What the service sends in English, as the interface shows it: event types, built-in labels, sentences. */
export const events = {
  type: {
    arrived: "arrival",
    left: "departure",
    activity_changed: "activity change",
    posture_changed: "posture change",
    passage: "passage",
    approach: "approach",
    object_left: "object left",
    external: "external event",
  },
  /** labels made by the service; the activities of the vocabulary are the user's own and are shown as they are */
  label: {
    standing: "standing",
    sitting: "sitting",
    lying: "lying",
    on_floor: "on the floor",
    uncertain: "uncertain",
    walking: "walking",
    trash: "trash",
    parcel: "parcel",
    bulky: "bulky item",
    ring: "doorbell",
    call: "call",
  } as Record<string, string>,
  importance: { low: "low", normal: "normal", high: "high" },
  reaction: { notify: "notification", memory: "memory", ha: "Home Assistant", webhook: "webhook", announce: "voice announcement" },
  person: { anyone: "anyone", unknown: "unknown", known: "recognized" },
  kind: { indoor: "indoor", outdoor: "outdoor" },
  place: { outdoor: "outdoor" } as Record<string, string>,
  observation: {
    presence: "presence",
    activity: "activity",
    passages: "passages",
    approach: "approach",
    posture: "posture",
    left_object: "left objects",
  },
  unknownPerson: "Unknown person",
  and: " and ",
  sentence: {
    arrived: (who: string, place: string) => `${who} arrived in ${place}`,
    left: (who: string, place: string) => `${who} left ${place}`,
    changed: (who: string, place: string, to: string) => `${who} in ${place}: ${to}`,
    approach: (who: string) => `${who} at the entrance`,
    passage: (who: string, cameras: string, seconds: number, approached: boolean) =>
      `${who} passed by (${cameras}, ${seconds} s${approached ? ", came close" : ""})`,
    objectLeft: (zone: string, object: string, by: string | null, someone: boolean) =>
      `Object left in ${zone}: ${object}${by ? `, after ${by} passed by` : someone ? ", after an unknown person passed by" : ""}`,
    seenBy: (name: string, camera: string) => `${name} (seen by ${camera})`,
    external: (what: string, place: string, names: string[], unknown: number) =>
      `${what} at ${place}: ${
        [...names, ...(unknown ? [unknown === 1 ? "an unknown person" : `${unknown} unknown people`] : [])].join(", ").replace(/, ([^,]*)$/, " and $1") ||
        "nobody in view"
      }`,
  },
};
