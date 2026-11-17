# Eventi — schema v3

*[English](events.md)*

Tutto in inglese: campi, valori e `text`. L'interfaccia traduce dai campi nella lingua scelta.

Uno schema solo per tutte le uscite: cronologia (`data/timeline.jsonl`), MQTT `perception/events`, webhook, flusso
`/events`, MCP.

## Campi

| Campo | Tipo | Note |
|---|---|---|
| `event_id` | string | UUID; chi riceve deduplica con questo |
| `schema_version` | `3` | |
| `ts` | string | ISO 8601 UTC |
| `type` | string | vedi sotto |
| `camera` | string | la camera che l'ha visto |
| `cameras` | string[] | `passage`: tutte le camere del gruppo |
| `place` | string | il luogo della camera |
| `person` | object \| null | `{ name, confidence, source }`, `source` = `face` o `inherited`; null se non riconosciuto |
| `value` | object | `{ from, to }`: `activity_changed`, `posture_changed`; `object_left` e `external` (`from` null; `to` è l'oggetto o il tipo, es. `ring`) |
| `people` | object[] | `external`: tutti i riconosciuti, come `person` (che è il primo) |
| `unrecognized` | number | `external`: quanti altri erano inquadrati senza nome |
| `external` | object | `external`: `{ request_id, source?, label? }` dalla richiesta del dispositivo |
| `image` | string | `external`: la foto del momento, tenuta dal servizio (`/api/external/<image>`) |
| `activity` | string \| null | `left`: l'ultima attività |
| `zone` | string | `approach`: la zona d'ingresso; `object_left`: la zona osservata |
| `duration_s` | number | `passage` |
| `approached` | boolean | `passage`: è entrato nella zona d'ingresso |
| `object` | object | `object_left`: `{ score, rise, box, passersby, images: { before, after } }` |
| `latency_ms` | number | dal fotogramma all'emissione |
| `media` | object | `{ frigate_ids }`: snapshot e clip in Frigate |
| `text` | string | una frase pronta in inglese |
| `reactions` | object[] | le reazioni delle regole: `{ react, to?, snapshot?, urgent?, importance?, rules }` |
| `importance` | string | `low`, `normal`, `high` |

## Tipi

| `type` | Quando |
|---|---|
| `arrived` | una persona riconosciuta compare dopo un'assenza |
| `left` | non si vede più da un minuto (Regolazioni → Assenza prima di «uscito») |
| `activity_changed` | l'attività è cambiata ed è stabile |
| `posture_changed` | la postura è cambiata (`standing`, `sitting`, `lying`, `on_floor`) |
| `passage` | qualcuno è passato davanti alle camere esterne |
| `approach` | qualcuno è entrato nella zona d'ingresso |
| `object_left` | un oggetto è rimasto nella zona (`trash`, `parcel`, `bulky`) |
| `external` | un dispositivo ha detto che è successo qualcosa a una camera (il campanello, una chiamata): vedi [external-events.it.md](external-events.it.md) |

## Reazioni

`notify`, `memory`, `ha`, `webhook`, `announce`. Nelle regole il filtro sulla persona accetta un nome oppure
`anyone`, `unknown`, `known`. In un evento `external` vale per chiunque fosse inquadrato: `unknown` se almeno uno era
senza nome (o non c'era nessuno), un nome se era tra i riconosciuti.

## Versioni precedenti

Lo schema v2 aveva i campi in italiano. Una cronologia v2 viene convertita una volta all'avvio, e il file vecchio
resta come `timeline.jsonl.before-v3`. Allo stesso modo un `config.json` con i nomi italiani viene riscritto una volta,
e il vecchio resta come `config.json.before-english`. Anche le versioni salvate in `config-history/` si leggono.
