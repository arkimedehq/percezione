# Prompts for a panel and for Home Assistant

*[Italiano](client-prompts.it.md)*

Two prompts to paste into the session of whoever is developing a Percezione client: when a device reports an external
event in front of a camera, the client shows who was there, with the name and the photo of the best face. Photos only
go to the clients that ask for them.
References: [external-events.md](external-events.md) (external events), [people.md](people.md) (who is at a camera),
[outputs.md](outputs.md) (Home Assistant).

Replace in the prompts:
- `<kind>`, the kind of event, free: `ring` (a doorbell ring), `call`, `gate_open`…;
- `<camera>`, the camera it happens in front of, or the id of a camera group;
- `<host>`, Percezione's address.

The panel uses a token of type **Device** (Agents page): an Agent token cannot report events and does not always get
the photos.

## Panel

```text
Percezione (http://<host>:8090) records external events: a device says something happened in front of a camera, and
Percezione answers with who was there, with the name and the photo of each person's best face. Build the panel's
screen for the <kind> event on the <camera> camera:

1. The event starts like this: publish {"kind":"<kind>","camera":"<camera>","id":"<id>"} on perception/external
   (or POST /external with the panel's token, of type Device) and listen on perception/external/result.
2. The answers with "final": false come at once: show the names in "people" (anyone with "seen_by" was seen by
   another camera of the group along the way, and is not necessarily in front of the camera) and "unrecognized"
   people without a name.
3. The answer with "final": true comes a few seconds later: each person may have "face" (the crop of the face) and
   "photo" (the whole frame); "unknown_people" has the same files for those in front of the camera without a name.
   Download the images with GET http://<host>:8090/external/<file> and the header
   "Authorization: Bearer <panel token>". Show the face next to the name; a tap opens the whole photo.
4. "face" is missing when Frigate saw no face; "photo" also when the camera has no short memory: only the name is
   left, or "unknown person". Do not fail if a file answers 404.
5. Who is there now, on request: {"camera":"<camera>","id":"<id>","photos":true} on perception/who/request, answer on
   perception/who/result with the same fields as the final answer (faces of the last few seconds).
6. The latest events: GET /external?kind=<kind>&limit=20 with the same token; each event has "people" with "face" and
   "photo", "unknown_people" and "image" (the main photo).

Do not put the token in URLs and do not keep the photos beyond the screen: they stay on Percezione for 30 days.
```

## Home Assistant

```text
Percezione publishes on MQTT (the same broker as Home Assistant) the result of an external event, that is who was in
front of the camera. Build the automation for the <kind> event on the <camera> camera:

1. The automation that reports the event publishes {"kind":"<kind>","camera":"<camera>",
   "id":"{{ now().timestamp() }}","source":"<device>","label":"<name to show>"} on perception/external.
   source and label must be short names (letters, digits, spaces and . , ' ( ) _ -, at most 60 characters):
   otherwise Percezione refuses the request and answers with "error" on perception/external/result.
2. The text: an automation with an MQTT trigger on perception/external/result and the condition
   {{ trigger.payload_json.final and trigger.payload_json.kind == '<kind>' }}. The names are in
   trigger.payload_json.people (leave out anyone with "seen_by", or write them as "seen by <camera>"), plus
   "N unknown people" if trigger.payload_json.unrecognized > 0; if there is nobody: "nobody in view".
3. The photo: if "Photos of external events" is on in Percezione (Outputs → Home Assistant), there is the
   image.perception_last_<kind> entity, updated on every event of that kind; its attributes have text, people,
   seen_on_the_way and unrecognized. The automation can start from that entity's state change instead of the MQTT
   trigger, and attach the photo with data: { image: "/api/image_proxy/image.perception_last_<kind>" }.
   The entity also works in a dashboard (picture-entity card).
4. Send the text as a notification and, if needed, as a voice announcement. Do not open or control anything based on
   the name: recognition can be wrong.
```

## Note

Percezione asks Home Assistant for the id `image.perception_last_<kind>`, created at the first event of that kind. If it
had already been renamed by hand, the right one is in Settings → Devices & services → Percezione.
