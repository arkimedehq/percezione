/**
 * Guided session for the test set: announces each activity with the macOS voice, records
 * the intervals in data/ground-truth.jsonl and saves frames + boxes in data/testset/<label>/
 * ("postura" program: data/testset-postura/<label>/, for scripts/bench-posture.ts).
 * The perception-service can stay on: its transitions are then compared with the ground truth.
 *
 *   npm run capture -- [camera] [seconds per step] [frame interval s] [attivita|postura]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import mqtt from "mqtt";
import { config } from "../src/config.ts";
import { JsonlLog } from "../src/emitter.ts";
import { fetchLatestFrame } from "../src/frigate.ts";

const camera = process.argv[2] ?? "attic";
const stepS = Number(process.argv[3] ?? 90);
const everyS = Number(process.argv[4] ?? 5);
// time to change activity after the announcement: excluded from the ground truth
const GRACE_S = 10;
const ABSENT = "assente";
const program = process.argv[5] ?? "attivita";

const ACTIVITY_STEPS: { label: string; say: string }[] = [
  { label: "al_pc", say: "Siediti al computer e lavora o gioca: tastiera e mouse." },
  { label: "usa_telefono", say: "Prendi il telefono e usalo tenendolo in mano." },
  { label: "al_telefono", say: "Ora fai una chiamata, con il telefono all'orecchio." },
  { label: "elettronica", say: "Lavora al banco di elettronica: schede, saldatore, strumenti." },
  { label: "altro", say: "Alzati e fai altro: sistema uno scaffale o cerca un oggetto." },
  { label: ABSENT, say: "Esci dalla stanza e resta fuori finché non ti richiamo." },
];

// a_terra (on the floor): simulated calmly, lying on the rug or the bare floor, away from the sofa
const POSTURE_STEPS: { label: string; say: string }[] = [
  { label: "in_piedi", say: "Stai in piedi in mezzo alla stanza, puoi muoverti piano." },
  { label: "seduto", say: "Siediti sul divano, come al solito." },
  { label: "sdraiato", say: "Sdraiati sul divano." },
  { label: "seduto", say: "Ora siediti su una sedia o a tavola." },
  { label: "a_terra", say: "Con calma, sdraiati a terra lontano dal divano, sul tappeto o sul pavimento libero." },
  { label: "in_piedi", say: "Rialzati e resta in piedi vicino alla porta." },
  { label: ABSENT, say: "Esci dalla stanza e resta fuori finché non ti richiamo." },
];

const steps = program === "postura" ? POSTURE_STEPS : ACTIVITY_STEPS;
const setDir = program === "postura" ? "testset-postura" : "testset";

const say = (text: string) => execFileSync("say", ["-v", "Alice", text]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// most recent box of a person on the camera, from Frigate events
type SeenBox = { box: [number, number, number, number]; id: string; at: number };
let lastBox = null as SeenBox | null;
const client = mqtt.connect(config.mqtt.url, {
  username: config.mqtt.username,
  password: config.mqtt.password,
  clientId: `perception-capture-${process.pid}`,
});
client.on("connect", () => client.subscribe("frigate/events"));
client.on("message", (_t, payload) => {
  try {
    const e = JSON.parse(payload.toString());
    if (e.after?.camera === camera && e.after.label === "person" && e.type !== "end") {
      lastBox = { box: e.after.box, id: e.after.id, at: Date.now() };
    }
  } catch {
    // non-JSON payload: ignored
  }
});

const session = new Date().toISOString();
const truth = new JsonlLog(config.dataDir, "ground-truth.jsonl");
let saved = 0;

say(`Inizia la sessione guidata: ${steps.length} attività da ${stepS} secondi.`);
for (const step of steps) {
  console.log(`▶ ${step.label}: ${step.say}`);
  say(step.say);
  await sleep(GRACE_S * 1000);
  const start = Date.now();
  const dir = resolve(config.dataDir, setDir, step.label);
  mkdirSync(dir, { recursive: true });
  while (Date.now() - start < (stepS - GRACE_S) * 1000) {
    const ts = Date.now();
    if (step.label !== ABSENT) {
      try {
        const jpg = await fetchLatestFrame(config.frigateUrl, camera);
        const name = new Date(ts).toISOString().replace(/[:.]/g, "-");
        writeFileSync(resolve(dir, `${name}.jpg`), jpg);
        // the box arrives only with MQTT updates: if it is old it is noted, the bench decides whether to use it
        const seen: SeenBox | null = lastBox;
        writeFileSync(
          resolve(dir, `${name}.json`),
          JSON.stringify({
            label: step.label,
            camera,
            ts: new Date(ts).toISOString(),
            box: seen?.box ?? null,
            track: seen?.id ?? null,
            box_age_ms: seen ? ts - seen.at : null,
          }),
        );
        saved++;
      } catch (err) {
        console.warn(`frame not saved: ${(err as Error).message}`);
      }
    }
    await sleep(Math.max(0, everyS * 1000 - (Date.now() - ts)));
  }
  truth.append({ session, program, camera, label: step.label, start: new Date(start).toISOString(), end: new Date().toISOString() });
}
say("Fine della sessione. Puoi rientrare. Grazie.");
console.log(`Saved ${saved} frames in data/${setDir}, intervals in data/ground-truth.jsonl (session ${session})`);
client.end();
