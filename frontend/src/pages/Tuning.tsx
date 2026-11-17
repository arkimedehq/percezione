import type { ReactNode } from "react";
import type { Config } from "../api.ts";
import { PageHeader, useApp } from "../App.tsx";
import { useT } from "../i18n/index.tsx";
import { Card, Field, NumberInput } from "../ui.tsx";

// the defaults of perception-service/src/settings.ts (here without importing zod into the bundle)
const TUNING = {
  absence_s: 60,
  track_stale_s: 90,
  inherit_iou: 0.3,
  min_conf: 0.6,
  min_samples: 3,
  enter_ratio: 0.66,
  walk_threshold: 0.08,
  crop_margin: 0.5,
  crop_max_side: 512,
  frigate_import_s: 30,
  activity_poll_s: 15,
};
type Key = keyof typeof TUNING;

/** Fine tuning for every camera: edited in the working copy, saved with the save bar; empty fields use the defaults. */
export function Tuning() {
  const m = useT().tuning;
  const { draft, edit } = useApp();
  const tuning: NonNullable<Config["tuning"]> = draft.tuning ?? {};
  const set = (k: Key, v: number | undefined) =>
    edit((d) => {
      const next = { ...d.tuning, [k]: v };
      if (v === undefined) delete next[k];
      d.tuning = Object.keys(next).length ? next : undefined;
    });
  const field = (k: Key, label: string, hint: string, step = 1) => (
    <Field key={k} label={label} hint={hint}>
      <NumberInput value={tuning[k]} min={0} step={step} placeholder={String(TUNING[k])} onChange={(v) => set(k, v)} />
    </Field>
  );
  const section = (title: string, fields: ReactNode[]) => (
    <Card className="flex flex-col gap-4 p-5 md:p-6">
      <h2 className="m-0 text-lg font-semibold">{title}</h2>
      <div className="grid gap-4 md:grid-cols-3">{fields}</div>
    </Card>
  );
  return (
    <>
      <PageHeader title={m.title} subtitle={m.subtitle} />
      <div className="flex flex-col gap-5">
        {section(m.presence, [
          field("absence_s", m.absence, m.absenceHint),
          field("track_stale_s", m.trackStale, m.trackStaleHint),
          field("inherit_iou", m.inherit, m.inheritHint, 0.05),
        ])}
        {section(m.activity, [
          field("min_conf", m.minConf, m.minConfHint, 0.05),
          field("min_samples", m.minSamples, m.minSamplesHint),
          field("enter_ratio", m.enterRatio, m.enterRatioHint, 0.01),
          field("walk_threshold", m.walk, m.walkHint, 0.01),
          field("crop_margin", m.cropMargin, m.cropMarginHint, 0.1),
          field("crop_max_side", m.cropMaxSide, m.cropMaxSideHint, 64),
        ])}
        {section(m.frigate, [
          field("frigate_import_s", m.importEvery, m.importEveryHint),
          field("activity_poll_s", m.pollEvery, m.pollEveryHint),
        ])}
      </div>
    </>
  );
}
