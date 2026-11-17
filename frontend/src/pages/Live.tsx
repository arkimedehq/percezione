import { useEffect, useState } from "react";
import { api, type PerceptionEvent } from "../api.ts";
import { PageHeader, useApp } from "../App.tsx";
import { Button, Dot, EmptyState, Icon, ICONS, helpText } from "../ui.tsx";
import { useLocale, useT, type Locale, type Messages } from "../i18n/index.tsx";
import { decimal, describeEvent, humanize, label, time } from "../i18n/format.ts";

const FILTERS = ["all", "home", "street", "reactions", "unknown"] as const;
type Filter = (typeof FILTERS)[number];

export function Live() {
  const { config, onEvent } = useApp();
  const t = useT();
  const { locale } = useLocale();
  const [events, setEvents] = useState<PerceptionEvent[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    api.events(300).then((e) => (setEvents(e), setConnected(true)), () => setConnected(false));
    return onEvent((e) => setEvents((list) => [e, ...list].slice(0, 500)));
  }, [onEvent]);

  const [photo, setPhoto] = useState<PerceptionEvent | null>(null);
  const outdoor = (e: PerceptionEvent) => e.type === "passage" || e.type === "approach" || e.type === "object_left";
  const shown = events.filter((e) =>
    filter === "all" ? true : filter === "home" ? !outdoor(e) : filter === "street" ? outdoor(e) : filter === "reactions" ? e.reactions.length > 0 : e.person === null,
  );

  return (
    <>
      <PageHeader
        title={t.live.title}
        subtitle={
          <span className="flex items-center gap-2">
            <Dot color={connected ? "ok" : "ko"} />
            {connected ? t.live.listening : t.live.unreachable}
          </span>
        }
        help={helpText(t.live.help)}
      />
      <div role="group" aria-label={t.live.filters} className="mb-5 flex flex-wrap gap-2">
        {FILTERS.map((id) => (
          <Button key={id} aria-pressed={filter === id} variant={filter === id ? "soft" : "secondary"} className="rounded-full" onClick={() => setFilter(id)}>
            {t.live.filter[id]}
          </Button>
        ))}
      </div>
      <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
        {shown.map((e) => {
          const shot = photos(t, e, config.cameras[e.camera]?.snapshots?.enabled ?? false)[0]?.src;
          return (
            <li key={e.event_id} className={`flex flex-wrap items-center gap-4 rounded-[14px] border bg-surface px-4 py-3.5 ${e.type === "approach" || e.type === "object_left" ? "border-amber-line" : "border-line"}`}>
              <span className="w-14 text-sm tabular-nums text-muted">{time(locale, e.ts)}</span>
              {shot && <Thumb src={shot} onOpen={() => setPhoto(e)} />}
              <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-1">
                <span className="text-[15px] font-medium">{describeEvent(t, e)}</span>
                <span className="text-[13px] text-muted">{meta(t, locale, e)}</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <span className={`rounded-lg px-2.5 py-1 text-[13px] ${e.importance === "high" ? "bg-ko-soft text-ko-ink" : "bg-raised text-ink"}`}>{t.events.importance[e.importance] ?? e.importance}</span>
                {e.reactions.map((r, i) => (
                  <span key={i} className="rounded-lg bg-accent-soft-strong px-2.5 py-1 text-[13px] text-accent-ink">
                    {t.events.reaction[r.react] ?? r.react}
                    {"to" in r && r.to ? ` → ${r.to}` : ""}
                  </span>
                ))}
              </div>
            </li>
          );
        })}
        {shown.length === 0 && (
          <li>
            {events.length === 0 ? (
              <EmptyState title={t.live.emptyTitle} text={t.live.emptyText} />
            ) : (
              <EmptyState
                title={t.live.emptyFilteredTitle}
                text={t.live.emptyFilteredText}
                action={
                  <Button variant="secondary" onClick={() => setFilter("all")}>
                    {t.live.filter.all}
                  </Button>
                }
              />
            )}
          </li>
        )}
      </ol>
      {photo && <PhotoDialog event={photo} snapshots={config.cameras[photo.camera]?.snapshots?.enabled ?? false} onClose={() => setPhoto(null)} />}
    </>
  );
}

function meta(t: Messages, locale: Locale, e: PerceptionEvent): string {
  const parts = [(e.cameras ?? [e.camera]).join(" + ")];
  if (e.person) parts.push(`${e.person.source === "inherited" ? t.live.inheritedName : t.live.face}${e.person.confidence !== null ? ` ${decimal(locale, e.person.confidence)}` : ""}`);
  if (e.value?.from) parts.push(t.live.from(label(t, e.value.from)));
  if (e.zone) parts.push(t.live.zone(e.zone));
  if (e.object) parts.push(`CLIP ${decimal(locale, e.object.score)}`);
  if (e.latency_ms !== undefined) parts.push(`${decimal(locale, e.latency_ms / 1000, 1)} s`);
  return parts.join(" · ");
}

/**
 * Event photos: an external event brings each person's best frame (S8b), left objects their own after/before pair, other events
 * Frigate's snapshot of each track.
 */
function photos(t: Messages, e: PerceptionEvent, snapshots: boolean): { src: string; caption: string }[] {
  const best = [
    ...(e.people ?? []).flatMap((p) => (p.photo ? [{ src: `/api/external/${p.photo}`, caption: humanize(p.name) }] : [])),
    ...(e.unknown_people ?? []).flatMap((p) => (p.photo ? [{ src: `/api/external/${p.photo}`, caption: t.live.unknownPerson }] : [])),
  ];
  // the event's own picture (a frame where a face is seen) first
  if (best.length) return best.sort((a, z) => Number(z.src.endsWith(`/${e.image}`)) - Number(a.src.endsWith(`/${e.image}`)));
  if (e.image) return [{ src: `/api/external/${e.image}`, caption: "" }];
  if (e.object) {
    return [
      { src: `/api/left-objects/${e.object.images.after}`, caption: t.live.after },
      { src: `/api/left-objects/${e.object.images.before}`, caption: t.live.before },
    ];
  }
  if (!snapshots) return [];
  return e.media.frigate_ids.map((id, i) => ({
    src: `/api/events/${encodeURIComponent(id)}/snapshot.jpg`,
    // ids and cameras are not aligned (one camera can have several tracks): just number them
    caption: e.media.frigate_ids.length > 1 ? t.live.nOfM(i + 1, e.media.frigate_ids.length) : "",
  }));
}

function Thumb({ src, onOpen }: { src: string; onOpen(): void }) {
  const [ok, setOk] = useState(true);
  const t = useT();
  if (!ok) return null;
  return (
    <button type="button" onClick={onOpen} aria-label={t.live.openPhoto} className="block h-[54px] w-24 cursor-zoom-in overflow-hidden rounded-lg bg-video p-0">
      <img src={src} alt="" loading="lazy" className="h-full w-full object-cover" onError={() => setOk(false)} />
    </button>
  );
}

function PhotoDialog({ event, snapshots, onClose }: { event: PerceptionEvent; snapshots: boolean; onClose(): void }) {
  const t = useT();
  const { locale } = useLocale();
  useEffect(() => {
    const onKey = (k: KeyboardEvent) => k.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // left objects: before first, then after, as they happened
  const list = event.object ? photos(t, event, snapshots).reverse() : photos(t, event, snapshots);
  // an external event: each person's face, as Frigate cut it
  const faces = [
    ...(event.people ?? []).flatMap((p) => (p.face ? [{ src: `/api/external/${p.face}`, caption: humanize(p.name) }] : [])),
    ...(event.unknown_people ?? []).flatMap((p) => (p.face ? [{ src: `/api/external/${p.face}`, caption: t.live.unknownPerson }] : [])),
  ];
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-scrim/85 px-4 py-10" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t.live.photos}
        className="flex w-full max-w-[1100px] flex-col gap-4 rounded-[18px] border border-line-strong bg-surface p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="m-0 text-lg font-semibold">{describeEvent(t, event)}</h2>
            <span className="text-[13px] text-muted">
              {new Date(event.ts).toLocaleString(locale, { dateStyle: "short", timeStyle: "medium" })} · {meta(t, locale, event)}
            </span>
          </div>
          <Button variant="ghost" aria-label={t.live.close} onClick={onClose} autoFocus>
            <Icon d={ICONS.close} />
          </Button>
        </div>
        {faces.length > 0 && (
          <div className="flex flex-wrap gap-3" aria-label={t.live.faces}>
            {faces.map((f) => (
              <figure key={f.src} className="m-0 flex w-24 flex-col items-center gap-1.5">
                <img src={f.src} alt={f.caption} className="h-28 w-24 rounded-xl bg-video object-cover" />
                <figcaption className="max-w-full truncate text-[13px] text-muted">{f.caption}</figcaption>
              </figure>
            ))}
          </div>
        )}
        <div className={`grid gap-3 ${list.length > 1 ? "md:grid-cols-2" : ""}`}>
          {list.map((p) => (
            <figure key={p.src} className="m-0 flex flex-col gap-1.5">
              <img src={p.src} alt={p.caption || t.live.photoAlt} className="max-h-[75vh] w-full rounded-xl bg-video object-contain" />
              {p.caption && <figcaption className="text-[13px] text-muted">{p.caption}</figcaption>}
            </figure>
          ))}
        </div>
      </section>
    </div>
  );
}
