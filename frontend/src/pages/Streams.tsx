import { useEffect, useState } from "react";
import { api, type Restream } from "../api.ts";
import { useApp } from "../App.tsx";
import { useT } from "../i18n/index.tsx";
import { Button, Card, CopyButton, EmptyState, Field, Help, helpText, Switch, TextInput } from "../ui.tsx";

/**
 * Sharing the video sources with other apps on the network (wall panel, Home Assistant, VLC): on, go2rtc opens
 * WebRTC with this machine's address and the page shows the login and each stream's addresses. The switch and the
 * address are configuration (saved with the save bar); login and addresses come from the service once saved.
 */
export function Streams() {
  const t = useT();
  const s = t.outputs.streams;
  const { config, draft, edit, navigate } = useApp();
  const [rs, setRs] = useState<Restream>();
  const [reveal, setReveal] = useState(false);

  useEffect(() => {
    api.restream().then(setRs, () => setRs(undefined));
  }, [config.version]);

  const share = draft.restream.share;
  const address = draft.restream.address ?? "";
  const sources = Object.keys(config.sources);

  return (
    <Card className="flex flex-col gap-4 p-5 md:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <h2 className="m-0 text-lg font-semibold">{s.title}</h2>
            <Help label={s.title}>{helpText(s.help)}</Help>
          </div>
          <p className="m-0 text-sm text-muted">{s.subtitle}</p>
        </div>
        <Switch checked={share} label={s.share} onChange={(v) => edit((d) => void (d.restream.share = v))} />
      </div>

      {sources.length === 0 ? (
        <EmptyState title={s.noSources} text={s.noSourcesText} action={<Button onClick={() => navigate("/sources")}>{s.toSources}</Button>} />
      ) : (
        share && (
          <>
            <Field label={s.address} hint={s.addressHint} help={helpText(s.addressHelp)}>
              <TextInput value={address} onChange={(v) => edit((d) => void (d.restream.address = v.trim() || undefined))} placeholder="192.0.2.5" className="max-w-xs font-mono" />
            </Field>
            {!config.restream.share || !rs?.login ? (
              <p className="m-0 text-[13px] text-dim">{s.afterSave}</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-line bg-ground px-4 py-3 text-sm">
                  <span>
                    <span className="text-muted">{s.user}</span> <code>{rs.login.user}</code>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="text-muted">{s.password}</span> <code>{reveal ? rs.login.password : "••••••••"}</code>
                    <Button variant="ghost" onClick={() => setReveal((x) => !x)}>
                      {reveal ? s.hide : s.show}
                    </Button>
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left text-sm">
                    <thead>
                      <tr className="text-[13px] text-muted">
                        <th className="py-2 pr-4 font-medium">{s.stream}</th>
                        <th className="py-2 pr-4 font-medium">RTSP</th>
                        <th className="py-2 font-medium">MP4</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(rs.addresses ?? []).map((a) => (
                        <tr key={a.name} className="border-t border-line">
                          <td className="py-2 pr-4 font-mono text-[13px]">{a.name}</td>
                          <td className="py-2 pr-4">
                            <span className="flex items-center gap-2">
                              <code className="truncate text-[12px]">{a.rtsp}</code>
                              <CopyButton text={a.rtsp} />
                            </span>
                          </td>
                          <td className="py-2">
                            <CopyButton text={a.mp4} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )
      )}
    </Card>
  );
}
