import { useCallback, useEffect, useState } from "react";
import { Streams } from "./Streams.tsx";
import { api, type OutputStatus } from "../api.ts";
import { PageHeader, useApp } from "../App.tsx";
import { Button, Card, ConfirmButton, Dot, EmptyState, Field, Help, Switch, TextInput, helpText, withCode } from "../ui.tsx";
import { useLocale, useT } from "../i18n/index.tsx";
import { dateTime } from "../i18n/format.ts";

/** Text from the dictionary; parts between backticks become code. */

/** One line on how a destination is doing: in queue, last delivery, last error, next attempt. */
function Delivery({ s }: { s?: OutputStatus }) {
  const t = useT();
  const { locale } = useLocale();
  const d = t.outputs.delivery;
  const when = (iso: string | null) => (iso ? dateTime(locale, iso) : t.outputs.never);
  if (!s) return <span className="text-[13px] text-dim">{d.inactive}</span>;
  const failing = s.retry_at !== null;
  return (
    <div className="flex flex-col gap-0.5 text-[13px] text-muted">
      <span className="flex items-center gap-2">
        <Dot color={failing ? "ko" : s.pending ? "amber" : "ok"} />
        {failing ? d.unreachable(when(s.retry_at)) : s.pending ? d.queued(s.pending) : d.upToDate}
        {failing && s.pending ? ` · ${d.queued(s.pending)}` : ""}
      </span>
      <span>
        {d.delivered(s.delivered, when(s.last_ok))}
        {s.dropped ? d.dropped(s.dropped) : ""}
      </span>
      {s.last_error && (
        <span>
          {d.lastError(when(s.last_error_at))} {s.last_error}
        </span>
      )}
    </div>
  );
}

export function Outputs() {
  const { config, draft, edit } = useApp();
  const t = useT();
  const o = t.outputs;
  const [status, setStatus] = useState<OutputStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);
  const [tested, setTested] = useState<Record<string, string>>({});

  const load = useCallback(() => api.outputs().then(setStatus, (e: Error) => setError(e.message)), []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => clearInterval(timer);
  }, [load]);

  const webhooks = draft.outputs.webhooks;
  const ha = draft.outputs.homeassistant;
  const mqtt = status.find((s) => s.kind === "mqtt");
  const nameError = name && !/^[a-z0-9_]+$/.test(name) ? o.webhooks.nameInvalid : name in webhooks ? o.webhooks.nameTaken : null;

  return (
    <>
      <PageHeader title={o.title} subtitle={o.subtitle} help={helpText(o.help)} />
      <div className="flex max-w-[860px] flex-col gap-5">
        <Streams />
        {error && <p className="m-0 text-sm text-ko-ink">{error}</p>}

        <Card className="flex flex-col gap-3 p-5">
          <div className="flex items-center gap-2">
            <h2 className="m-0 text-base font-semibold">MQTT</h2>
            <Help label="MQTT">
              {helpText(o.mqtt.help)}
            </Help>
          </div>
          <p className="m-0 text-sm text-muted">{o.mqtt.intro}</p>
          <Delivery s={mqtt} />
        </Card>

        <Card className="flex flex-col gap-3 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h2 className="m-0 text-base font-semibold">Home Assistant</h2>
              <Help label="Home Assistant">
                <span className="flex flex-col gap-2">
                  <span>{o.ha.help.intro}</span>
                  {o.ha.help.items.map((item, i) => (
                    <span key={i} className="block pl-3 -indent-3">
                      • {withCode(item)}
                    </span>
                  ))}
                  <span className="text-amber-ink">{o.ha.help.arkimede}</span>
                </span>
              </Help>
            </div>
            <Switch checked={ha.enabled} onChange={(v) => edit((d) => void (d.outputs.homeassistant.enabled = v))} label={o.ha.enabled} />
          </div>
          <p className="m-0 text-sm text-muted">{o.ha.intro}</p>
          {!ha.enabled && <p className="m-0 text-[13px] text-muted">{o.ha.off}</p>}
          {ha.enabled && (
            <div className="flex flex-col gap-1">
              <span className="flex items-center gap-3 text-sm">
                <Switch checked={ha.external_photos} onChange={(v) => edit((d) => void (d.outputs.homeassistant.external_photos = v))} label={o.ha.externalPhotos} />
                {o.ha.externalPhotos}
              </span>
              <p className="m-0 pl-14 text-[13px] text-muted">{o.ha.externalPhotosHint}</p>
            </div>
          )}
        </Card>

        <Card className="flex flex-col gap-4 p-5">
          <div className="flex items-center gap-2">
            <h2 className="m-0 text-base font-semibold">{o.webhooks.title}</h2>
            <Help label={o.webhooks.title}>
              {helpText(o.webhooks.help)}
            </Help>
          </div>
          <p className="m-0 text-sm text-muted">{o.webhooks.intro}</p>
          {Object.keys(webhooks).length === 0 && <EmptyState title={o.webhooks.emptyTitle} text={o.webhooks.emptyText} />}
          {Object.entries(webhooks).map(([n, w]) => {
            const saved = n in config.outputs.webhooks;
            const s = status.find((x) => x.kind === "webhook" && x.name === n);
            return (
              <div key={n} className="flex flex-col gap-3 border-t border-line pt-4 first:border-t-0 first:pt-0">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="font-medium">{n}</span>
                  <Switch checked={w.enabled} onChange={(v) => edit((d) => void (d.outputs.webhooks[n]!.enabled = v))} label={o.webhooks.enabled(n)} />
                </div>
                <Field label={o.webhooks.url}>
                  <TextInput value={w.url} onChange={(v) => edit((d) => void (d.outputs.webhooks[n]!.url = v))} />
                </Field>
                <Delivery s={saved ? s : undefined} />
                {secret?.name === n ? (
                  <div role="status" className="flex flex-col gap-2 rounded-[12px] border border-amber bg-amber-soft/40 p-4">
                    <p className="m-0 text-sm font-semibold text-amber-ink">{o.webhooks.secretOnce(n)}</p>
                    <code className="max-w-full overflow-x-auto rounded-[10px] border border-line bg-raised px-3.5 py-2 text-[13px]">{secret.secret}</code>
                    <div className="flex gap-2.5">
                      <Button onClick={() => void navigator.clipboard.writeText(secret.secret)}>{o.webhooks.copy}</Button>
                      <Button onClick={() => setSecret(null)}>{o.webhooks.done}</Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2.5">
                    <ConfirmButton
                      confirm={s?.has_secret ? o.webhooks.confirmNewSecret : t.common.confirm}
                      onConfirm={() => void api.webhookSecret(n).then((r) => setSecret({ name: n, secret: r.secret }), (e: Error) => setError(e.message))}
                    >
                      {s?.has_secret ? o.webhooks.newSecret : o.webhooks.showSecret}
                    </ConfirmButton>
                    <Button
                      disabled={!saved}
                      onClick={() =>
                        void api.webhookTest(n).then(
                          (r) => setTested((x) => ({ ...x, [n]: r.ok ? o.webhooks.testArrived : o.webhooks.testFailed(r.errors.join(", ")) })),
                          (e: Error) => setTested((x) => ({ ...x, [n]: e.message })),
                        )
                      }
                    >
                      {o.webhooks.sendTest}
                    </Button>
                    <ConfirmButton confirm={o.webhooks.confirmRemove} onConfirm={() => edit((d) => void delete d.outputs.webhooks[n])}>
                      {o.webhooks.remove}
                    </ConfirmButton>
                    {tested[n] && <span className="text-[13px] text-muted">{tested[n]}</span>}
                  </div>
                )}
                {!saved && <p className="m-0 text-[13px] text-dim">{o.webhooks.saveFirst}</p>}
              </div>
            );
          })}
          <form
            className="flex flex-wrap items-end gap-2.5 border-t border-line pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name || nameError || !url) return;
              edit((d) => void (d.outputs.webhooks[name] = { url, enabled: true }));
              setName("");
              setUrl("");
            }}
          >
            <div className="min-w-[160px]">
              <Field label={o.webhooks.newWebhook} hint={nameError ?? o.webhooks.nameExample}>
                <TextInput value={name} onChange={setName} maxLength={40} />
              </Field>
            </div>
            <div className="min-w-[240px] flex-1">
              <Field label={o.webhooks.url} hint="https://…">
                <TextInput value={url} onChange={setUrl} />
              </Field>
            </div>
            <Button type="submit" variant="primary" disabled={!name || !!nameError || !url}>
              {o.webhooks.add}
            </Button>
          </form>
          <p className="m-0 text-[13px] text-muted">{o.webhooks.afterAdd}</p>
        </Card>
      </div>
    </>
  );
}
