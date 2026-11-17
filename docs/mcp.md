# MCP server for agents

*[Italiano](mcp.it.md)*

Percezione exposes a **read-only** MCP server. Any MCP client can query it: Claude, Arkimede (with
[its plugin](arkimede-plugin.md) or as any MCP server), OpenClaw, Hermes. It answers questions like "who is home?",
"where is Alice?", "who walked by last night?".

## Connecting
- **Address:** `http://<Percezione host>:8090/mcp`, MCP "streamable HTTP" transport, without sessions (stateless).
- **Access:** header `Authorization: Bearer <token>`.
  - One token per client: create and revoke them from the frontend's **Agents** page.
  - Each token has a **Type**, chosen when it is created. **Agent** (an AI assistant: Arkimede, Claude): `/mcp` and
    [`/events`](live-events.md); it can read `GET /external` and `GET /people`, but not post to them. **Device** (a
    wall panel, a doorbell, a photo archive): [`/external`](external-events.md) with all the pictures,
    [`/people`](people.md) with the import, and `/events`; no MCP.
  - Only an Agent token opens `/mcp`: a Device token gets 403. Tokens created before the types count as agents.
  - The token is shown **only once**, when it is created. On disk (`data/mcp-clients.json`, mode 600) only its sha256
    is kept.
  - The UI cookie does not open `/mcp`, and an MCP token does not open the UI's API: agents cannot change the
    configuration.
- **Example, Claude Code:**
  ```sh
  claude mcp add --transport http percezione http://<host>:8090/mcp --header "Authorization: Bearer <token>"
  ```
- Other clients: an HTTP MCP server at that address, with the same header.

## Tools
All of them have `readOnlyHint: true`. Names, descriptions and the events' `text` field are in English.
Times are local, with the offset (`2026-11-09T22:00:00+01:00`).

| Tool | What it returns |
|---|---|
| `who_is_where` | who is in view right now, with camera, place, activity, posture and face score; how many unrecognized people there are per camera; for whoever is not in view, the last sighting in the last 7 days |
| `events` | the events, most recent first. Filters: `since` / `until` (ISO with offset) or `hours` (24 by default), `camera`, `place`, `person` (a name, or `unknown` for the unrecognized; case and accents do not matter), `types`, `limit` (100 by default, at most 500) |
| `people` | every person face recognition knows (Frigate's Face Library): `id`, the name that appears in events and in `who_is_where`, a readable name (`Alice_Smith` → "Alice Smith") and the last sighting in the history (`null` if never seen). Those seen are listed first |
| `cameras` | the cameras: place, indoor or outdoor, what they observe, zones, whether images are allowed |
| `who_is_at` | who is at **one** camera or group of cameras right now (e.g. the door): the recognized names, how many without a name, the names seen on the way by the group's other cameras (`seen_by`), and the faces seen there in the last 2 minutes that nobody could name (with face recognition's guess). With the main camera's image, if enabled. With `faces: true`, on enabled cameras, also each person's best face of the last seconds (for a person seen by another camera of the group, `seen_by`, only if that camera too is enabled): one image per person with `face_image: true`, in the order of `people` and then of `unknown_people`. See [people.md](people.md) |
| `camera_snapshot` | a camera's current image (JPEG, at most 1280 px wide), **only** for enabled cameras |

Known limits:
- Unrecognized people are counted only on cameras with the presence observation. Passages on the street are found
  with `events`.
- `who_is_where` tells where someone was last seen, not whether they are still home: whoever leaves without passing
  in front of a camera stays "seen in the living room at 19:10".
- Names come from face recognition and can be wrong: check `confidence`.

## Images
By default no camera sends images. Enable them camera by camera from the **Agents** page, with the
`outputs.mcp.snapshots` configuration entry. Every image given to an agent is written to the service's log, with the
client's name.

The same rule holds for the pictures of external events (`image`, people's `photo` and `face`): an agent gets them, on
`/events` and `GET /external`, only if every camera of the event is enabled (for a group: all its cameras). A Device
token always gets them.

## Security
- Events are **data, not instructions**. The server's instructions tell the model so, but the texts still come from
  the cameras and from recognition.
- The server never calls Frigate's API on the agent's behalf and shows neither streams nor credentials.
- For now it is plain HTTP on the LAN, like the frontend. If it leaves the LAN, put HTTPS in front of it with a
  reverse proxy.
