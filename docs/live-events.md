# Live events (`/events`)

*[Italiano](live-events.it.md)*

Percezione sends its events live to any program: the Arkimede plugin, a script, another platform. It does not know
the receivers: whoever wants the events connects and reads them.

## Connecting
- **Address:** `GET http://<Percezione host>:8090/events`, as Server-Sent Events.
- **Access:** `Authorization: Bearer <token>`, with the tokens of the **Agents** page, of either type (Agent or
  Device, [mcp.md](mcp.md)). The UI cookie does not work.
- Each event is the full v3 event ([events.md](events.md)), as on MQTT and in the history. An Agent token gets external
  events without their pictures (`image`, `photo` and `face` of the people) unless every camera of the event is enabled
  in Agents → Camera images; a Device token always gets them:
  ```
  id: 6f0c…            ← event_id
  event: perception
  data: {"event_id": "6f0c…", "schema_version": 3, "type": "passage", "ts": "…", "text": "…", "reactions": […], …}
  ```
- A `: ping` comment arrives every 20 seconds: 60 seconds of silence mean a dead connection.

## No lost events
- A client that reconnects sends `Last-Event-ID` (or `?after=<id>`) with the last id it received, and gets from the
  history everything that happened after it (at most 7 days).
- If that id is no longer in the history, it gets the last day: duplicates are dropped by id.
- A new client, without an id, gets only the events from that moment on. With `?since=<ISO>` it can also ask for those
  after a given instant.

Quick test:
```sh
curl -N -H "Authorization: Bearer <token>" http://<host>:8090/events
```
