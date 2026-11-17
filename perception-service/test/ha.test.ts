import assert from "node:assert/strict";
import { test } from "node:test";
import { HaView, placeStates, slug, type Presence } from "../src/ha.ts";
import { validate, type Config } from "../src/settings.ts";

function config(): Config {
  const v = validate({
    version: 1,
    cameras: {
      living_room: { place: "living_room", kind: "indoor", observe: { presence: {} } },
      attic: { place: "Attic é", kind: "indoor", observe: { presence: {} } },
      front_right: { place: "outdoor", kind: "outdoor", observe: { passages: { group: "street" } } },
    },
    analyzers: { vlm: { model: "m", vocabulary: { other: "…" }, attributes: {} } },
    rules: [{ id: "night_entrance", name: "n", when: { event: "approach" }, then: [{ react: "ha" }] }],
  });
  assert.ok(v.ok, v.ok ? "" : v.errors.join("\n"));
  return v.config;
}

class FakeMqtt {
  connected = true;
  sent: { topic: string; payload: string; retain?: boolean }[] = [];
  publish(topic: string, payload: string, opts: { retain?: boolean }) {
    this.sent.push({ topic, payload, retain: opts.retain });
  }
  topics() {
    return this.sent.map((m) => m.topic);
  }
  last(topic: string) {
    return [...this.sent].reverse().find((m) => m.topic === topic)?.payload;
  }
}

test("who is in each indoor place, recognized or not / chi c'è in ogni luogo interno, riconosciuto o no", () => {
  const p: Presence = {
    present: [
      { name: "Bob", camera: "living_room", activity: "cooking", posture: "standing" },
      { name: "Alice", camera: "living_room" },
      { name: "Dave", camera: "front_right" },
    ],
    unnamed: new Map([["attic", 2]]),
  };
  const s = placeStates(config(), p);
  assert.deepEqual([...s.keys()], ["living_room", "Attic é"]);
  assert.deepEqual(s.get("living_room"), {
    state: "Alice, Bob",
    people: ["Alice", "Bob"],
    // what each one is doing, for automations and Assist
    persons: [
      { name: "Alice", camera: "living_room", activity: null, posture: null },
      { name: "Bob", camera: "living_room", activity: "cooking", posture: "standing" },
    ],
    unrecognized: 0,
    occupied: true,
  });
  assert.deepEqual(s.get("Attic é"), { state: "2 unrecognized", people: [], persons: [], unrecognized: 2, occupied: true });
  assert.equal(slug("Attic é"), "attic_e");
  assert.equal(placeStates(config(), { present: [], unnamed: new Map() }).get("living_room")!.state, "nobody");
});

test("an indoor camera that does not observe presence has no entities: nobody could ever be seen there / una camera interna che non osserva la presenza non ha entità: lì nessuno potrebbe mai essere visto", () => {
  const cfg = config();
  delete cfg.cameras.attic!.observe.presence;
  assert.deepEqual([...placeStates(cfg, { present: [], unnamed: new Map() }).keys()], ["living_room"]);
  // one that stopped observing presence while Percezione was off: removed on connection
  const mqtt = new FakeMqtt();
  new HaView(mqtt, { config: () => cfg, presence: () => ({ present: [], unnamed: new Map() }) }).connected();
  assert.equal(mqtt.last("homeassistant/sensor/perception/who_attic_e/config"), "");
  assert.ok(JSON.parse(mqtt.last("homeassistant/sensor/perception/who_living_room/config")!));
});

test("discovery, retained states only on change, removal when HA is off / discovery, stati retained solo quando cambiano, rimozione con HA spento", () => {
  const cfg = config();
  const mqtt = new FakeMqtt();
  let presence: Presence = { present: [{ name: "Alice", camera: "living_room" }], unnamed: new Map() };
  const view = new HaView(mqtt, { config: () => cfg, presence: () => presence });
  view.connected();
  for (const t of [
    "homeassistant/sensor/perception/who_living_room/config",
    "homeassistant/binary_sensor/perception/occupied_living_room/config",
    "homeassistant/sensor/perception/who_attic_e/config",
    "homeassistant/event/perception/rule/config",
  ]) assert.ok(mqtt.topics().includes(t), t);
  assert.deepEqual(JSON.parse(mqtt.last("homeassistant/event/perception/rule/config")!).event_types, ["night_entrance"]);
  assert.equal(JSON.parse(mqtt.last("perception/presence/living_room")!).state, "Alice");
  assert.ok(mqtt.sent.filter((m) => m.topic.startsWith("perception/presence/")).every((m) => m.retain));

  const n = mqtt.sent.length;
  view.refresh();
  assert.equal(mqtt.sent.length, n, "nothing changed, nothing sent");
  presence = { present: [], unnamed: new Map([["living_room", 1]]) };
  view.refresh();
  assert.deepEqual(mqtt.topics().slice(n), ["perception/presence/living_room"]);
  assert.equal(JSON.parse(mqtt.last("perception/presence/living_room")!).state, "1 unrecognized");

  cfg.outputs.homeassistant.enabled = false;
  view.refresh();
  for (const t of ["homeassistant/sensor/perception/who_living_room/config", "homeassistant/event/perception/rule/config", "homeassistant/sensor/perception/last_event/config"]) {
    assert.equal(mqtt.last(t), "", t);
  }
  const m = mqtt.sent.length;
  view.refresh();
  assert.equal(mqtt.sent.length, m, "removed once");
});

test("external photos: off by default; on, one entity per kind with its last picture and who was there; off again, all go / foto degli eventi esterni: spente di default; accese, un'entità per tipo con l'ultima foto e chi c'era; rispente, spariscono tutte", async () => {
  const cfg = config();
  const mqtt = new FakeMqtt();
  const pictures: string[] = [];
  const event = (kind: string, id: string, label?: string) => ({
    event_id: id,
    ts: "2026-11-13T09:46:16.511Z",
    type: "external",
    camera: "front_door",
    place: "entrance",
    text: `${kind} at entrance: Alice`,
    image: `${id}-1.jpg`,
    people: [{ name: "Alice" }, { name: "Bob", seen_by: "yard" }],
    unrecognized: 1,
    value: { to: kind },
    ...(label ? { external: { label } } : {}),
  });
  // the timeline already has a call: its entity comes with the switch
  const view = new HaView(mqtt as never, {
    config: () => cfg,
    presence: () => ({ present: [], unnamed: new Map() }),
    picture: async (f) => (pictures.push(f), Buffer.from(`jpeg ${f}`)),
    externals: () => [event("call", "c0")],
  });
  view.connected();
  // off: the entities of an earlier run are removed, nothing is published on an event
  assert.equal(mqtt.last("homeassistant/image/perception/last_call/config"), "");
  await view.external(event("gate_open", "g1"));
  assert.deepEqual(pictures, []);

  cfg.outputs.homeassistant.external_photos = true;
  view.refresh();
  await new Promise((r) => setImmediate(r));
  assert.equal(JSON.parse(mqtt.last("homeassistant/image/perception/last_call/config")!).name, "Last call");
  assert.equal(String(mqtt.last("perception/external_last/call/image")), "jpeg c0-1.jpg");

  await view.external(event("gate_open", "g1", "Gate"));
  const disc = JSON.parse(mqtt.last("homeassistant/image/perception/last_gate_open/config")!);
  assert.deepEqual([disc.name, disc.image_topic, disc.json_attributes_topic], ["Last gate open", "perception/external_last/gate_open/image", "perception/external_last/gate_open"]);
  const attrs = JSON.parse(mqtt.last("perception/external_last/gate_open")!);
  assert.deepEqual([attrs.kind, attrs.label, attrs.people, attrs.seen_on_the_way, attrs.unrecognized], ["gate_open", "Gate", ["Alice"], ["Bob"], 1]);
  // a new gate event does not touch the call's picture
  assert.equal(String(mqtt.last("perception/external_last/call/image")), "jpeg c0-1.jpg");
  assert.ok(mqtt.sent.filter((m) => m.topic.startsWith("perception/external_last/")).every((m) => m.retain));

  cfg.outputs.homeassistant.external_photos = false;
  view.refresh();
  for (const k of ["call", "gate_open"])
    for (const t of [`homeassistant/image/perception/last_${k}/config`, `perception/external_last/${k}`, `perception/external_last/${k}/image`]) assert.equal(mqtt.last(t), "", t);
});
