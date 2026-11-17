import type { events as en } from "../en/events.ts";

export const events: typeof en = {
  type: {
    arrived: "arrivo",
    left: "uscita",
    activity_changed: "cambio attività",
    posture_changed: "cambio postura",
    passage: "passaggio",
    approach: "avvicinamento",
    object_left: "oggetto lasciato",
    external: "evento esterno",
  },
  label: {
    // the activities of the starting vocabulary (perception-service/config/activities.json)
    at_computer: "al computer",
    on_phone_call: "al telefono",
    using_phone: "usa il telefono",
    eating: "mangia",
    cooking: "cucina",
    reading: "legge",
    watching_tv: "guarda la TV",
    playing: "gioca",
    sleeping: "dorme",
    resting: "riposa",
    at_car: "all'auto",
    electronics: "elettronica",
    other: "altro",
    standing: "in piedi",
    sitting: "seduto",
    lying: "sdraiato",
    on_floor: "a terra",
    uncertain: "incerto",
    walking: "cammina",
    trash: "rifiuti",
    parcel: "pacco",
    bulky: "ingombrante",
    ring: "campanello",
    call: "chiamata",
  },
  importance: { low: "bassa", normal: "normale", high: "alta" },
  reaction: { notify: "notifica", memory: "memoria", ha: "Home Assistant", webhook: "webhook", announce: "annuncio a voce" },
  person: { anyone: "chiunque", unknown: "sconosciuto", known: "riconosciuto" },
  kind: { indoor: "interno", outdoor: "esterno" },
  place: { outdoor: "esterno" },
  observation: {
    presence: "presenza",
    activity: "attività",
    passages: "passaggi",
    approach: "avvicinamento",
    posture: "postura",
    left_object: "oggetti lasciati",
  },
  unknownPerson: "Sconosciuto",
  and: " e ",
  sentence: {
    arrived: (who, place) => `${who}: arrivo in ${place}`,
    left: (who, place) => `${who}: uscita da ${place}`,
    changed: (who, place, to) => `${who} in ${place}: ${to}`,
    approach: (who) => `${who}: all'ingresso`,
    passage: (who, cameras, seconds, approached) => `${who}: passaggio (${cameras}, ${seconds} s${approached ? ", si è avvicinato" : ""})`,
    objectLeft: (zone, object, by, someone) =>
      `Oggetto lasciato in ${zone}: ${object}${by ? `, dopo il passaggio di ${by}` : someone ? ", dopo il passaggio di uno sconosciuto" : ""}`,
    seenBy: (name, camera) => `${name} (visto da ${camera})`,
    external: (what, place, names, unknown) =>
      `${what} in ${place}: ${
        [...names, ...(unknown ? [unknown === 1 ? "uno sconosciuto" : `${unknown} sconosciuti`] : [])].join(", ").replace(/, ([^,]*)$/, " e $1") ||
        "nessuno inquadrato"
      }`,
  },
};
