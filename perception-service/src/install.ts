import { chownSync, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { mosquittoLine, writePrivate, type SystemSecrets } from "./secrets.ts";

/**
 * What the setup service (src/setup.ts) writes before the other containers start (deploy/docker-compose.yml). Every
 * step is safe to repeat: files the user may have edited (Frigate's config.yml) are written only when missing; the
 * ones derived from the secrets are rewritten every time, so they follow system.json.
 */

export const HARDWARE = ["cpu", "nvidia", "intel", "coral"] as const;
export type Hardware = (typeof HARDWARE)[number];

export interface HardwareOptions {
  /** coral: usb or pci */
  coralDevice?: string;
  /** nvidia: the YOLOv9 input the frigate-model service exported (320 or 640) */
  yoloImgSize?: number;
  /** the broker's port: a number in Frigate's config, so it cannot come from a {FRIGATE_*} value like the host */
  mqttPort?: number;
}

/**
 * Frigate's detector for the hardware, as in Frigate's docs (docs/data/object_detectors_models.yaml @ v0.18.0):
 * cpu, OpenVINO and EdgeTPU use the model inside Frigate's image; nvidia the YOLOv9 made by frigate-model.
 */
export function detectorYaml(hw: Hardware, o: HardwareOptions = {}): string {
  switch (hw) {
    case "cpu":
      return "detectors:\n  cpu1:\n    type: cpu\n";
    case "coral":
      return `detectors:\n  coral:\n    type: edgetpu\n    device: ${o.coralDevice === "pci" ? "pci" : "usb"}\n`;
    case "intel":
      return [
        "detectors:",
        "  ov:",
        "    type: openvino",
        "    device: GPU",
        "model:",
        "  width: 300",
        "  height: 300",
        "  input_tensor: nhwc",
        "  input_pixel_format: bgr",
        "  path: /openvino-model/ssdlite_mobilenet_v2.xml",
        "  labelmap_path: /openvino-model/coco_91cl_bkgr.txt",
        "",
      ].join("\n");
    case "nvidia": {
      const size = o.yoloImgSize === 640 ? 640 : 320;
      return [
        "detectors:",
        "  onnx:",
        "    type: onnx",
        "model:",
        "  model_type: yolo-generic",
        `  width: ${size}`,
        `  height: ${size}`,
        "  input_tensor: nchw",
        "  input_dtype: float",
        "  path: /config/model_cache/yolo.onnx",
        "  labelmap_path: /labelmap/coco-80.txt",
        "",
      ].join("\n");
    }
  }
}

/**
 * Video decoding on the hardware (Frigate's docs/configuration/hardware_acceleration_video.md @ v0.18.0): VAAPI on
 * Intel (gen 6–12, any codec), NVDEC on NVIDIA. On the CPU and with a Coral the CPU decodes.
 */
export function hwaccelYaml(hw: Hardware): string {
  const preset = { intel: "preset-vaapi", nvidia: "preset-nvidia" }[hw as string];
  return preset ? `ffmpeg:\n  hwaccel_args: ${preset}\n` : "";
}

/** Frigate's first config.yml: no cameras (Percezione adds them), people only, faces on, nothing on disk but snapshots. */
export function frigateBaseConfig(hw: Hardware, o: HardwareOptions = {}): string {
  return [
    `# Written once by Percezione's setup (hardware: ${hw}). Cameras are added from Percezione's UI;`,
    "# the rest can be changed here or in Frigate's UI. Logins come from data/secrets/frigate (Docker secrets).",
    "mqtt:",
    "  enabled: true",
    "  host: '{FRIGATE_MQTT_HOST}'",
    `  port: ${o.mqttPort ?? 1883}`,
    "  topic_prefix: frigate",
    "  client_id: frigate",
    "  user: '{FRIGATE_MQTT_USER}'",
    "  password: '{FRIGATE_MQTT_PASSWORD}'",
    "",
    detectorYaml(hw, o),
    hwaccelYaml(hw),
    "objects:",
    "  track:",
    "    - person",
    "",
    "record:",
    "  enabled: false",
    "",
    "snapshots:",
    "  enabled: false",
    "",
    "face_recognition:",
    "  enabled: true",
    "  model_size: large",
    "  recognition_threshold: 0.85",
    "  # recent attempts in RAM (docker-compose.yml): all cameras share them",
    "  save_attempts: 1000",
    "",
    "cameras: {}",
    "",
    "version: 0.18-0",
    "",
  ].join("\n");
}

/** The FRIGATE_* files Frigate reads from /run/secrets, used in config.yml (and in the cameras' go2rtc addresses). */
export function frigateSecretFiles(s: SystemSecrets, mqtt: { host: string; login?: { user: string; password: string } }): Record<string, string> {
  const login = mqtt.login ?? s.mqtt.frigate;
  return {
    FRIGATE_MQTT_HOST: mqtt.host,
    FRIGATE_MQTT_USER: login.user,
    FRIGATE_MQTT_PASSWORD: login.password,
    FRIGATE_GO2RTC_USER: s.go2rtc.user,
    FRIGATE_GO2RTC_PASSWORD: s.go2rtc.password,
  };
}

/** Mosquitto's password file for the included broker. */
export function mosquittoPasswd(s: SystemSecrets): string {
  return [mosquittoLine(s.mqtt.frigate.user, s.mqtt.frigate.password), mosquittoLine(s.mqtt.percezione.user, s.mqtt.percezione.password)].join("\n") + "\n";
}

/** Who may write what on the included broker: Frigate only its own topics, Percezione its own and Home Assistant's. */
export function mosquittoAcl(s: SystemSecrets): string {
  return [
    `user ${s.mqtt.frigate.user}`,
    "topic readwrite frigate/#",
    "",
    `user ${s.mqtt.percezione.user}`,
    "topic read frigate/#",
    "topic readwrite perception/#",
    "topic readwrite homeassistant/#",
    "",
  ].join("\n");
}

export function writeFiles(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writePrivate(resolve(dir, name), text);
}

/** Writes the file only when it is not there. Returns whether it wrote it. */
export function writeIfMissing(path: string, text: string, mode = 0o644): boolean {
  if (existsSync(path)) return false;
  writeFileSync(path, text, { mode });
  return true;
}

/** chown -R, without following links. */
export function chownTree(path: string, uid: number, gid: number): void {
  chownSync(path, uid, gid);
  if (!lstatSync(path).isDirectory()) return;
  for (const name of readdirSync(path)) {
    const p = resolve(path, name);
    if (lstatSync(p).isSymbolicLink()) continue;
    chownTree(p, uid, gid);
  }
}
