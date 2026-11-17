import assert from "node:assert/strict";
import { pbkdf2Sync } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { frigateBaseConfig, frigateSecretFiles, HARDWARE, mosquittoAcl, mosquittoPasswd, writeIfMissing } from "../src/install.ts";
import { renderConfig } from "../src/restream.ts";
import { ensureSecrets, mosquittoLine, UiPassword } from "../src/secrets.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "perception-install-"));

test("secrets: created once, mode 600, never replaced / segreti: creati una volta, modo 600, mai sostituiti", () => {
  const path = join(tmp(), "secrets", "system.json");
  const first = ensureSecrets(path);
  assert.equal(first.created, true);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(first.secrets.go2rtc.password.length >= 24);
  assert.notEqual(first.secrets.mqtt.frigate.password, first.secrets.mqtt.percezione.password);
  const again = ensureSecrets(path);
  assert.equal(again.created, false);
  assert.deepEqual(again.secrets, first.secrets);

  // a broker of one's own: the logins written by hand stay, the missing parts are added
  writeFileSync(path, JSON.stringify({ mqtt: { frigate: { user: "ha-frigate", password: "x" } } }));
  const mixed = ensureSecrets(path);
  assert.equal(mixed.created, true);
  assert.deepEqual(mixed.secrets.mqtt.frigate, { user: "ha-frigate", password: "x" });
  assert.ok(mixed.secrets.go2rtc.password && mixed.secrets.mqtt.percezione.password);
});

test("Mosquitto's password line: PBKDF2-SHA512 as mosquitto_passwd writes it / riga delle password di Mosquitto: PBKDF2-SHA512 come mosquitto_passwd", () => {
  const salt = Buffer.alloc(12, 7);
  const line = mosquittoLine("frigate", "secret", salt);
  const [user, rest] = line.split(":");
  const [, kind, iterations, s, h] = rest!.split("$");
  assert.deepEqual([user, kind, iterations, s], ["frigate", "7", "101", salt.toString("base64")]);
  assert.equal(h, pbkdf2Sync("secret", salt, 101, 64, "sha512").toString("base64"));
  const { secrets } = ensureSecrets(join(tmp(), "s.json"));
  assert.deepEqual(
    mosquittoPasswd(secrets).trim().split("\n").map((l) => l.split(":")[0]),
    ["frigate", "percezione"],
  );
  // Frigate cannot write Percezione's topics (e.g. fake external events), Percezione cannot write fake Frigate events
  const acl = mosquittoAcl(secrets);
  assert.match(acl, /user frigate\ntopic readwrite frigate\/#\n\n/);
  assert.match(acl, /user percezione\ntopic read frigate\/#\ntopic readwrite perception\/#\ntopic readwrite homeassistant\/#/);
});

test("UI password: chosen once, checked by hash; UI_PASSWORD wins / password della UI: scelta una volta, verificata con l'hash; UI_PASSWORD vince", async () => {
  const path = join(tmp(), "ui.json");
  const p = new UiPassword(path);
  assert.equal(p.isSet, false);
  assert.equal(await p.check("anything"), false);
  p.set("correct horse");
  assert.equal(p.isSet, true);
  assert.ok(!readFileSync(path, "utf8").includes("correct horse"));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(await p.check("correct horse"), true);
  assert.equal(await p.check("correct horsE"), false);
  assert.throws(() => p.set("another one"), /already set/);
  const env = new UiPassword(join(tmp(), "none.json"), "from-env");
  assert.equal(env.isSet, true);
  assert.equal(await env.check("from-env"), true);
  assert.equal(await env.check("from-en"), false);
});

test("Frigate's first config for each hardware: valid YAML, no cameras, the right detector / prima config di Frigate per ogni hardware: YAML valido, nessuna camera, il detector giusto", () => {
  const types = Object.fromEntries(
    HARDWARE.map((hw) => {
      const c = parse(frigateBaseConfig(hw, { mqttPort: 1884 }));
      assert.deepEqual(c.cameras, {});
      assert.equal(c.mqtt.port, 1884);
      assert.equal(c.mqtt.password, "{FRIGATE_MQTT_PASSWORD}");
      assert.equal(c.face_recognition.enabled, true);
      return [hw, Object.values(c.detectors as Record<string, { type: string }>)[0]!.type];
    }),
  );
  assert.deepEqual(types, { cpu: "cpu", nvidia: "onnx", intel: "openvino", coral: "edgetpu" });
  const decode = Object.fromEntries(HARDWARE.map((hw) => [hw, parse(frigateBaseConfig(hw)).ffmpeg?.hwaccel_args ?? null]));
  assert.deepEqual(decode, { cpu: null, nvidia: "preset-nvidia", intel: "preset-vaapi", coral: null });
  const nvidia = parse(frigateBaseConfig("nvidia", { yoloImgSize: 640 }));
  assert.deepEqual([nvidia.model.path, nvidia.model.width], ["/config/model_cache/yolo.onnx", 640]);
  assert.equal(parse(frigateBaseConfig("coral", { coralDevice: "pci" })).detectors.coral.device, "pci");
});

test("first start files: Frigate's secrets, go2rtc's login in its file, config.yml only when missing / file del primo avvio: segreti di Frigate, login di go2rtc nel file, config.yml solo se manca", () => {
  const { secrets } = ensureSecrets(join(tmp(), "s.json"));
  const files = frigateSecretFiles(secrets, { host: "mosquitto" });
  assert.deepEqual(Object.keys(files).sort(), ["FRIGATE_GO2RTC_PASSWORD", "FRIGATE_GO2RTC_USER", "FRIGATE_MQTT_HOST", "FRIGATE_MQTT_PASSWORD", "FRIGATE_MQTT_USER"]);
  assert.equal(files.FRIGATE_MQTT_PASSWORD, secrets.mqtt.frigate.password);

  const go2rtc = renderConfig({ sources: {}, restream: { share: false } }, { get: () => undefined }, secrets.go2rtc);
  const yml = parse(go2rtc.yaml);
  assert.deepEqual([yml.api.username, yml.api.password, yml.rtsp.password], ["${PERCEZIONE_GO2RTC_USER}", "${PERCEZIONE_GO2RTC_PASSWORD}", "${PERCEZIONE_GO2RTC_PASSWORD}"]);
  assert.deepEqual(go2rtc.credentials, { PERCEZIONE_GO2RTC_USER: secrets.go2rtc.user, PERCEZIONE_GO2RTC_PASSWORD: secrets.go2rtc.password });
  const ours = parse(renderConfig({ sources: {}, restream: { share: false } }, { get: () => undefined }).yaml);
  assert.equal(ours.api.username, "${GO2RTC_USER}", "without a login go2rtc reads it from its environment");

  const path = join(tmp(), "config.yml");
  assert.equal(writeIfMissing(path, "edited by hand\n"), true);
  assert.equal(writeIfMissing(path, frigateBaseConfig("cpu")), false);
  assert.equal(readFileSync(path, "utf8"), "edited by hand\n");
});
