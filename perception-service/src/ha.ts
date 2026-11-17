import type { Config } from "./settings.ts";

/**
 * Home Assistant as a view (docs/outputs.md), by MQTT discovery:
 * - for each place of the indoor cameras that observe presence, "Who is in <place>" (sensor: the names, or "nobody";
 *   each person's current activity and posture as attributes) and "<place> occupied" (binary_sensor, occupancy:
 *   anyone in view, recognized or not), from `perception/presence/<slug>` (retained);
 * - "Percezione rule" (event entity): one HA event per rule with the `ha` reaction, `event_type` = the rule id, so
 *   an automation triggers on the rule rather than on the event type. Sent through the outbox (src/outputs.ts).
 * - "Last <kind>" (image entities, with `outputs.homeassistant.external_photos`): one per kind of external event
 *   (docs/external-events.md; the kind is free: ring, call, gate…), the picture of the last one of that kind (S8d) with
 *   who was there as attributes; HA shows it and attaches it to notifications, no token needed.
 * States are retained and republished on every connection; discovery of places or rules that are gone is removed.
 * With `outputs.homeassistant.enabled` off everything here is removed from HA.
 */
export const HA_TOPIC = {
  presence: (slug: string) => `perception/presence/${slug}`,
  rule: "perception/rule",
  status: "perception/status",
  external: (kind: string) => `perception/external_last/${kind}`,
  externalImage: (kind: string) => `perception/external_last/${kind}/image`,
};

// the "Last event" sensor of src/publish.ts: removed with the rest when HA is off
const LAST_EVENT_DISCOVERY = "homeassistant/sensor/perception/last_event/config";
const RULE_DISCOVERY = "homeassistant/event/perception/rule/config";
const externalTopic = (kind: string) => `homeassistant/image/perception/last_${kind}/config`;
const whoTopic = (s: string) => `homeassistant/sensor/perception/who_${s}/config`;
const occupiedTopic = (s: string) => `homeassistant/binary_sensor/perception/occupied_${s}/config`;

/** Discovery topics of the Italian names used until 2026-11-11: emptied once, so HA drops those entities. */
const legacyTopics = (places: string[]) => [
  "homeassistant/sensor/perception/ultimo_evento/config",
  "homeassistant/event/perception/regola/config",
  ...places.flatMap((s) => [`homeassistant/sensor/perception/chi_${s}/config`, `homeassistant/binary_sensor/perception/occupato_${s}/config`]),
];

export const DEVICE = { identifiers: ["perception-service"], name: "Percezione", manufacturer: "Percezione" };

export interface Presence {
  /** activity and posture: the current ones, null while not known (yet) */
  present: { name: string; camera: string; activity?: string | null; posture?: string | null }[];
  /** live tracks without a name, per camera */
  unnamed: Map<string, number>;
}

export interface PlaceState {
  state: string;
  people: string[];
  /** each recognized person, with what they are doing */
  persons: { name: string; camera: string; activity: string | null; posture: string | null }[];
  unrecognized: number;
  occupied: boolean;
}

export interface MqttLike {
  connected: boolean;
  publish(topic: string, payload: string | Buffer, opts: { qos: 0 | 1; retain?: boolean }): unknown;
}

/** The part of an external event its entity shows (src/events.ts). */
export interface ExternalEvent {
  event_id: string;
  ts: string;
  type: string;
  camera: string;
  place: string;
  text: string;
  image?: string;
  people?: { name: string; seen_by?: string }[];
  unrecognized?: number;
  value?: { to: string | null } | null;
  external?: { label?: string };
}

/** "Kitchen and hall" → "kitchen_and_hall": safe in a topic and an entity id. */
export function slug(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/** The places of the indoor cameras that observe presence: only there someone can be seen; outdoor cameras are not rooms. */
export function presencePlaces(cfg: Config): string[] {
  return [...new Set(Object.values(cfg.cameras).filter((c) => c.kind === "indoor" && c.observe.presence).map((c) => c.place))];
}

/** Those places and who is in each. */
export function placeStates(cfg: Config, p: Presence): Map<string, PlaceState> {
  const out = new Map<string, { people: Map<string, PlaceState["persons"][number]>; unrecognized: number }>();
  for (const place of presencePlaces(cfg)) out.set(place, { people: new Map(), unrecognized: 0 });
  for (const x of p.present) {
    const place = cfg.cameras[x.camera]?.place;
    if (place !== undefined) out.get(place)?.people.set(x.name, { name: x.name, camera: x.camera, activity: x.activity ?? null, posture: x.posture ?? null });
  }
  for (const [camera, n] of p.unnamed) {
    const place = cfg.cameras[camera]?.place;
    const s = place !== undefined ? out.get(place) : undefined;
    if (s) s.unrecognized += n;
  }
  return new Map(
    [...out].map(([place, s]) => {
      const people = [...s.people.keys()].sort();
      const names = people.join(", ");
      const others = s.unrecognized ? `${s.unrecognized} unrecognized` : "";
      const persons = people.map((n) => s.people.get(n)!);
      return [place, { state: [names, others].filter(Boolean).join(" and ") || "nobody", people, persons, unrecognized: s.unrecognized, occupied: people.length + s.unrecognized > 0 }];
    }),
  );
}

/** Rules that send to HA: the event types of the event entity. */
export function haRules(cfg: Config): string[] {
  return cfg.rules.filter((r) => r.then.some((t) => t.react === "ha")).map((r) => r.id);
}

export class HaView {
  // photos null: not said yet since the connection, so entities left by an earlier run are announced or removed
  private announced: { places: Set<string>; rules: string; photos: boolean | null; kinds: Set<string> } = { places: new Set(), rules: "", photos: null, kinds: new Set() };
  private last = new Map<string, string>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly client: MqttLike,
    private readonly d: {
      config(): Config;
      presence(): Presence;
      /** a picture of the external events, light enough for the broker */
      picture?(file: string): Promise<Buffer | null>;
      /** the latest external event of each kind (from the timeline), for the entities after a restart */
      externals?(): ExternalEvent[];
    },
  ) {}

  get enabled(): boolean {
    return this.d.config().outputs.homeassistant.enabled;
  }

  /** Every `ms`: presence changes without events (someone unrecognized walks in). */
  start(ms = 5_000): void {
    this.timer = setInterval(() => this.refresh(), ms);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** On (re)connection: discovery and every state again (retained messages may have been lost by the broker). */
  connected(): void {
    this.announced = { places: new Set(), rules: "", photos: null, kinds: new Set() };
    this.last.clear();
    if (this.client.connected) {
      const places = Object.values(this.d.config().cameras).filter((c) => c.kind === "indoor").map((c) => slug(c.place));
      // every indoor place: also those that stopped observing presence while Percezione was off
      for (const s of places) if (!presencePlaces(this.d.config()).map(slug).includes(s)) this.removePlace(s);
      for (const t of legacyTopics(places)) this.client.publish(t, "", { qos: 1, retain: true });
    }
    this.refresh();
  }

  /** Discovery for the current places and rules, and the states that changed. */
  refresh(): void {
    if (!this.client.connected) return;
    const cfg = this.d.config();
    if (!cfg.outputs.homeassistant.enabled) return this.removeAll();
    this.cleared = false;
    const states = placeStates(cfg, this.d.presence());
    const places = new Set([...states.keys()].map(slug));
    for (const s of this.announced.places) if (!places.has(s)) this.removePlace(s);
    for (const [place, st] of states) {
      const s = slug(place);
      if (!this.announced.places.has(s)) this.announcePlace(place, s);
      const payload = JSON.stringify(st);
      if (this.last.get(s) !== payload) {
        this.client.publish(HA_TOPIC.presence(s), payload, { qos: 1, retain: true });
        this.last.set(s, payload);
      }
    }
    this.announced.places = places;
    const rules = haRules(cfg);
    if (rules.join(",") !== this.announced.rules) {
      this.announceRules(rules);
      this.announced.rules = rules.join(",");
    }
    const photos = cfg.outputs.homeassistant.external_photos;
    if (photos !== this.announced.photos) {
      this.announced.photos = photos;
      // on: an entity per kind already seen, with its last picture; off: all of them go, with their pictures
      if (photos) for (const e of this.d.externals?.() ?? []) void this.external(e);
      else this.removeExternals();
    }
  }

  /** An external event with a picture: the entity of its kind shows it, with who was there (retained). */
  async external(e: ExternalEvent): Promise<void> {
    const ha = this.d.config().outputs.homeassistant;
    const kind = e.type === "external" ? e.value?.to : null;
    if (!ha.enabled || !ha.external_photos || !kind || !e.image) return;
    const img = await this.d.picture?.(e.image).catch(() => null);
    if (!img || !this.client.connected) return;
    const k = slug(kind);
    if (!this.announced.kinds.has(k)) this.announceExternal(k, kind);
    const attributes = {
      event_id: e.event_id,
      time: e.ts,
      kind,
      ...(e.external?.label ? { label: e.external.label } : {}),
      camera: e.camera,
      place: e.place,
      text: e.text,
      // who was in front of the camera; seen on the way by another camera of its group: apart
      people: (e.people ?? []).filter((p) => !p.seen_by).map((p) => p.name),
      seen_on_the_way: (e.people ?? []).filter((p) => p.seen_by).map((p) => p.name),
      unrecognized: e.unrecognized ?? 0,
    };
    this.client.publish(HA_TOPIC.external(k), JSON.stringify(attributes), { qos: 1, retain: true });
    this.client.publish(HA_TOPIC.externalImage(k), img, { qos: 1, retain: true });
  }

  private announceExternal(k: string, kind: string): void {
    this.client.publish(
      externalTopic(k),
      JSON.stringify({
        name: `Last ${kind.replaceAll("_", " ")}`,
        unique_id: `perception_last_${k}`,
        object_id: `perception_last_${k}`,
        image_topic: HA_TOPIC.externalImage(k),
        content_type: "image/jpeg",
        json_attributes_topic: HA_TOPIC.external(k),
        availability_topic: HA_TOPIC.status,
        icon: "mdi:image-marker",
        device: DEVICE,
      }),
      { qos: 1, retain: true },
    );
    this.announced.kinds.add(k);
  }

  /** The external entities and their pictures: those announced now and those of an earlier run (the kinds seen). */
  private removeExternals(): void {
    const kinds = new Set([...this.announced.kinds, ...(this.d.externals?.() ?? []).flatMap((e) => (e.value?.to ? [slug(e.value.to)] : []))]);
    for (const k of kinds) for (const t of [externalTopic(k), HA_TOPIC.external(k), HA_TOPIC.externalImage(k)]) this.client.publish(t, "", { qos: 1, retain: true });
    this.announced.kinds.clear();
  }

  private announcePlace(place: string, s: string): void {
    const base = {
      state_topic: HA_TOPIC.presence(s),
      json_attributes_topic: HA_TOPIC.presence(s),
      availability_topic: HA_TOPIC.status,
      device: DEVICE,
    };
    this.client.publish(
      whoTopic(s),
      JSON.stringify({
        ...base,
        name: `Who is in ${place}`,
        unique_id: `perception_who_${s}`,
        object_id: `perception_who_${s}`,
        value_template: "{{ value_json.state[:255] }}",
        icon: "mdi:account-eye",
      }),
      { qos: 1, retain: true },
    );
    this.client.publish(
      occupiedTopic(s),
      JSON.stringify({
        ...base,
        name: `${place} occupied`,
        unique_id: `perception_occupied_${s}`,
        object_id: `perception_occupied_${s}`,
        device_class: "occupancy",
        value_template: "{{ 'ON' if value_json.occupied else 'OFF' }}",
      }),
      { qos: 1, retain: true },
    );
  }

  private announceRules(rules: string[]): void {
    if (!rules.length) return void this.client.publish(RULE_DISCOVERY, "", { qos: 1, retain: true });
    this.client.publish(
      RULE_DISCOVERY,
      JSON.stringify({
        name: "Percezione rule",
        unique_id: "perception_rule",
        object_id: "perception_rule",
        state_topic: HA_TOPIC.rule,
        availability_topic: HA_TOPIC.status,
        event_types: rules,
        icon: "mdi:cctv",
        device: DEVICE,
      }),
      { qos: 1, retain: true },
    );
  }

  private removePlace(s: string): void {
    for (const t of [whoTopic(s), occupiedTopic(s), HA_TOPIC.presence(s)]) {
      this.client.publish(t, "", { qos: 1, retain: true });
    }
    this.last.delete(s);
  }

  /** Off: removes our entities from HA once, also those announced by an earlier run (the current places). */
  private removeAll(): void {
    if (this.cleared) return;
    const cfg = this.d.config();
    const places = new Set([...this.announced.places, ...Object.values(cfg.cameras).filter((c) => c.kind === "indoor").map((c) => slug(c.place))]);
    for (const s of places) this.removePlace(s);
    for (const t of [RULE_DISCOVERY, LAST_EVENT_DISCOVERY]) this.client.publish(t, "", { qos: 1, retain: true });
    this.removeExternals();
    this.announced = { places: new Set(), rules: "", photos: false, kinds: new Set() };
    this.cleared = true;
  }

  private cleared = false;
}
