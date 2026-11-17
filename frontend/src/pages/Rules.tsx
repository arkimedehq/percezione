import { useState } from "react";
import { api, type PerceptionEvent, type Reaction, type Rule } from "../api.ts";
import { PageHeader, useApp } from "../App.tsx";
import { useLocale, useT, type Messages } from "../i18n/index.tsx";
import { describeEvent, place, time } from "../i18n/format.ts";
import { Button, Card, Chips, ConfirmButton, EmptyState, Field, Help, Icon, ICONS, NumberInput, Select, Switch, TextInput, helpText } from "../ui.tsx";

// the same lists as perception-service/src/settings.ts (here without importing zod into the bundle)
const EVENTS = ["arrived", "left", "activity_changed", "posture_changed", "passage", "approach", "object_left", "external"] as const;
const POSTURES = ["standing", "sitting", "lying", "on_floor"];
const OBJECTS = ["trash", "parcel", "bulky"];
const REACTIONS = ["notify", "memory", "ha", "webhook", "announce"] as const;
const IMPORTANCE = ["low", "normal", "high"] as const;
const PERSONA_KINDS = ["anyone", "unknown", "known"];

const list = (v: string | string[] | undefined) => (v === undefined ? [] : [v].flat());

export function summary(t: Messages, r: Rule): string {
  const w = r.when;
  const s = t.rules.summary;
  const persons: Record<string, string> = t.events.person;
  const parts = [
    list(w.event).map((e) => (t.events.type as Record<string, string>)[e] ?? e).join(s.or) || s.anyEvent,
    w.person !== undefined ? list(w.person).map((p) => persons[p] ?? p).join(s.or) : "",
    w.hours ?? "",
  ].filter(Boolean);
  return `${parts.join(" · ")} → ${r.then.map((x) => t.events.reaction[x.react]).join(", ")}`;
}

export function Rules() {
  const { draft, edit } = useApp();
  const t = useT();
  const [sel, setSel] = useState(0);
  const rules = draft.rules;
  const rule = rules[sel];

  const add = () => {
    let n = rules.length + 1;
    while (rules.some((r) => r.id === `rule-${n}`)) n++;
    edit((d) => void d.rules.push({ id: `rule-${n}`, name: t.rules.newRuleName, enabled: true, when: {}, then: [{ react: "memory" }] }));
    setSel(rules.length);
  };

  return (
    <>
      <PageHeader
        title={t.rules.title}
        subtitle={t.rules.subtitle}
        help={helpText(t.rules.help)}
        actions={
          <Button variant="primary" onClick={add}>
            <Icon d={ICONS.plus} /> {t.rules.add}
          </Button>
        }
      />
      <div className="flex flex-wrap items-start gap-6">
        <ul className="m-0 flex min-w-0 flex-[1_1_320px] list-none flex-col gap-2.5 p-0">
          {rules.map((r, i) => (
            <li key={r.id} className={`flex items-center gap-3 rounded-[14px] border px-4 py-3 ${i === sel ? "border-accent bg-selected" : "border-line bg-surface"}`}>
              <button type="button" className="flex min-h-11 flex-1 flex-col gap-1 text-left" onClick={() => setSel(i)}>
                <span className="text-[15px] font-semibold">{r.name}</span>
                <span className="text-[13px] text-muted">{summary(t, r)}</span>
              </button>
              <Switch checked={r.enabled} onChange={(v) => edit((d) => void (d.rules[i]!.enabled = v))} label={t.rules.enable(r.name)} />
            </li>
          ))}
          {rules.length === 0 && (
            <li>
              <EmptyState
                title={t.rules.emptyTitle}
                text={t.rules.emptyText}
                action={
                  <Button variant="primary" onClick={add}>
                    <Icon d={ICONS.plus} /> {t.rules.add}
                  </Button>
                }
              />
            </li>
          )}
        </ul>
        {rule && <RuleEditor key={rule.id + sel} index={sel} rule={rule} onRemoved={() => setSel(Math.max(0, sel - 1))} />}
      </div>
    </>
  );
}

function RuleEditor({ index, rule, onRemoved }: { index: number; rule: Rule; onRemoved(): void }) {
  const { draft, edit, notify } = useApp();
  const t = useT();
  const { locale } = useLocale();
  const [test, setTest] = useState<{ total: number; hits: PerceptionEvent[] } | null>(null);
  const editRule = (fn: (r: Rule) => void) => edit((d) => fn(d.rules[index]!));
  /** sets a "when" filter: empty list = filter removed */
  const setWhen = <K extends keyof Rule["when"]>(k: K, v: Rule["when"][K] | string[] | undefined) =>
    editRule((r) => {
      if (v === undefined || (Array.isArray(v) && v.length === 0)) delete r.when[k];
      else (r.when as Record<string, unknown>)[k] = v;
    });
  const w = rule.when;
  const cameras = Object.keys(draft.cameras);
  const places = [...new Set(Object.values(draft.cameras).map((c) => c.place))];
  const zones = [...new Set(Object.values(draft.cameras).flatMap((c) => Object.keys(c.zones)))];
  const vocab = Object.keys(draft.analyzers.vlm.vocabulary);
  const personas = list(w.person);
  const names = personas.filter((p) => !PERSONA_KINDS.includes(p));
  const [from, to] = (w.hours ?? "23:00-06:00").split("-") as [string, string];

  return (
    <Card className="flex min-w-0 flex-[2_1_520px] flex-col gap-6 p-6">
      <Field label={t.rules.name}>
        <TextInput value={rule.name} onChange={(v) => editRule((r) => void (r.name = v))} />
      </Field>

      <section className="flex flex-col gap-4">
        <h2 className="m-0 flex items-center gap-2 text-[13px] font-semibold tracking-[0.08em] text-muted">
          {t.rules.when} <Help label={t.rules.when}>{t.rules.whenHelp}</Help>
        </h2>
        <Field label={t.rules.event} hint={t.rules.eventHint} help={helpText(t.rules.eventHelp)}>
          <Chips label={t.rules.event} options={EVENTS} labels={t.events.type} value={list(w.event)} onChange={(v) => setWhen("event", v as Rule["when"]["event"] & string[])} />
        </Field>
        <Field label={t.rules.person} help={helpText(t.rules.personHelp)}>
          <Chips label={t.rules.person} options={PERSONA_KINDS} labels={t.events.person} value={personas.filter((p) => PERSONA_KINDS.includes(p))} onChange={(v) => setWhen("person", [...v, ...names])} />
          <TextInput
            placeholder={t.rules.namesPlaceholder}
            value={names.join(", ")}
            onChange={(v) =>
              setWhen("person", [
                ...personas.filter((p) => PERSONA_KINDS.includes(p)),
                ...v.split(",").map((s) => s.trim()).filter(Boolean),
              ])
            }
          />
        </Field>
        <Field label={t.rules.cameras} hint={t.rules.camerasHint} help={t.rules.camerasHelp}>
          <Chips label={t.rules.cameras} options={cameras} value={w.cameras ?? []} onChange={(v) => setWhen("cameras", v)} />
        </Field>
        <Field label={t.rules.places} help={t.rules.placesHelp}>
          <Chips label={t.rules.places} options={places} labels={Object.fromEntries(places.map((p) => [p, place(t, p)]))} value={w.places ?? []} onChange={(v) => setWhen("places", v)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t.rules.zone} help={t.rules.zoneHelp}>
            <Select value={w.zone ?? ""} options={[["", t.rules.anyZone], ...zones.map((z) => [z, z] as [string, string])]} onChange={(v) => setWhen("zone", v || undefined)} />
          </Field>
          <Field label={t.rules.minDuration} hint={t.rules.minDurationHint} help={t.rules.minDurationHelp}>
            <NumberInput value={w.for_s} min={0} onChange={(v) => setWhen("for_s", v)} />
          </Field>
        </div>
        <Field label={t.rules.hours} help={t.rules.hoursHelp}>
          <div className="flex items-center gap-2">
            <Switch checked={!!w.hours} onChange={(v) => setWhen("hours", v ? `${from}-${to}` : undefined)} label={t.rules.limitHours} />
            {w.hours && (
              <>
                <input type="time" aria-label={t.rules.from} value={from} onChange={(e) => setWhen("hours", `${e.target.value}-${to}`)} className="min-h-11 w-32 rounded-[10px] border border-line-strong bg-ground px-2 text-ink" />
                <input type="time" aria-label={t.rules.to} value={to} onChange={(e) => setWhen("hours", `${from}-${e.target.value}`)} className="min-h-11 w-32 rounded-[10px] border border-line-strong bg-ground px-2 text-ink" />
              </>
            )}
          </div>
        </Field>
        <Field label={t.rules.value} hint={t.rules.valueHint} help={helpText(t.rules.valueHelp)}>
          <Chips label={t.rules.valueChips} options={[...POSTURES, ...OBJECTS, ...vocab]} labels={t.events.label} value={list(w.value)} onChange={(v) => setWhen("value", v)} />
        </Field>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="m-0 flex items-center gap-2 text-[13px] font-semibold tracking-[0.08em] text-muted">
          {t.rules.then} <Help label={t.rules.then}>{t.rules.thenHelp}</Help>
        </h2>
        {rule.then.map((x, i) => (
          <ReactionRow
            key={i}
            reaction={x}
            webhooks={Object.keys(draft.outputs.webhooks)}
            onChange={(nt) => editRule((r) => void (r.then[i] = nt))}
            onRemove={rule.then.length > 1 ? () => editRule((r) => void r.then.splice(i, 1)) : undefined}
          />
        ))}
        <Button variant="ghost" className="self-start border border-dashed border-line-strong" onClick={() => editRule((r) => void r.then.push({ react: "memory" }))}>
          {t.rules.addReaction}
        </Button>
      </section>

      <section className="flex flex-col gap-3 border-t border-line pt-5">
        <div className="flex flex-wrap gap-2.5">
          <Button variant="soft" onClick={() => api.testRule(rule).then(setTest, (e: Error) => notify("error", e.message))}>
            {t.rules.test}
          </Button>
          <span className="flex items-center">
            <Help label={t.rules.test}>{t.rules.testHelp}</Help>
          </span>
          <ConfirmButton
            confirm={t.rules.removeConfirm}
            onConfirm={() => {
              edit((d) => void d.rules.splice(index, 1));
              onRemoved();
            }}
          >
            <Icon d={ICONS.trash} /> {t.rules.remove}
          </ConfirmButton>
        </div>
        {test && !test.hits.length && <EmptyState title={t.rules.testNone(test.total)} text={t.rules.testNoneText} />}
        {test && test.hits.length > 0 && (
          <div className="flex flex-col gap-2 text-sm">
            <span className="text-muted">{t.rules.testHits(test.hits.length, test.total)}</span>
            {test.hits.slice(0, 20).map((e) => (
              <div key={e.event_id} className="flex gap-3 rounded-[10px] bg-ground px-3 py-2.5">
                <span className="tabular-nums text-muted">{time(locale, e.ts)}</span>
                {describeEvent(t, e)}
              </div>
            ))}
          </div>
        )}
      </section>
    </Card>
  );
}

function ReactionRow({ reaction: t, webhooks, onChange, onRemove }: { reaction: Reaction; webhooks: string[]; onChange(r: Reaction): void; onRemove?: () => void }) {
  const m = useT();
  const set = (patch: Record<string, unknown>) => {
    const next = { ...t, ...patch } as Record<string, unknown>;
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === "") delete next[k];
    onChange(next as Reaction);
  };
  const change = (react: Reaction["react"]) => {
    const base: Record<string, unknown> = { react, ...(t.importance ? { importance: t.importance } : {}) };
    if (react === "notify") base.to = "to" in t && t.to ? t.to : "owner";
    if (react === "webhook") base.to = webhooks[0] ?? "";
    onChange(base as Reaction);
  };
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-line-strong bg-ground p-3.5">
      <div className="min-w-[170px] flex-1">
        <Field
          label={m.rules.reaction}
          help={REACTIONS.map((r) => (
            <span key={r} className={`block ${r === REACTIONS[0] ? "" : "mt-1.5"}`}>
              <strong className={r === t.react ? "text-accent-ink" : "font-semibold"}>{m.events.reaction[r]}</strong>: {m.rules.reactionHelp[r]}
            </span>
          ))}
        >
          <Select value={t.react} options={REACTIONS.map((r) => [r, m.events.reaction[r]] as [Reaction["react"], string])} onChange={change} />
        </Field>
      </div>
      {t.react === "notify" && (
        <div className="min-w-[150px] flex-1">
          <Field label={m.rules.recipient} help={m.rules.recipientHelp}>
            <TextInput value={t.to} onChange={(v) => set({ to: v })} placeholder={m.rules.recipientPlaceholder} />
          </Field>
        </div>
      )}
      {t.react === "webhook" && (
        <div className="min-w-[150px] flex-1">
          <Field label={m.rules.webhook}>
            {webhooks.length ? <Select value={t.to} options={webhooks} onChange={(v) => set({ to: v })} /> : <span className="text-[13px] text-ko-ink">{m.rules.noWebhooks}</span>}
          </Field>
        </div>
      )}
      {t.react === "announce" && (
        <div className="min-w-[150px] flex-1">
          <Field label={m.rules.where} hint={m.rules.whereHint}>
            <TextInput value={t.to ?? ""} onChange={(v) => set({ to: v || undefined })} />
          </Field>
        </div>
      )}
      <div className="w-[140px]">
        <Field label={m.rules.importance} help={m.rules.importanceHelp}>
          <Select value={t.importance ?? ""} options={[["", m.common.none], ...IMPORTANCE.map((i) => [i, m.events.importance[i]] as [string, string])]} onChange={(v) => set({ importance: v || undefined })} />
        </Field>
      </div>
      {t.react === "notify" && (
        <div className="flex gap-4 pb-2 text-[13px] text-muted">
          <span className="flex items-center gap-2">
            <Switch checked={!!t.snapshot} onChange={(v) => set({ snapshot: v || undefined })} label={m.rules.withPhoto} /> {m.rules.photo}
          </span>
          <span className="flex items-center gap-2">
            <Switch checked={!!t.urgent} onChange={(v) => set({ urgent: v || undefined })} label={m.rules.urgentLabel} /> {m.rules.urgent}
          </span>
        </div>
      )}
      {onRemove && (
        <Button variant="ghost" aria-label={m.rules.removeReaction} className="w-11 px-0" onClick={onRemove}>
          <Icon d={ICONS.trash} />
        </Button>
      )}
    </div>
  );
}
