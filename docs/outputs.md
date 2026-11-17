# Outputs

*[Italiano](outputs.it.md)*

Where events go besides the history (`data/timeline.jsonl`). They are managed from the **Outputs** page of the
frontend; the state of each one is also in `GET /api/outputs`.

| Output | What it receives | Code / document |
|---|---|---|
| **MQTT** | every event on `perception/events` (schema v3), always | `src/outputs.ts` |
| **Home Assistant** | the view: who is in each room, occupancy, rule events, last event, photos of external events | `src/ha.ts`, `src/publish.ts` |
| **Webhook** | the events of the rules with the `webhook` reaction towards that name, signed | `src/webhooks.ts` |
| Arkimede | memory, announcements, notifications, presence: from the plugin, not from here | [arkimede-plugin.md](arkimede-plugin.md) |
| Agents | questions (`/mcp`) and live events (`/events`) | [mcp.md](mcp.md), [live-events.md](live-events.md) |

## Outbox: no event lost
Each destination (MQTT, each webhook) has its own queue on disk in `data/outbox/`:
- the event is first written to `<output>.jsonl`, then sent; `<output>.pos` remembers the last one delivered, so a
  restart resumes from there;
- events are sent in order. If the destination is down, the send is retried after 5 s, then 10, 20… up to 5 minutes,
  without skipping anything; when the MQTT broker reconnects, it is retried at once;
- a destination that is down does not block the others;
- a 4xx answer from a webhook (except 408 and 429) means "I will never take it": that event is dropped and the queue
  moves on, with the error on the Outputs page;
- an event not delivered within 7 days is dropped;
- delivery is "at least once": after a crash a duplicate may arrive, recognizable by its `event_id`.

## Home Assistant
Entities are created automatically via MQTT discovery, in the "Percezione" device. They are turned off with
`outputs.homeassistant.enabled` (Outputs page, "Home Assistant enabled"): when off, the entities disappear from HA;
`perception/events` stays.
- For each place of the indoor cameras that observe presence (an indoor camera without the "presence" observation
  creates no entity: nobody would ever be seen there):
  - `sensor.perception_who_<place>` "Who is in <place>": the names, "2 unrecognized" or "nobody"; as attributes
    `people`, `unrecognized`, `occupied` and `persons`, that is each recognized person with `camera`, `activity`
    (the current activity, `null` until it is stable) and `posture` (with the posture model). Example:
    `{{ state_attr('sensor.perception_who_kitchen', 'persons') | selectattr('name', 'eq', 'Alice') | map(attribute='activity') | first }}`;
  - `binary_sensor.perception_occupied_<place>` "<place> occupied" (occupancy): someone in view, recognized or not.
  State on `perception/presence/<place>` (retained), updated on every event and every 5 seconds.
- `event.perception_rule` "Percezione rule": one event each time a rule with the `ha` reaction fires. `event_type` is
  the rule id; as attributes `event_id`, `type`, `camera`, `place`, `person`, `text`, `importance`, `ts`. It goes
  through the MQTT outbox. Example automation:
  ```yaml
  # the state of an event entity is the time of the last event: it always changes, even when the rule is the same
  triggers:
    - trigger: state
      entity_id: event.perception_rule
      not_from: unavailable
  conditions:
    - condition: state
      entity_id: event.perception_rule
      attribute: event_type
      state: night_entrance
  actions:
    - action: notify.mobile_app_phone
      data:
        message: "{{ state_attr('event.perception_rule', 'text') }}"
  ```
- `sensor.perception_last_event` "Last event", for a dashboard card: the state is the sentence of the last event, the
  `events` attribute the last events (`perception/recent`, retained).
- `image.perception_last_<kind>` "Last <kind>", **only when turned on** from the Outputs page ("Photos of external
  events", `outputs.homeassistant.external_photos`, off by default: they are photos of people). One entity for each
  kind of [external event](external-events.md) received (`ring` → "Last ring", `call` → "Last call", `gate_open` →
  "Last gate open"), created at the first event of that kind; when turned on, those of the kinds already in the
  history appear at once, with their last photo. It shows the best photo of the last event of that kind, scaled down
  to 1280 px; as attributes `event_id`, `time`, `kind`, `label`, `camera`, `place`, `text`, `people` (who was in front
  of the camera), `seen_on_the_way` (seen by the other cameras of the group) and `unrecognized`. Photo on
  `perception/external_last/<kind>/image`, attributes on `perception/external_last/<kind>`, retained. When turned off,
  the entities and the photos are removed from the broker. Example notification with the photo, for the `ring` kind:
  ```yaml
  triggers:
    - trigger: state
      entity_id: image.perception_last_ring
      not_from: unavailable
  actions:
    - action: notify.mobile_app_phone
      data:
        message: "{{ state_attr('image.perception_last_ring', 'text') }}"
        data:
          image: "/api/image_proxy/image.perception_last_ring"
  ```

**Double counting:** with the Arkimede plugin installed, the "Who is in" and "occupied" entities **must not be exposed
to Assist**. Arkimede already gets presence from the plugin and would count the same people twice.

## Webhooks
In `outputs.webhooks`, by name: `{ "url": "https://…", "enabled": true }`. A rule uses them with
`{ "react": "webhook", "to": "<name>" }`.

Each POST carries the v3 event ([events.md](events.md)) as JSON body, and:
```
X-Percezione-Event: <event_id>
X-Percezione-Timestamp: <Unix seconds>
X-Percezione-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<body>" with the secret>
```
The **secret** is created by Percezione, one per webhook, and shown only once on the Outputs page ("Show the secret"
or "New secret", which invalidates the old one). It is kept in `data/webhook-secrets.json` (mode 600), never in
`config.json` or in the logs. Removing a webhook also removes its queue and its secret.

Verification on the receiving side (Node):
```js
import { createHmac, timingSafeEqual } from "node:crypto";
function verify(secret, headers, rawBody) {
  const ts = Number(headers["x-percezione-timestamp"]);
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false; // old: maybe replayed
  const want = "sha256=" + createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  const got = String(headers["x-percezione-signature"] ?? "");
  return got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
```
A delivery delayed by the outbox carries the timestamp of the send, not of the event: the 5-minute window holds even
after a long outage. The time of the event is `ts` in the body.

"Send a test" sends at once, outside the queue, a signed `{"type": "test"}` event.
