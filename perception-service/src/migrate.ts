import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * From the Italian names of the first versions to English (decided 2026-11-11): the configuration (any version,
 * also the saved history) and the timeline's schema v2 events. Both functions are idempotent: English input comes
 * back unchanged.
 */

const OBSERVE: Record<string, string> = {
  presenza: "presence",
  attivita: "activity",
  passaggi: "passages",
  avvicinamento: "approach",
  postura: "posture",
  abbandono: "left_object",
};
const KIND: Record<string, string> = { interno: "indoor", esterno: "outdoor" };
const EVENT: Record<string, string> = { postura_changed: "posture_changed", passaggio: "passage", avvicinamento: "approach", abbandono: "object_left" };
const REACT: Record<string, string> = { notifica: "notify", memoria: "memory", annuncio: "announce" };
const IMPORTANCE: Record<string, string> = { bassa: "low", normale: "normal", alta: "high" };
const PERSON: Record<string, string> = { chiunque: "anyone", sconosciuto: "unknown", riconosciuto: "known" };
/** labels made by the service itself (postures, objects, the two built-in activities); the user's own stay */
const LABEL: Record<string, string> = {
  in_piedi: "standing",
  seduto: "sitting",
  sdraiato: "lying",
  a_terra: "on_floor",
  rifiuti: "trash",
  pacco: "parcel",
  ingombrante: "bulky",
  incerto: "uncertain",
  cammina: "walking",
};

const map = (m: Record<string, string>, v: unknown) => (typeof v === "string" ? (m[v] ?? v) : v);
const mapList = (m: Record<string, string>, v: unknown) => (Array.isArray(v) ? v.map((x) => map(m, x)) : map(m, v));
const renameKeys = (o: Record<string, unknown>, m: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [m[k] ?? k, v]));

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** A configuration with the Italian keys and values of v1/v2 → English. Anything else passes through. */
export function migrateConfig(input: unknown): unknown {
  if (!isObj(input)) return input;
  const cfg: Obj = { ...input };
  if (isObj(cfg.cameras)) {
    cfg.cameras = Object.fromEntries(
      Object.entries(cfg.cameras).map(([name, cam]) => {
        if (!isObj(cam)) return [name, cam];
        const c: Obj = { ...cam, kind: map(KIND, cam.kind) };
        if (c.place === "esterno") c.place = "outdoor";
        if (isObj(c.observe)) {
          const o = renameKeys(c.observe, OBSERVE);
          if (isObj(o.activity)) {
            const a = { ...o.activity };
            a.default = map(LABEL, a.default);
            if (Array.isArray(a.rules)) a.rules = a.rules.map((r) => (isObj(r) ? { ...r, then: map(LABEL, r.then) } : r));
            o.activity = a;
          }
          c.observe = o;
        }
        return [name, c];
      }),
    );
  }
  if (isObj(cfg.analyzers) && isObj(cfg.analyzers.vlm) && isObj(cfg.analyzers.vlm.vocabulary)) {
    cfg.analyzers = { ...cfg.analyzers, vlm: { ...cfg.analyzers.vlm, vocabulary: renameKeys(cfg.analyzers.vlm.vocabulary, LABEL) } };
  }
  if (Array.isArray(cfg.rules)) {
    cfg.rules = cfg.rules.map((rule) => {
      if (!isObj(rule)) return rule;
      const r: Obj = { ...rule };
      if (isObj(r.when)) {
        const { persona, ...w } = r.when;
        const when: Obj = { ...w };
        if (persona !== undefined) when.person = mapList(PERSON, persona);
        if (when.person !== undefined) when.person = mapList(PERSON, when.person);
        if (when.event !== undefined) when.event = mapList(EVENT, when.event);
        if (when.value !== undefined) when.value = mapList(LABEL, when.value);
        r.when = when;
      }
      if (Array.isArray(r.then)) {
        r.then = r.then.map((x) => (isObj(x) ? { ...x, react: map(REACT, x.react), ...(x.importance ? { importance: map(IMPORTANCE, x.importance) } : {}) } : x));
      }
      return r;
    });
  }
  return cfg;
}

/** A schema v2 event (Italian fields) → v3; `describe` writes the new `text`. v3 and anything else pass through. */
export function migrateEvent(input: unknown, describe: (e: Obj) => string): unknown {
  if (!isObj(input) || input.schema_version !== 2) return input;
  const { persona, valore, attivita, zona, durata_s, avvicinato, oggetto, testo: _testo, reazioni, importanza, type, ...rest } = input as Obj & {
    persona?: { nome: string; confidenza: number | null; fonte: string } | null;
    valore?: { da: string | null; a: string };
    oggetto?: { score: number; rise: number; box: number[]; passaggi: number; immagini: { prima: string; dopo: string } };
    reazioni?: Obj[];
  };
  const e: Obj = {
    ...rest,
    schema_version: 3,
    type: map(EVENT, type),
    person: persona ? { name: persona.nome, confidence: persona.confidenza, source: persona.fonte === "ereditato" ? "inherited" : "face" } : null,
  };
  if (valore) e.value = { from: map(LABEL, valore.da), to: map(LABEL, valore.a) };
  if (attivita !== undefined) e.activity = map(LABEL, attivita);
  if (zona !== undefined) e.zone = zona;
  if (durata_s !== undefined) e.duration_s = durata_s;
  if (avvicinato !== undefined) e.approached = avvicinato;
  if (oggetto) {
    e.object = { score: oggetto.score, rise: oggetto.rise, box: oggetto.box, passersby: oggetto.passaggi, images: { before: oggetto.immagini.prima, after: oggetto.immagini.dopo } };
  }
  e.reactions = (reazioni ?? []).map((r) => ({ ...r, react: map(REACT, r.react), ...(r.importance ? { importance: map(IMPORTANCE, r.importance) } : {}) }));
  e.importance = map(IMPORTANCE, importanza ?? "normale");
  if (e.place === "esterno") e.place = "outdoor";
  e.text = describe(e);
  return e;
}

/**
 * Rewrites a JSONL timeline whose schema v2 events become v3, once: the old file stays as `<file>.before-v3`.
 * Returns how many events were converted.
 */
export function migrateTimeline(path: string, describe: (e: Obj) => string): number {
  if (!existsSync(path)) return 0;
  const raw = readFileSync(path, "utf8");
  if (!raw.includes('"schema_version":2')) return 0;
  let n = 0;
  const out = raw
    .split("\n")
    .map((line) => {
      if (!line.includes('"schema_version":2')) return line;
      try {
        const e = migrateEvent(JSON.parse(line), describe);
        n++;
        return JSON.stringify(e);
      } catch {
        return line;
      }
    })
    .join("\n");
  if (!existsSync(`${path}.before-v3`)) copyFileSync(path, `${path}.before-v3`);
  writeFileSync(`${path}.tmp`, out);
  renameSync(`${path}.tmp`, path);
  return n;
}
