import { useEffect, useState } from "react";
import { api, type OutputStatus, type PerceptionEvent, type Presence } from "../api.ts";
import { PageHeader, useApp } from "../App.tsx";
import { describeEvent, label, place, time } from "../i18n/format.ts";
import { useLocale, useT } from "../i18n/index.tsx";
import { SetupGuide } from "../SetupGuide.tsx";
import { Button, Card, Dot, EmptyState, helpText } from "../ui.tsx";

const RECENT = 8;

/** The first page: who is home now, what just happened, whether everything is running. */
export function Home() {
  const t = useT();
  const h = t.home;
  const { locale } = useLocale();
  const { config, status, navigate, onEvent } = useApp();
  const [presence, setPresence] = useState<Presence>();
  const [events, setEvents] = useState<PerceptionEvent[]>([]);
  const [outputs, setOutputs] = useState<OutputStatus[]>([]);

  useEffect(() => {
    const poll = () => {
      api.presence().then(setPresence, () => setPresence(undefined));
      api.outputs().then(setOutputs, () => setOutputs([]));
    };
    poll();
    const timer = setInterval(poll, 5_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    api.events(RECENT).then(setEvents, () => setEvents([]));
    return onEvent((e) => setEvents((xs) => [e, ...xs].slice(0, RECENT)));
    // onEvent adds to a listener set that lives as long as the shell: subscribing once is enough
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // people in view, by place; unrecognized ones as a count
  const places = new Map<string, { people: Presence["present"]; unknown: number }>();
  for (const p of presence?.present ?? []) {
    const x = places.get(p.place) ?? { people: [], unknown: 0 };
    x.people.push(p);
    places.set(p.place, x);
  }
  for (const u of presence?.unrecognized ?? []) {
    const x = places.get(u.place) ?? { people: [], unknown: 0 };
    x.unknown += u.people;
    places.set(u.place, x);
  }

  // a camera turned off on purpose is not a problem; Frigate keeps reporting its last fps for a while, so it is not counted
  const cameras = Object.keys(config.cameras).filter((c) => config.cameras[c]!.enabled !== false);
  const off = Object.keys(config.cameras).length - cameras.length;
  const live = cameras.filter((c) => (status?.cameras[c]?.fps ?? 0) > 0).length;
  const waiting = outputs.reduce((n, o) => n + o.pending, 0);
  const failing = outputs.filter((o) => o.retry_at).length;

  return (
    <>
      <PageHeader title={h.title} subtitle={h.subtitle} help={helpText(h.help)} />
      <SetupGuide />
      <div className="grid gap-5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr))]">
        <Card className="flex flex-col gap-4 p-5 md:p-6">
          <h2 className="m-0 text-lg font-semibold">{h.whoTitle}</h2>
          {!presence ? (
            <p className="m-0 text-sm text-dim">{h.whoUnavailable}</p>
          ) : places.size === 0 ? (
            <EmptyState title={h.nobody} text={h.nobodyText} />
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {[...places].map(([pl, x]) => (
                <li key={pl} className="flex flex-col gap-1.5 rounded-xl border border-line px-4 py-3">
                  <span className="text-[13px] font-medium uppercase tracking-[0.06em] text-dim">{place(t, pl)}</span>
                  {x.people.map((p) => (
                    <span key={p.name} className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-[15px] font-medium">{p.name.replaceAll("_", " ")}</span>
                      {(p.activity || p.posture) && (
                        <span className="text-sm text-muted">{[p.activity, p.posture].filter(Boolean).map((v) => label(t, v)).join(" · ")}</span>
                      )}
                    </span>
                  ))}
                  {x.unknown > 0 && <span className="text-sm text-muted">{h.unrecognized(x.unknown)}</span>}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="flex flex-col gap-4 p-5 md:p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="m-0 text-lg font-semibold">{h.recentTitle}</h2>
            <Button variant="ghost" onClick={() => navigate("/live")}>
              {h.allEvents}
            </Button>
          </div>
          {events.length === 0 ? (
            <EmptyState title={h.noEvents} text={h.noEventsText} />
          ) : (
            <ol className="m-0 flex list-none flex-col p-0">
              {events.map((e) => (
                <li key={e.event_id} className="flex items-baseline gap-3 border-b border-line py-2.5 last:border-b-0">
                  <span className="w-12 shrink-0 text-[13px] tabular-nums text-dim">{time(locale, e.ts)}</span>
                  <span className={`text-sm ${e.importance === "high" ? "font-medium text-ko-ink" : e.type === "approach" || e.type === "object_left" ? "text-amber-ink" : "text-ink"}`}>
                    {describeEvent(t, e)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>

        <Card className="flex flex-col gap-4 p-5 md:p-6">
          <h2 className="m-0 text-lg font-semibold">{h.statusTitle}</h2>
          <ul className="m-0 flex list-none flex-col gap-3 p-0 text-sm">
            <StatusRow ok={!!status} label={h.frigate} value={status ? h.running(status.frigate.version.split("-")[0]!) : h.unreachable} />
            <StatusRow ok={!!status && live === cameras.length} warn={!!status && live > 0 && live < cameras.length} label={h.cameras} value={h.camerasLive(live, cameras.length, off)} action={() => navigate("/cameras")} />
            <StatusRow ok={failing === 0} warn={waiting > 0 && failing === 0} label={h.outputs} value={failing ? h.outputsFailing(failing) : waiting ? h.outputsWaiting(waiting) : h.outputsOk} action={() => navigate("/outputs")} />
            <StatusRow ok label={h.rules} value={h.rulesActive(config.rules.filter((r) => r.enabled).length)} action={() => navigate("/rules")} />
          </ul>
        </Card>
      </div>
    </>
  );
}

function StatusRow({ ok, warn, label, value, action }: { ok: boolean; warn?: boolean; label: string; value: string; action?: () => void }) {
  const body = (
    <>
      <Dot color={warn ? "amber" : ok ? "ok" : "ko"} />
      <span className="flex-1 text-muted">{label}</span>
      <span className="text-right text-ink">{value}</span>
    </>
  );
  return (
    <li>
      {action ? (
        <button type="button" onClick={action} className="flex min-h-10 w-full items-center gap-3 rounded-lg px-2 text-left hover:bg-raised">
          {body}
        </button>
      ) : (
        <span className="flex min-h-10 items-center gap-3 px-2">{body}</span>
      )}
    </li>
  );
}
