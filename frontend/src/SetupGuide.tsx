import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { useApp } from "./App.tsx";
import { useT } from "./i18n/index.tsx";
import { Button, Card } from "./ui.tsx";

const HIDDEN_KEY = "percezione.setupHidden";

function readHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The first steps of a new installation, ticked from what is already configured: a camera, a zone, the faces of the
 * household, a rule, a connection to something outside. Gone once all are done, or when the viewer hides it.
 */
export function SetupGuide() {
  const t = useT();
  const g = t.common.setup;
  const { config, navigate } = useApp();
  const [hidden, setHidden] = useState(readHidden);
  const [people, setPeople] = useState<number | null>(null);
  const [clients, setClients] = useState(0);
  useEffect(() => {
    api.people().then((p) => setPeople(p.length), () => setPeople(null));
    api.mcpClients().then((c) => setClients(c.length), () => setClients(0));
  }, []);

  const cameras = Object.entries(config.cameras);
  const withZones = cameras.find(([, c]) => Object.keys(c.zones).length > 0);
  const steps = [
    { done: cameras.length > 0, title: g.camera.title, text: g.camera.text, action: <Button onClick={() => navigate("/cameras?add")}>{g.camera.action}</Button> },
    {
      done: !!withZones,
      title: g.zones.title,
      text: g.zones.text,
      action: cameras[0] && <Button onClick={() => navigate(`/cameras/${cameras[0]![0]}`)}>{g.zones.action}</Button>,
    },
    {
      done: !!people,
      title: g.faces.title,
      text: g.faces.text,
      action: <Button onClick={() => navigate("/people")}>{g.faces.action}</Button>,
    },
    { done: config.rules.length > 0, title: g.rule.title, text: g.rule.text, action: <Button onClick={() => navigate("/rules")}>{g.rule.action}</Button> },
    {
      done: Object.keys(config.outputs.webhooks).length > 0 || clients > 0,
      title: g.connect.title,
      text: g.connect.text,
      action: (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => navigate("/outputs")}>{g.connect.outputs}</Button>
          <Button onClick={() => navigate("/agents")}>{g.connect.agents}</Button>
        </div>
      ),
    },
  ];
  const left = steps.filter((s) => !s.done).length;
  if (hidden || left === 0) return null;
  const next = steps.findIndex((s) => !s.done);

  return (
    <Card className="mb-7 p-5 md:p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-lg font-semibold">{g.title}</h2>
          <p className="m-0 text-sm text-muted">{g.progress(steps.length - left, steps.length)}</p>
        </div>
        <Button
          variant="ghost"
          onClick={() => {
            setHidden(true);
            try {
              localStorage.setItem(HIDDEN_KEY, "1");
            } catch {
              // not remembered: hidden for this visit only
            }
          }}
        >
          {g.hide}
        </Button>
      </div>
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {steps.map((s, i) => (
          <li key={s.title} className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border px-4 py-3 ${i === next ? "border-accent/60 bg-accent-soft/40" : "border-line"}`}>
            <span
              aria-hidden="true"
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold ${s.done ? "bg-ok/20 text-ok" : i === next ? "bg-accent text-on-accent" : "bg-raised text-muted"}`}
            >
              {s.done ? "✓" : i + 1}
            </span>
            <div className="flex min-w-0 flex-[1_1_240px] flex-col gap-0.5">
              <span className={`text-[15px] font-medium ${s.done ? "text-muted line-through decoration-line-strong" : "text-ink"}`}>
                {s.title}
                <span className="sr-only">{s.done ? ` (${g.done})` : ""}</span>
              </span>
              {!s.done && <span className="text-[13px] text-muted">{s.text}</span>}
            </div>
            {!s.done && i === next && s.action}
          </li>
        ))}
      </ol>
    </Card>
  );
}
