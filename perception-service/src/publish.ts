import { existsSync, readFileSync } from "node:fs";
import type { MqttClient } from "mqtt";
import { SCHEMA_VERSION, type PerceptionEvent } from "./events.ts";
import { DEVICE } from "./ha.ts";

/**
 * Events towards Home Assistant on the MQTT broker:
 * - `perception/events`: every event as soon as it is emitted (for automations), through the outbox (src/outputs.ts);
 * - `perception/recent` (retained): the last `max` events with a ready sentence, for a dashboard card;
 * - `perception/status` (retained, LWT): online / offline;
 * - discovery: the `sensor.perception_last_event` sensor (state = the last event's sentence, attribute
 *   `events` = the last events), without touching Home Assistant's configuration.
 */
export const TOPIC = {
  events: "perception/events",
  recent: "perception/recent",
  status: "perception/status",
  discovery: "homeassistant/sensor/perception/last_event/config",
};

/** One event for the card: the English sentence, and the fields a card needs to write it in its own language. */
export type RecentItem = Pick<PerceptionEvent, "ts" | "type" | "camera" | "cameras" | "place" | "value" | "activity" | "zone" | "duration_s" | "approached" | "importance" | "text"> & {
  person: string | null;
};

export function toItem(e: PerceptionEvent): RecentItem {
  const { ts, type, camera, cameras, place, value, activity, zone, duration_s, approached, importance, text } = e;
  return { ts, type, person: e.person?.name ?? null, camera, cameras, place, value, activity, zone, duration_s, approached, importance, text };
}

export class Publisher {
  private recent: RecentItem[];

  constructor(
    private readonly client: MqttClient,
    private readonly max = 15,
    timelinePath?: string,
    /** outputs.homeassistant.enabled: off, the card and its sensor are not published (src/ha.ts removes them) */
    private readonly enabled: () => boolean = () => true,
  ) {
    // on restart the card starts again from the last events already written
    this.recent = timelinePath && existsSync(timelinePath) ? lastEvents(timelinePath, max).map(toItem) : [];
    client.on("connect", () => this.announce());
  }

  /** The panel card; the event itself goes to perception/events through the outbox (src/outputs.ts). */
  publish(e: PerceptionEvent): void {
    this.recent = [toItem(e), ...this.recent].slice(0, this.max);
    if (this.enabled()) this.publishRecent();
  }

  private publishRecent(): void {
    this.client.publish(TOPIC.recent, JSON.stringify({ events: this.recent }), { qos: 1, retain: true });
  }

  private announce(): void {
    this.client.publish(TOPIC.status, "online", { qos: 1, retain: true });
    if (!this.enabled()) return;
    this.client.publish(
      TOPIC.discovery,
      JSON.stringify({
        name: "Last event",
        unique_id: "perception_last_event",
        object_id: "perception_last_event",
        state_topic: TOPIC.recent,
        value_template: "{{ (value_json.events[0].text if value_json.events else 'no events')[:255] }}",
        json_attributes_topic: TOPIC.recent,
        availability_topic: TOPIC.status,
        icon: "mdi:cctv",
        device: DEVICE,
      }),
      { qos: 1, retain: true },
    );
    this.publishRecent();
  }
}

/** The last `n` events of a JSONL file, newest first (current schema only). */
function lastEvents(path: string, n: number): PerceptionEvent[] {
  const lines = readFileSync(path, "utf8").trimEnd().split("\n").slice(-n);
  return lines
    .flatMap((l) => {
      try {
        const e = JSON.parse(l) as PerceptionEvent;
        return e.schema_version === SCHEMA_VERSION ? [e] : [];
      } catch {
        return [];
      }
    })
    .reverse();
}
