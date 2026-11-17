/**
 * Differences between the cameras of data/config.json and Frigate's, without applying anything.
 *
 *   npm run frigate:diff
 */
import { config } from "../src/config.ts";
import { fromFrigate, managedOf, planImport, SECTIONS, sameSection } from "../src/frigate-config.ts";
import { FrigateSync } from "../src/frigate-sync.ts";
import { ConfigStore } from "../src/settings.ts";

const store = new ConfigStore(config.configPath);
const raw = await new FrigateSync(config.frigateUrl, store, config.go2rtcRtspUrl).fetchRaw();
const cfg = store.current;
console.log(`data/config.json v${cfg.version} ↔ Frigate ${config.frigateUrl}`);

const { changes } = planImport(cfg, raw, config.go2rtcRtspUrl);
if (changes.length === 0) console.log("no differences");
for (const c of changes) {
  const [camera, section] = c.split("/") as [string, (typeof SECTIONS)[number] | undefined];
  const ours = cfg.cameras[camera];
  const theirs = raw.cameras[camera];
  if (!section || !ours || !theirs) {
    console.log(`- ${c}`);
    continue;
  }
  const [a, b] = [managedOf(ours), fromFrigate(theirs, config.go2rtcRtspUrl)];
  const pick = (m: typeof a) =>
    ({ enabled: m.enabled ?? true, ffmpeg: m.stream, detect: m.detect, snapshots: m.snapshots, face_recognition: m.face_min_area, zones: m.zones, motion: m.masks })[section];
  if (!sameSection(a, b, section)) console.log(`- ${c}\n    config.json: ${JSON.stringify(pick(a))}\n    Frigate:     ${JSON.stringify(pick(b))}`);
}
