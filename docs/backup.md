# Backup and restore

*[Italiano](backup.it.md)*

Both are on the **Usage** page, Backup section.

## What a backup contains
One file, `percezione-backup-YYYY-MM-DD.json.gz`, a gzipped JSON:

| Content | Notes |
|---|---|
| Configuration (`config.json`) | Cameras, zones, masks, sources without passwords, rules, outputs, analyzers |
| People and faces | All faces as Frigate lists them, night ones with the `~ir/` prefix |
| `mcp-clients.json` | Agent and client tokens (hashes only) |
| `webhook-secrets.json` | Webhook secrets |
| `secrets/ui.json` | Hash of the UI password chosen at first start |
| `people-imports.json` | Fingerprints of the photos already imported with the import API ([people.md](people.md)) |
| `source-passwords.json` | **Only with «Include the cameras' passwords»** |

It does not contain:
- the event history, the event photos and the photos of left objects;
- the system secrets (`secrets/system.json`: go2rtc and MQTT logins), because a new installation creates its own.

Keep a backup **with** the cameras' passwords as you would keep the passwords themselves. One **without** them still
contains the people's faces: do not share it.

## Restore
From the **Usage** page: choose the file, then «Restore» and confirm. In order:
1. **Files:** only those in the list above are rewritten. Any other path in the file is refused.
2. **Configuration:** it becomes a new version, so it reaches Frigate and go2rtc like any change, and the previous
   version stays in the history.
3. **Faces:** they go only to people who have none. Whoever already has faces stays as they are, so a restore never
   duplicates anything. Night faces go back to the night folder.
4. **Restart:** Percezione restarts by itself, because tokens, secrets and passwords are read at startup. In Docker the
   container comes back by itself; the page reloads when the service answers.

**The UI password goes back to the backup's one**, if the backup has one.

### A freshly installed Frigate
On its first start Frigate downloads its face models from GitHub (about 320 MB) and loads them. Until then it answers
"No face was detected" to every face, usually for a couple of minutes. The restore retries the first face for up to
5 minutes; after the first face is accepted, a refused one counts as an unreadable face and ends up among the result's
problems. A face uploaded by hand right after the install is refused too, with no retries: just try again a few
minutes later.

## API
- `GET /api/backup` (with `?secrets=1` for the cameras' passwords): downloads the file. Needs the UI login.
- `POST /api/restore`: body = the file. Answers with `config_version`, `files`, `people` (`added`, `kept`), `errors`
  and `restarting`, then restarts the service.
