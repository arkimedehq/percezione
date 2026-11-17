import { chmodSync, chownSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.ts";
import { chownTree, frigateBaseConfig, frigateSecretFiles, HARDWARE, mosquittoAcl, mosquittoPasswd, writeFiles, writeIfMissing, type Hardware } from "./install.ts";
import { CREDENTIALS_DIR, renderConfig, writeCredentials } from "./restream.ts";
import { ensureSecrets } from "./secrets.ts";

/**
 * The setup service of deploy/docker-compose.yml: runs as root once before every start, then exits. It creates the
 * secrets and the files the other containers need on first start, and gives the data folder to the service's user.
 * Nothing is printed but file names.
 */
const NODE = 1000; // the `node` user of the image
const MOSQUITTO = 1883; // the `mosquitto` user of eclipse-mosquitto

const hw = config.hardware as Hardware;
if (!HARDWARE.includes(hw)) throw new Error(`PERCEZIONE_HARDWARE: one of ${HARDWARE.join(", ")}, not "${config.hardware}"`);

mkdirSync(config.secretsDir, { recursive: true, mode: 0o700 });
const { secrets, created } = ensureSecrets(resolve(config.secretsDir, "system.json"));
console.log(created ? "secrets: created data/secrets/system.json" : "secrets: data/secrets/system.json already there");

// Frigate reads these as Docker secrets (/run/secrets/FRIGATE_*), used in config.yml as {FRIGATE_…}
const mqttHost = process.env.MQTT_HOST || "mosquitto";
writeFiles(resolve(config.secretsDir, "frigate"), frigateSecretFiles(secrets, { host: mqttHost }));

// the included broker: its users, readable only by Mosquitto
const mosquittoDir = resolve(config.secretsDir, "mosquitto");
writeFiles(mosquittoDir, { passwd: mosquittoPasswd(secrets), acl: mosquittoAcl(secrets) });

mkdirSync(config.frigateConfigDir, { recursive: true });
const frigateYml = resolve(config.frigateConfigDir, "config.yml");
const port = Number(process.env.MQTT_PORT) || 1883;
if (writeIfMissing(frigateYml, frigateBaseConfig(hw, { coralDevice: config.coralDevice, yoloImgSize: config.yoloImgSize, mqttPort: port })))
  console.log(`frigate: config.yml written for ${hw}`);

// go2rtc starts before Percezione: behind its login from the start, with no streams yet
mkdirSync(config.go2rtcConfigDir, { recursive: true });
const go2rtc = renderConfig({ sources: {}, restream: { share: false } }, { get: () => undefined }, secrets.go2rtc);
if (writeIfMissing(resolve(config.go2rtcConfigDir, "go2rtc.yaml"), go2rtc.yaml, 0o600)) {
  writeCredentials(resolve(config.go2rtcConfigDir, CREDENTIALS_DIR), go2rtc.credentials);
  console.log("go2rtc: go2rtc.yaml written");
}

// everything to the service's user, but Mosquitto's and Frigate's secrets
chownTree(config.dataDir, NODE, NODE);
chownTree(resolve(config.secretsDir, "frigate"), 0, 0);
chownTree(mosquittoDir, MOSQUITTO, MOSQUITTO);
chmodSync(mosquittoDir, 0o700);
chownSync(config.secretsDir, NODE, NODE);
console.log("setup: done");
