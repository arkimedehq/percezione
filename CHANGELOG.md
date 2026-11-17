# Changelog

*[Italiano](CHANGELOG.it.md)*

## 0.1.0 — first public release

Percezione turns IP cameras into events about people, locally, on top of Frigate and go2rtc.

- **Install** with Docker Compose from the published images (`ghcr.io/arkimedehq/percezione:0.1.0`, amd64 and
  arm64): a `setup` service creates the secrets and the base configuration; the UI password is chosen at the first
  visit. Hardware files for NVIDIA, Intel (GPU/NPU) and Coral; optional profiles for the activity model (`vlm`,
  Ollama, downloaded by itself) and for posture and left objects (`pose`).
- **Cameras, groups and zones** from the UI, with one go2rtc connection per camera, optionally shared with other apps.
- **People:** face photos, a "to name" box for faces seen by the cameras, separate night (infrared) faces.
- **Events** (schema v3): `arrived`, `left`, `activity_changed`, `posture_changed`, `passage`, `approach`,
  `object_left`, `external`; the short memory returns each person's best face around an external event.
- **Rules and reactions:** notification, memory, voice announcement, Home Assistant, webhook.
- **Outputs:** MQTT with Home Assistant discovery, signed webhooks with an outbox, live events over SSE, an MCP server
  for agents (read-only), `who_is_at` over MCP, HTTP and MQTT; Arkimede plugin.
- **Security:** agent and device tokens, login with growing wait, local host names only, Mosquitto ACL, files with
  secrets readable only by the service.
- **Backup and restore** of configuration, people, faces and tokens in one file.

Known: Frigate loads its face models only when it starts; on a new installation Percezione restarts it once when the
models have been downloaded (a few minutes after the first start). Until then face photos are refused with "No face
was detected".
