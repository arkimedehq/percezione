# Events — schema v3

*[Italiano](events.it.md)*

Everything is in English: fields, values and `text`. The UI translates from the fields into the chosen language.

One schema for every output: the history (`data/timeline.jsonl`), MQTT `perception/events`, webhooks, the `/events`
stream, MCP.

## Fields

| Field | Type | Notes |
|---|---|---|
| `event_id` | string | UUID; receivers deduplicate with it |
| `schema_version` | `3` | |
| `ts` | string | ISO 8601 UTC |
| `type` | string | see below |
| `camera` | string | the camera that saw it |
| `cameras` | string[] | `passage`: every camera of the group |
| `place` | string | the camera's place |
| `person` | object \| null | `{ name, confidence, source }`, `source` = `face` or `inherited`; null if not recognized |
| `value` | object | `{ from, to }`: `activity_changed`, `posture_changed`; `object_left` and `external` (`from` null; `to` is the object or the kind, e.g. `ring`) |
| `people` | object[] | `external`: everyone recognized, like `person` (which is the first) |
| `unrecognized` | number | `external`: how many others were in view without a name |
| `external` | object | `external`: `{ request_id, source?, label? }` from the device's request |
| `image` | string | `external`: the picture of the moment, kept by the service (`/api/external/<image>`) |
| `activity` | string \| null | `left`: the last activity |
| `zone` | string | `approach`: the entrance zone; `object_left`: the watched zone |
| `duration_s` | number | `passage` |
| `approached` | boolean | `passage`: entered the entrance zone |
| `object` | object | `object_left`: `{ score, rise, box, passersby, images: { before, after } }` |
| `latency_ms` | number | from the frame to the emission |
| `media` | object | `{ frigate_ids }`: snapshots and clips in Frigate |
| `text` | string | a ready-made sentence in English |
| `reactions` | object[] | the rules' reactions: `{ react, to?, snapshot?, urgent?, importance?, rules }` |
| `importance` | string | `low`, `normal`, `high` |

## Types

| `type` | When |
|---|---|
| `arrived` | a recognized person shows up after an absence |
| `left` | not seen for a minute (Tuning → Absence before "left") |
| `activity_changed` | the activity changed and is stable |
| `posture_changed` | the posture changed (`standing`, `sitting`, `lying`, `on_floor`) |
| `passage` | someone walked past the outdoor cameras |
| `approach` | someone entered the entrance zone |
| `object_left` | an object was left in the zone (`trash`, `parcel`, `bulky`) |
| `external` | a device said something happened at a camera (the doorbell, a call): see [external-events.md](external-events.md) |

## Reactions

`notify`, `memory`, `ha`, `webhook`, `announce`. In rules, the person filter takes a name or `anyone`, `unknown`,
`known`. In an `external` event it applies to whoever was in view: `unknown` if at least one had no name (or nobody
was there), a name if it was among the recognized.

## Earlier versions

Schema v2 had Italian field names. A v2 history is converted once at startup, and the old file stays as
`timeline.jsonl.before-v3`. Likewise a `config.json` with Italian names is rewritten once, and the old one stays as
`config.json.before-english`. Versions saved in `config-history/` are read too.
