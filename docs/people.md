# People

*[Italiano](people.it.md)*

The people the cameras can recognize. **Frigate's face library stays the only store**: one folder per person in
`clips/faces/<id>/`. Percezione is the UI and the API on top of it, without keeping a second copy.
- A person's **id** is the folder name. It is also the name in events (`person.name`, Frigate's `sub_label`).
- `train` is not a person: it holds Frigate's recent recognition attempts, which feed «To name».

## Pages

**People** (Configure menu): each person with a thumbnail, the number of faces and when they were last seen, taken
from the history. You can search by name and add a person, with a name and photos.

**One person**:
- their faces, newest first;
- add photos: Frigate finds the face in each photo and keeps only the crop. Photos without a face are refused;
- a wrong face can be removed, or moved to another person;
- rename. Past events keep the old name;
- merge into another person: all faces go to them and the folder disappears;
- delete the person with all their faces.

With fewer than 5 faces the page warns that recognition will be unsure.

**Tips**, from Frigate's guide, repeated on the page:
- 5–10 front-facing photos to start, then the faces seen by the cameras;
- no blurry, dark or infrared photos, no sunglasses or hats;
- avoid many photos taken at the same moment.

## To name

The **To name** tab of the People page, also reachable with `/people?to-name`. It shows the faces Frigate saw without
recognizing them.
- The cards come from its attempts in `train`, whose files are named `<event>-<time>-<guess>-<score>.webp`. How many
  are kept is set in People → Recognition (see below).
- One passage is one card: a Frigate event follows a single person. The card says where and when, and Frigate's guess
  if it has one.
- 3 faces are already picked, those with the highest score, because Frigate's guide advises against many similar faces
  at once.
- **«It is …»** with a new or existing name (case does not matter): the picked faces go to that person, with
  `POST /api/faces/train/<id>/classify`.
- **«Discard»** deletes the passage's attempts: nobody you know, or crops that are not faces.
- Passages already recognized at 90% or more are hidden, because they add little and risk unbalancing the library. A
  switch shows them.

**Where a face was seen**, looked up in this order:
1. from the history, if the passage made an event (`media.frigate_ids`);
2. from the track log `data/tracks.jsonl`, written by the service for every person track seen on MQTT and kept for
   7 days;
3. from Frigate's event.

Frigate does not keep the events of cameras without snapshots, and an unrecognized person produces no Percezione
events: for attempts older than the track log, the camera stays «not known».

## Who is at a camera

`who_is_at(camera)`: who is at a camera right now. Handy for an entrance, works for any camera.

```json
{ "camera": "front_door", "place": "entrance", "time": "…",
  "people": [{ "name": "Alice", "confidence": 0.93 }],
  "unrecognized": 1,
  "unknown_faces": [{ "file": "…", "time": "…", "guess": "Dave", "score": 0.62 }] }
```

- `people` and `unrecognized` come from the objects Frigate is tracking on that camera, i.e. from the latest
  `camera_activity` on its WebSocket.
- `unknown_faces` are the attempts of the last **2 minutes** on that camera's tracks (still in view, or found in the
  track log). Those already recognized at 90% or more are left out.

There are three ways to ask:

| Where | How |
|---|---|
| MCP (agents) | tool `who_is_at {camera}`; adds the camera's image if it is one of those allowed to agents. With `faces: true` also each person's best face, as images |
| API (UI) | `GET /api/cameras/<camera>/who`, with `?photos=1` the photos |
| MQTT (Home Assistant, devices) | publish `{"camera": "…", "id": "…"}`, or just the camera name, on `perception/who/request`; the answer arrives on `perception/who/result` with the same `id`. With `"photos": true` the photos. An unknown camera answers with `error` |

**With photos.** Whoever asks for photos gets, for each person, `face` (their best face of the last `before_s`
seconds, as Frigate cropped it) and, with the short memory on, `photo` (the whole frame of that instant);
`unknown_people` has the same photos for whoever is on the main camera without a name. People Frigate recognized a few
seconds earlier but no longer reports in view are included too. The photos are read with `GET /external/<file>` (a
**Device** token; an **Agent** token only for the cameras enabled for images, [mcp.md](mcp.md)) or
`/api/external/<file>` from the UI, and are kept for 30 days. Without `photos` the answer has no photos.

### Recognition settings

They are set from the UI and Percezione writes them into Frigate's configuration, like zones and streams; a change
made in Frigate's UI comes back into Percezione.

- **People → Recognition** (global): score for a name (`recognition_threshold`, Frigate's default 0.9), unknown below
  (`unknown_score`, 0.8), recent attempts kept (`save_attempts`, 200; in RAM, see «Look» below). In `config.json`
  they are under `faces`.
- **Camera editor → Smallest face** (`face_min_area`, in px²; empty: Frigate's global, 750). Frigate makes at most
  12 attempts per unnamed person: if far or blurred faces use them up before the person comes closer, raise the
  smallest face.

### Camera groups

A group joins cameras that look at the same place from different points. For example "Entrance" = the camera at the
door (main) plus a camera on the way to it, limited to the path zone. It is set up in Cameras → Camera groups, or in
`config.json`:

```json
"groups": { "door": { "label": "Door", "main": "front_door", "members": { "yard": { "zones": ["path"] } },
            "window_s": 60 } }
```

`who_is_at` on a group, by id or with its main camera, answers like this:

```json
{ "camera": "front_door", "group": { "id": "door", "label": "Door", "cameras": ["front_door", "yard"] },
  "people": [{ "name": "Alice", "confidence": 0.93 },
             { "name": "Bob", "confidence": 0.9, "seen_by": "yard", "seen_at": "…" }],
  "unrecognized": 1, … }
```

- People are counted on the main camera: `unrecognized` is for that camera only.
- The other cameras add the names recognized in the last `window_s` seconds, in the chosen zones (no zones means the
  whole frame). These names have `seen_by` and `seen_at`.
- A name with `seen_by` may be one of the unrecognized people in front of the main camera, but Percezione cannot tell
  which one.
- `unknown_faces` covers all the cameras of the group.
- A camera that is only a member of a group, asked on its own, answers like any other camera.
- API: `GET /api/groups/<id>/who`. MQTT and MCP accept the group id in place of the camera. The MCP tool `cameras`
  gives each camera's group.

**Look and best photo.** An external event ([external-events.md](external-events.md): a ring, a call…) looks from
`before_s` before to `after_s` after (10 and 4 s by default, settable per camera in the editor; a group uses its main
camera's times): for each person it takes Frigate's attempt with the largest, surest face.

- Recognition stays Frigate's: each person's name is its verdict. Percezione only picks the photo.
- With the **short memory** on for the camera (editor, off by default), Percezione keeps in RAM the last `before_s`
  seconds of the main stream, read from go2rtc in chunks of ~2 s without re-encoding, and each person also has the
  whole frame of the instant of their best face. Space per camera: bitrate × (`before_s` + one chunk), about 6 MB at
  4 Mbit/s with 10 s. The tmpfs has a 1 GB ceiling, which is not reserved.
- The time of the attempt (Frigate) and that of the chunks (Percezione) may differ by a second or two, and the frame
  of that instant may show the person already turned away. Percezione tries the nearby frames, closest first (up to
  ±2 s every half second), and keeps the first one where Frigate finds the face (with a name, the same one). The
  event's photo is one of these; if no frame shows a face, the one of that instant stays. Each choice is in the log
  ("best face of … frame at −1.5 s"), useful to measure the offset.
- Frigate's attempts («To name») are in RAM too (how many to keep is set in People → Recognition, 1000 on a new
  installation; 256 MB ceiling): they are lost at every Frigate restart. The face library stays on disk.
- Only each person's photo and face reach the disk, with the event.
- The short memory needs a camera whose stream is in go2rtc.

The recognized name is information, never a permission: it must not open anything.

## Night faces

At night the cameras film in infrared, in black and white. Frigate averages a person's faces and discards those too
far from the average: an infrared face among colour photos is discarded, and the person is not recognized at night.
A person well recognized by day can drop close to zero at night, even with one of their night faces added.

So each person has a second folder in Frigate, `<id>~ir`, only for night faces. Frigate averages it separately and
recognizes with it at night.

- Percezione picks the folder by itself by looking at the image: without colour (`isInfrared`, the mean difference
  between the channels of a small copy) it is a night face. This applies to uploaded photos and to faces given from
  «To name».
- You see a single person: in the list the night faces are `~ir/<file>`, the page marks them «night»; rename, merge,
  remove and move apply to both folders.
- Every name read from Frigate loses the suffix (events, `camera_activity`, attempts, list of names): events and
  `who_is_at` show `Alice`, never `Alice~ir`. Only Frigate's UI shows the name with the suffix.
- `~` is not allowed in a person's name, so it cannot be confused with anyone.

## API (behind the UI login)

| Method and path | What it does | Frigate 0.18 |
|---|---|---|
| `GET /api/people` | `[{ id, faces, last_seen }]` | `GET /api/faces` |
| `POST /api/people` `{name}` | Creates the person | `POST /api/faces/<id>/create` |
| `PUT /api/people/<id>` `{name}` | Renames | `PUT /api/faces/<id>/rename` |
| `DELETE /api/people/<id>` | Deletes with all faces | `POST /api/faces/<id>/delete` |
| `POST /api/people/<id>/merge` `{into}` | Merges | `reclassify` per face |
| `POST /api/people/<id>/faces` (multipart `file`) | Adds a photo | `POST /api/faces/<id>/register` |
| `DELETE /api/people/<id>/faces/<file>` | Removes a face | `POST /api/faces/<id>/delete` |
| `POST /api/people/<id>/faces/<file>/move` `{to}` | Moves a face | `POST /api/faces/<id>/reclassify` |
| `GET /api/people/<id>/faces/<file>` | The image | `/clips/faces/<id>/<file>` |
| `GET /api/people/unknown[?all=1]` | The passages to name | `GET /api/faces` (`train`) |
| `POST /api/people/unknown/assign` `{files, to}` | Names the picked faces | `POST /api/faces/train/<id>/classify` |
| `POST /api/people/unknown/discard` `{files}` | Discards | `POST /api/faces/train/delete` |

Accepted names are letters, digits, spaces, `'` and `-`, at most 50 characters. Spaces become `_`; `train` and
`unknown` belong to Frigate.

## Import API (with a token, for other programs)
For programs that already have the people's faces, for example a photo archive that recognizes faces. They use a
token of type **Device** (Agents page), in the `Authorization: Bearer <token>` header. An **Agent** token can only read
the list (`GET /people`): creating people or adding faces answers 403.

| Method and path | What it does |
|---|---|
| `GET /people` | `[{ id, faces }]`: the names and how many faces each has |
| `POST /people` `{name}` | Creates the person: 201 `{id}`, or 409 with the `id` of who already exists (case-insensitive) |
| `POST /people/<id>/faces` (multipart `file`, at most 10 MB) | Adds a photo to an existing person: `{added, night}` |

Rules:
- **A photo never creates a person.** If the person does not exist the answer is 404, so a wrong name in the program
  does not fill the list: a person is created with `POST /people`, on purpose.
- **The same photo is imported once.** Percezione remembers the fingerprint (sha256) of every imported photo in
  `data/people-imports.json`: if the same photo arrives again it answers `added: false` and does not pass it to
  Frigate. So the program can send everything again at every sync. If the person is deleted, their fingerprints are
  forgotten and the same photos can come back.
- **Night faces:** an infrared photo goes by itself to the person's night part (`night: true`).
- **Errors:** a photo without a recognizable face answers 422 with Frigate's message ("No face was detected"). A
  freshly installed Frigate refuses everything until it has loaded its face models ([backup.md](backup.md)).

```sh
curl -H "Authorization: Bearer $TOKEN" http://<percezione>:8090/people
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"name":"Alice"}' http://<percezione>:8090/people
curl -H "Authorization: Bearer $TOKEN" -F file=@alice.jpg http://<percezione>:8090/people/Alice/faces
```

## Good to know about Frigate 0.18

- Frigate's proxy caches the API's `GET` answers for 5 seconds: the list is read with a parameter that bypasses it,
  otherwise after a change you would see the old one.
- Every change makes Frigate rebuild the classifier from the files, at the next face.
- Do not call the faces API in the first ~30 s after Frigate starts: a request during startup can block the
  embeddings process until a restart.
