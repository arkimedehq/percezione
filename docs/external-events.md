# External events

*[Italiano](external-events.it.md)*

A device tells Percezione that something happened in front of a camera: someone rang the doorbell, a call came in, a
gate opened. Percezione records it as one of its own events, with a picture of the moment and who is there. From there
it follows the paths of every event: history, rules and reactions, `/events`, MQTT, the Arkimede plugin.

Percezione does not know the kinds in advance: `kind` is free (lowercase letters, digits and `_`, up to 40
characters). The interface translates the known ones (`ring` → doorbell, `call` → call); it shows the others as they
are. An external event never opens or controls anything: it records it and says who is there.

## Request

MQTT on `perception/external`, or `POST /external` with a **Device** token (Agents page; an Agent token gets 403),
or `POST /api/external` from the interface:

```json
{ "kind": "ring", "camera": "front_door", "id": "ring-1731440000", "source": "doorbell", "label": "Doorbell" }
```

- `kind` and `camera` are required; the camera must be a Percezione camera, or the id of a group (the event goes on
  its main camera).
- If the camera is the main camera of a group ([people.md](people.md), camera groups), the answers are the group's:
  the names seen by the other cameras along the way have `seen_by` and do not count among the people in front of the
  main camera.
- `id` belongs to the caller and comes back in every answer; `source` and `label` are optional (`label` gives the name
  in the sentence).
- `source` and `label` are short names: letters, digits, spaces and `. , ' ( ) _ -`, at most 60 characters. Otherwise
  the request is refused: 422 over HTTP, an answer with `error` over MQTT. The label goes into the event's text, which
  an agent reads: only a name, never free text.

## Answers

On `perception/external/result` (over HTTP only the event comes back, at the end of the look):

```json
{ "id": "ring-1731440000", "event_id": "…", "kind": "ring", "final": false,
  "camera": "front_door", "place": "entrance", "time": "…",
  "people": [], "unrecognized": 1, "unknown_faces": [ … ] }
```

- The first answer comes at once, with whoever Frigate is tracking at that moment (like `who_is_at`).
- Percezione keeps looking for `after_s` seconds ("Look after", 4 by default, set per camera; a group uses those of
  its main camera): as soon as it finds a new name it sends another answer, and it stops earlier if everyone in view
  has a name. Then it looks for each person's best face, from `before_s` seconds before the request ("Look before",
  10 by default), and sends the answer with `"final": true`: it has the same people as the event, including those
  Frigate recognized but no longer reports in view.
- `people` are all the names seen since the start. A caller waiting for a name can stop at the first answer that has
  one.
- In the final answer each person also has `face`, the crop of the face, and, with "Short memory" on for their
  camera, `photo`, the whole frame (the same files as the event); `unknown_people` has the pictures of those in front
  of the camera without a name. A panel can show at once who was there (`GET /external/<file>`).
- A wrong request gets `{ "id": …, "error": "…" }`.

## The event

At the end of the look, a single v3 event of type `external` ([events.md](events.md)):

- `value.to` is the kind (`ring`): rules filter it with `value`, like the object of `object_left`;
- `person` is the first one recognized, `people` all of them, `unrecognized` how many others were in view without a
  name;
- with a group: in `people` first those in front of the main camera, then those seen by the other cameras
  (`seen_by`); `cameras` lists the cameras of the group;
- `external` = `{ request_id, source?, label? }`;
- each person has `face`, their best face seen by Frigate (also in the `before_s` seconds before the request), and,
  with the short memory on for their camera, `photo`, the whole frame of that instant ([people.md](people.md));
  `unknown_people` has the same pictures for those on the main camera without a name;
- `image` is the picture of the first person; with no faces, the one of the moment. The pictures are in
  `data/external/`, kept for **30 days**, and are read with `GET /external/<file>`;
- the text: `Doorbell at entrance: Alice and an unknown person`, or, with a group,
  `Doorbell at entrance: Alice (seen by yard) and an unknown person` (the interface translates it).

## List and pictures (for a panel)

With a client token:

- `GET /external?kind=ring&limit=20`: the latest external events, most recent first;
- `GET /external/<image>`: the picture.

A **Device** token gets all the pictures. An **Agent** token can read too, but it gets the pictures (`image`, `photo`
and `face` of `people` and `unknown_people`) only if every camera of the event is enabled in Agents → Camera images (for
a group: all its cameras). Otherwise the event comes without them, and `GET /external/<file>` answers 404
([mcp.md](mcp.md)).

From the interface, the same on `/api/external`. This is useful, for example, for a wall panel that shows the latest
events of a kind with their picture. Two ready-made prompts to build such a client are in
[client-prompts.md](client-prompts.md).
