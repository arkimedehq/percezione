import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { importSources, renderConfig, Restream, SourcePasswords, sourceUrl } from "../src/restream.ts";
import { validate, type Config } from "../src/settings.ts";

function config(extra: Record<string, unknown> = {}): Config {
  const v = validate({
    version: 1,
    cameras: { front_door: { place: "entrance", kind: "outdoor", stream: { go2rtc: "front-door" } } },
    analyzers: { vlm: { model: "m", vocabulary: { other: "…" }, attributes: {} } },
    sources: {
      "front-door": { url: "rtsp://admin@192.0.2.10:554/Streaming/Channels/101", sub: "rtsp://admin@192.0.2.10:554/Streaming/Channels/102" },
      garden: { url: "http://192.0.2.11/mjpeg" },
    },
    ...extra,
  });
  assert.ok(v.ok, v.ok ? "" : v.errors.join("\n"));
  return v.config;
}

const tmp = (t: { after(fn: () => void): void }) => {
  const dir = mkdtempSync(join(tmpdir(), "restream-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("the password goes into the address, RTSP without backchannel / la password entra nell'indirizzo, RTSP senza backchannel", () => {
  assert.equal(sourceUrl("rtsp://admin@192.0.2.10:554/ch1", "p@ss:w/rd"), "rtsp://admin:p%40ss%3Aw%2Frd@192.0.2.10:554/ch1#backchannel=0");
  assert.equal(sourceUrl("rtsp://192.0.2.10/ch1"), "rtsp://192.0.2.10/ch1#backchannel=0");
  assert.equal(sourceUrl("http://192.0.2.11/mjpeg", "x"), "http://192.0.2.11/mjpeg", "no user: nothing to put the password on");
});

test("go2rtc.yaml: streams and sub streams with the password apart, login from the environment, WebRTC only when shared / go2rtc.yaml: stream e sottostream con la password a parte, login dall'ambiente, WebRTC solo se condiviso", (t) => {
  const passwords = new SourcePasswords(join(tmp(t), "p.json"));
  passwords.set("front-door", "p@ss:w/rd$1");
  const off = renderConfig(config(), passwords);
  assert.match(off.yaml, /"front-door": "rtsp:\/\/admin:\$\{SOURCE_FRONT_DOOR_PASSWORD\}@192\.0\.2\.10:554\/Streaming\/Channels\/101#backchannel=0"/);
  assert.match(off.yaml, /"front-door_sub": "rtsp:\/\/admin:\$\{SOURCE_FRONT_DOOR_PASSWORD\}@192\.0\.2\.10:554\/Streaming\/Channels\/102#backchannel=0"/);
  assert.match(off.yaml, /"garden": "http:\/\/192\.0\.2\.11\/mjpeg"/);
  assert.ok(!off.yaml.includes("p@ss") && !off.yaml.includes("p%40ss"), "no password in the YAML");
  // the value as written in a URL: go2rtc puts it in place of ${…} and masks it in what it logs
  assert.deepEqual(off.credentials, { SOURCE_FRONT_DOOR_PASSWORD: "p%40ss%3Aw%2Frd$1" });
  assert.equal(off.yaml.replace("${SOURCE_FRONT_DOOR_PASSWORD}", off.credentials.SOURCE_FRONT_DOOR_PASSWORD!).split("\n").find((l) => l.includes('"front-door":')), `  "front-door": ${JSON.stringify(sourceUrl(config().sources["front-door"]!.url, "p@ss:w/rd$1"))}`);
  assert.match(off.yaml, /username: "\$\{GO2RTC_USER\}"/);
  assert.match(off.yaml, /webrtc:\n {2}listen: ""/);
  assert.match(off.yaml, /log:\n {2}level: warn\n {2}streams: error/, "no warning prints a source's address");
  const on = renderConfig(config({ restream: { share: true, address: "192.0.2.5" } }), passwords);
  assert.match(on.yaml, /webrtc:\n {2}listen: ":8555"\n {2}candidates: \["192\.0\.2\.5:8555"\]/);
  const packaged = renderConfig(config(), passwords, { user: "percezione", password: "s3cret" });
  assert.match(packaged.yaml, /username: "\$\{PERCEZIONE_GO2RTC_USER\}"/);
  assert.ok(!packaged.yaml.includes("s3cret"));
  assert.deepEqual([packaged.credentials.PERCEZIONE_GO2RTC_USER, packaged.credentials.PERCEZIONE_GO2RTC_PASSWORD], ["percezione", "s3cret"]);
});

test("schema: no password in a source, camera streams among the sources, sharing needs an address / schema: niente password nella sorgente, stream delle camere tra le sorgenti, condividere vuole un indirizzo", () => {
  const errors = (x: Record<string, unknown>) => {
    const v = validate({ version: 1, cameras: {}, analyzers: { vlm: { model: "m", vocabulary: {}, attributes: {} } }, ...x });
    return v.ok ? [] : v.errors;
  };
  assert.match(errors({ sources: { a: { url: "rtsp://admin:secret@192.0.2.10/x" } } }).join(), /no password in the address/);
  assert.match(
    errors({ sources: { a: { url: "rtsp://192.0.2.10/x" } }, cameras: { c: { place: "p", kind: "indoor", stream: { go2rtc: "b" } } } }).join(),
    /stream "b" is not among the sources/,
  );
  assert.match(errors({ restream: { share: true } }).join(), /needs this machine's address/);
  assert.deepEqual(errors({}), [], "no sources: an external go2rtc, nothing checked");
});

test("written only when it changes, mode 600, passwords kept apart / scritto solo se cambia, permessi 600, password a parte", async (t) => {
  const dir = tmp(t);
  const passwords = new SourcePasswords(join(dir, "source-passwords.json"));
  passwords.set("front-door", "secret");
  passwords.set("gone", "old");
  passwords.keepOnly(Object.keys(config().sources));
  assert.equal(passwords.has("gone"), false);
  assert.equal(statSync(join(dir, "source-passwords.json")).mode & 0o777, 0o600);

  const rs = new Restream({ dir: join(dir, "go2rtc") });
  assert.equal(await rs.apply(config(), passwords), true);
  assert.equal(statSync(rs.file).mode & 0o777, 0o600);
  const creds = join(dir, "go2rtc", "credentials");
  assert.equal(statSync(creds).mode & 0o777, 0o700);
  assert.equal(statSync(join(creds, "SOURCE_FRONT_DOOR_PASSWORD")).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(creds, "SOURCE_FRONT_DOOR_PASSWORD"), "utf8"), "secret");
  assert.ok(!readFileSync(rs.file, "utf8").includes("secret"));
  assert.equal(await rs.apply(config(), passwords), false, "same content: no restart");
  passwords.set("front-door", "changed");
  assert.equal(await rs.apply(config(), passwords), true, "only the password changed: go2rtc must read it again");
  passwords.keepOnly([]);
  assert.equal(await rs.apply(config(), passwords), true);
  assert.deepEqual(readdirSync(creds), [], "a password that is gone leaves no file");
  assert.ok(!readFileSync(join(dir, "go2rtc", "go2rtc.yaml"), "utf8").includes("GO2RTC_PASSWORD=") );
});

test("import from another go2rtc: one source per stream, _sub as light stream / importa da un altro go2rtc: una sorgente per stream, _sub come leggero", async (t) => {
  let auth = "";
  const server = createServer((req, res) => {
    auth = req.headers.authorization ?? "";
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ "front-door": {}, "front-door_sub": {}, garden: {}, "Bad Name": {} }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const found = await importSources(url, "panel", "pw");
  assert.equal(auth, `Basic ${Buffer.from("panel:pw").toString("base64")}`);
  assert.deepEqual(found, {
    "front-door": { url: "rtsp://panel@127.0.0.1:8554/front-door", sub: "rtsp://panel@127.0.0.1:8554/front-door_sub" },
    garden: { url: "rtsp://panel@127.0.0.1:8554/garden" },
  });
});
