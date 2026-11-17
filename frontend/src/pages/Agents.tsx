import { useCallback, useEffect, useState } from "react";
import { api, type McpClient } from "../api.ts";
import { PageHeader, useApp } from "../App.tsx";
import { Button, Card, Chips, ConfirmButton, EmptyState, Field, Help, Select, TextInput, helpText, CopyButton } from "../ui.tsx";
import { useLocale, useT, type Locale } from "../i18n/index.tsx";

const when = (locale: Locale, iso: string | null, never: string) =>
  iso ? new Date(iso).toLocaleString(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : never;

function Code({ children }: { children: string }) {
  return <code className="block overflow-x-auto whitespace-pre rounded-[10px] border border-line bg-raised px-3.5 py-2.5 text-[13px]">{children}</code>;
}

export function Agents() {
  const { draft, edit } = useApp();
  const t = useT();
  const { locale } = useLocale();
  const [clients, setClients] = useState<McpClient[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState<McpClient["role"]>("agent");
  const [created, setCreated] = useState<{ client: McpClient; token: string } | null>(null);
  const endpoint = `${location.protocol}//${location.host}/mcp`;
  const stream = `${location.protocol}//${location.host}/events`;

  const load = useCallback(() => api.mcpClients().then(setClients, (e: Error) => setError(e.message)), []);
  useEffect(() => void load(), [load]);

  const cameras = Object.keys(draft.cameras);
  const snapshots = draft.outputs.mcp.snapshots;

  return (
    <>
      <PageHeader title={t.agents.title} subtitle={t.agents.subtitle} help={helpText(t.agents.help)} />
      <div className="flex max-w-[860px] flex-col gap-5">
        <Card className="flex flex-col gap-3 p-5">
          <div className="flex items-center gap-2">
            <h2 className="m-0 text-base font-semibold">{t.agents.server.title}</h2>
            <Help label={t.agents.server.title}>
              {helpText(t.agents.server.help)}
            </Help>
          </div>
          <p className="m-0 text-sm text-muted">{t.agents.server.intro}</p>
          <div className="flex flex-wrap items-center gap-2.5">
            <code className="rounded-[10px] border border-line bg-raised px-3.5 py-2 text-sm">{endpoint}</code>
            <CopyButton text={endpoint} label={t.agents.copyAddress} />
          </div>
          <p className="m-0 text-sm text-muted">{t.agents.server.stream}</p>
          <div className="flex flex-wrap items-center gap-2.5">
            <code className="rounded-[10px] border border-line bg-raised px-3.5 py-2 text-sm">{stream}</code>
            <CopyButton text={stream} label={t.agents.copyAddress} />
          </div>
        </Card>

        <Card className="flex flex-col gap-4 p-5">
          <div className="flex items-center gap-2">
            <h2 className="m-0 text-base font-semibold">{t.agents.clients.title}</h2>
            <Help label={t.agents.clients.title}>
              {helpText(t.agents.clients.help)}
            </Help>
          </div>
          {error && <p className="m-0 text-sm text-ko-ink">{error}</p>}
          {clients.length === 0 ? (
            <EmptyState title={t.agents.clients.emptyTitle} text={t.agents.clients.emptyText} />
          ) : (
            <ul className="m-0 flex list-none flex-col p-0">
              {clients.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-3 first:border-t-0">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium">
                      {c.name} <span className="text-[13px] font-normal text-muted">· {t.agents.clients.roles[c.role]}</span>
                    </span>
                    <span className="text-[13px] text-muted">
                      {t.agents.clients.usage(when(locale, c.created, t.agents.never), when(locale, c.last_used, t.agents.never))}
                    </span>
                  </div>
                  <ConfirmButton confirm={t.agents.clients.confirmRevoke} onConfirm={() => void api.mcpRevoke(c.id).then(load, (e: Error) => setError(e.message))}>
                    {t.agents.clients.revoke}
                  </ConfirmButton>
                </li>
              ))}
            </ul>
          )}

          {created ? (
            <div role="status" className="flex flex-col gap-3 rounded-[12px] border border-amber bg-amber-soft/40 p-4">
              <p className="m-0 text-sm font-semibold text-amber-ink">{t.agents.clients.tokenOnce(created.client.name)}</p>
              <div className="flex flex-wrap items-center gap-2.5">
                <code className="max-w-full overflow-x-auto rounded-[10px] border border-line bg-raised px-3.5 py-2 text-[13px]">{created.token}</code>
                <CopyButton text={created.token} label={t.agents.clients.copyToken} />
              </div>
              {created.client.role === "agent" ? (
                <>
                  <p className="m-0 text-[13px] text-muted">{t.agents.clients.claudeCode}</p>
                  <Code>{`claude mcp add --transport http percezione ${endpoint} \\\n  --header "Authorization: Bearer ${created.token}"`}</Code>
                  <p className="m-0 text-[13px] text-muted">{t.agents.clients.otherClients}</p>
                </>
              ) : (
                <p className="m-0 text-[13px] text-muted">{t.agents.clients.deviceUse}</p>
              )}
              <div>
                <Button onClick={() => setCreated(null)}>{t.agents.clients.done}</Button>
              </div>
            </div>
          ) : (
            <form
              className="flex flex-wrap items-end gap-2.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (!name.trim()) return;
                void api.mcpCreate(name.trim(), role).then(
                  (r) => {
                    setCreated(r);
                    setName("");
                    void load();
                  },
                  (err: Error) => setError(err.message),
                );
              }}
            >
              <div className="min-w-[240px] flex-1">
                <Field label={t.agents.clients.newAgent} hint={t.agents.clients.newAgentHint}>
                  <TextInput value={name} onChange={setName} maxLength={60} />
                </Field>
              </div>
              <div className="min-w-[180px]">
                <Field label={t.agents.clients.role} hint={t.agents.clients.roleHint[role]}>
                  <Select value={role} options={[["agent", t.agents.clients.roles.agent], ["device", t.agents.clients.roles.device]] as const} onChange={setRole} />
                </Field>
              </div>
              <Button type="submit" variant="primary" disabled={!name.trim()}>
                {t.agents.clients.create}
              </Button>
            </form>
          )}
        </Card>

        <Card className="flex flex-col gap-3 p-5">
          <div className="flex items-center gap-2">
            <h2 className="m-0 text-base font-semibold">{t.agents.images.title}</h2>
            <Help label={t.agents.images.title}>
              {helpText(t.agents.images.help)}
            </Help>
          </div>
          <p className="m-0 text-sm text-muted">{t.agents.images.intro}</p>
          <Chips label={t.agents.images.label} options={cameras} value={snapshots} onChange={(v) => edit((d) => void (d.outputs.mcp.snapshots = v))} />
        </Card>
      </div>
    </>
  );
}
