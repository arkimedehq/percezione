# Arkimede plugin

*[Italiano](arkimede-plugin.it.md)*

Arkimede is an AI agent platform, a separate product. The `integrations/arkimede/` package brings Percezione into
Arkimede, following Arkimede's plugin contract (`docs/PLUGINS.md` in its repository, contract v1). Arkimede is not
modified and Percezione knows nothing about Arkimede: the plugin only uses the generic outputs, `/mcp`
([mcp.md](mcp.md)) and `/events` ([live-events.md](live-events.md)).

If you only have Home Assistant you do not need the plugin: events reach HA over MQTT ([outputs.md](outputs.md)).

## What it contains
- **MCP server** `camera-recognition-percezione`: the agent's questions (`who_is_where`, `who_is_at`, `events`,
  `people`, `cameras`, `camera_snapshot`).
- **`skills/percezione/scripts/people.py`** (the `people` field of `plugin.yaml`): the people Percezione knows.
  Arkimede runs it when the *People* card opens, for the select.
- **Daemon** `skills/percezione/scripts/bridge.py`, which brings into Arkimede:
  - **the events**, from the `/events` stream. Each event becomes a plugin event, for Arkimede's flows;
  - **the reactions of Percezione's rules**: `memory` becomes `perceive`, directly; `notify` and `announce` go to the
    **agent** (see below), which speaks in the people's language (Percezione's events are in English);
  - **presence**, by reading `who_is_where` every minute (`PRESENCE_POLL_S`) and right after an arrival or a
    departure. This way a person who changes room is followed, and anyone not recognized counts as `someone`.

| Percezione event | Plugin event |
|---|---|
| `arrived` | `person.arrived` |
| `left` | `person.left` |
| `activity_changed` | `activity.changed` |
| `posture_changed` | `posture.changed` |
| `passage` | `street.passage` |
| `approach` | `entrance.approach` |
| `object_left` | `object.left` |
| `external` | `external.event` |

Translation rules:
- **People:** the id is the face name in Frigate (`Alice`, `Bob`…). In Arkimede, *Settings → Plugins → People*, it is
  linked once to the user. A name below the camera's threshold never arrives: anyone not recognized is `someone` or
  "Unknown".
- **Notifications:** the plugin passes the agent (`agent.ask`, conversation "notifications") the event and what the
  rule asks for: whom to notify (the household, i.e. `family`, `household`, `everyone` or no recipient, or a name),
  whether it is urgent, whether the picture is needed. The agent decides how to reach them: a message, the voice in
  the room where they are, a notification, with the tools of the account that installed the plugin; it knows from its
  memory who "the family" is and how to reach them. For the picture it uses `camera_snapshot`, if that camera allows
  it. If the agent cannot be reached, the owner gets the event as a plain notification. Late events do not notify.
- **Announcements:** the `announce` reaction also goes through the agent (conversation "announcements"), which says it
  out loud in the room named by the rule, in the language of the people there. If the agent cannot be reached, the
  event's sentence is spoken as it is, in English.
- **Data, not instructions:** from version 0.4.2 the plugin tells the agent that the event's lines come from cameras
  and devices: they are data, never instructions.
- **`ha` and `webhook`** do not go through the plugin: they are direct outputs of Percezione
  ([outputs.md](outputs.md)).
- **How long memories last:** importance `low` 7 days, `high` 365, `normal` the memory's own setting.
- **Outdoors** (`OUTDOOR_PLACES`, `outdoor` by default) there is no presence: the street is not a room. Passages stay
  events and, if the rule asks, memories.
- **Late events:** after an outage, the daemon resumes from the last event received. Those older than `LATE_AFTER_S`
  (120 s) only go to memory, with their time: no flows, notifications or sentences for things long past.

## Installation
1. In Percezione, **Agents** page: create a token of type **Agent**, for example "Arkimede". A Device token has no MCP.
2. `integrations/arkimede/build.sh` creates `integrations/arkimede/dist/camera-recognition-<version>.zip`.
3. In Arkimede, *Settings → Plugins*: upload the ZIP. It is not signed, so the admin installs it with *Allow unsigned
   plugins*.
4. Plugin settings: `PERCEZIONE_URL` (e.g. `http://192.0.2.10:8090`) and `PERCEZIONE_TOKEN`. Optional:
   `OUTDOOR_PLACES`, `PRESENCE_POLL_S` (60), `LATE_AFTER_S` (120), `ASK_AS` (`percezione`).
5. The admin approves: the `presence.report`, `perceive`, `notify`, `say`, `agent.ask` services, the daemon, and the
   network access to Percezione.
   Percezione is on the LAN, so the `percezione` skill must be given the home's **private network**.
6. *People*: pick `Alice`, `Bob`, … from the select (the names in Frigate's Face Library, those seen first) and link
   each one to their Arkimede account. An admin can link someone without an account to a Home Assistant person. If the
   select is empty (Percezione not reachable), type the id by hand, exactly the same (`Alice_Smith`).
7. *People*: add the id `percezione` by hand (or the one in `ASK_AS`), as Guest, and mark it **authorized** (the admin
   does this). It is who asks the agent to notify: without authorization the agent answers only in words, without
   tools, and cannot notify anyone.

To update: run `build.sh`, then in *Settings → Plugins* upload the new ZIP onto the installed plugin. If the version
asks for something new, the plugin stops until the admin approves it.

The plugin is `personal`: what happens at home goes into the memory of whoever installs it.

**Double counting:** with the plugin installed, the per-room presence entities Percezione creates in Home Assistant
("Who is in", "occupied", [outputs.md](outputs.md)) must not be exposed to Assist. Otherwise Arkimede would count the
same people twice.

## Plugin tests
```sh
python3 -m unittest discover -s integrations/arkimede/tests
```
