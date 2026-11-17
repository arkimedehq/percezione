import { useState } from "react";
import { useApp } from "../App.tsx";
import { useT } from "../i18n/index.tsx";
import { Button, Card, Chips, ConfirmButton, Field, Help, helpText, Icon, ICONS, NumberInput, Select, Switch, TextInput } from "../ui.tsx";

/** An id from a name: "Porta d'ingresso" → "porta_d_ingresso". */
function slug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * Groups of cameras looking at the same place (e.g. one at an entrance and one on the way to it): "who is
 * there" and external events use all of them. Edited in the working copy, saved with the save bar.
 */
export function CameraGroups() {
  const t = useT();
  const g = t.cameras.groups;
  const { draft, edit } = useApp();
  const [name, setName] = useState("");
  const cameras = Object.keys(draft.cameras);
  const camLabel = (c: string) => draft.cameras[c]?.label ?? c;
  const groups = Object.entries(draft.groups);
  const mains = new Set(groups.map(([, x]) => x.main));
  const free = cameras.filter((c) => !mains.has(c));

  const add = () => {
    const base = slug(name) || "group";
    let id = base;
    for (let i = 2; id in draft.groups || id in draft.cameras; i++) id = `${base}_${i}`;
    edit((d) => void (d.groups[id] = { label: name.trim() || undefined, main: free[0]!, members: {}, window_s: 60 }));
    setName("");
  };

  return (
    <Card className="mt-6 flex flex-col gap-4 p-5 md:p-6">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2 className="m-0 text-lg font-semibold">{g.title}</h2>
          <Help label={g.title}>{helpText(g.help)}</Help>
        </div>
        <p className="m-0 text-sm text-muted">{g.subtitle}</p>
      </div>

      {groups.map(([id, group]) => (
        <div key={id} className="flex flex-col gap-4 rounded-xl border border-line bg-ground p-4">
          <div className="flex flex-wrap items-end gap-4">
            <Field label={g.name} hint={g.idHint(id)}>
              <TextInput value={group.label ?? ""} placeholder={id} onChange={(v) => edit((d) => void (d.groups[id]!.label = v || undefined))} className="max-w-xs" />
            </Field>
            <Field label={g.main} help={helpText(g.mainHelp)}>
              <Select
                value={group.main}
                options={cameras.filter((c) => c === group.main || !mains.has(c)).map((c): [string, string] => [c, camLabel(c)])}
                onChange={(v) =>
                  edit((d) => {
                    const x = d.groups[id]!;
                    x.main = v;
                    delete x.members[v];
                  })
                }
              />
            </Field>
            <Field label={g.window} hint={g.windowHint}>
              <NumberInput value={group.window_s} min={5} onChange={(v) => edit((d) => void (d.groups[id]!.window_s = v ?? 60))} />
            </Field>
          </div>
          <div className="flex flex-col gap-3">
            <span className="text-sm font-medium">{g.members}</span>
            {cameras
              .filter((c) => c !== group.main)
              .map((c) => {
                const member = group.members[c];
                const zones = Object.keys(draft.cameras[c]!.zones);
                return (
                  <div key={c} className="flex flex-col gap-2">
                    <span className="flex items-center gap-3 text-sm">
                      <Switch
                        checked={!!member}
                        label={g.member(camLabel(c))}
                        onChange={(on) =>
                          edit((d) => {
                            if (on) d.groups[id]!.members[c] = { zones: [] };
                            else delete d.groups[id]!.members[c];
                          })
                        }
                      />
                      {camLabel(c)}
                    </span>
                    {member && zones.length > 0 && (
                      <div className="flex flex-col gap-1 pl-14">
                        <span className="text-[13px] text-muted">{member.zones.length ? g.inZones : g.anywhere}</span>
                        <Chips options={zones} value={member.zones} label={g.zonesOf(camLabel(c))} onChange={(v) => edit((d) => void (d.groups[id]!.members[c]!.zones = v))} />
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
          <div>
            <ConfirmButton confirm={g.confirmRemove} onConfirm={() => edit((d) => void delete d.groups[id])}>
              {g.remove}
            </ConfirmButton>
          </div>
        </div>
      ))}

      {free.length > 0 && (
        <div className="flex flex-wrap items-end gap-3">
          <Field label={g.newName}>
            <TextInput value={name} placeholder={g.newPlaceholder} onChange={setName} className="max-w-xs" />
          </Field>
          <Button onClick={add}>
            <Icon d={ICONS.plus} />
            {g.add}
          </Button>
        </div>
      )}
    </Card>
  );
}
