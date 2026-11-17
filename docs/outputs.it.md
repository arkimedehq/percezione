# Uscite

*[English](outputs.md)*

Dove vanno gli eventi oltre alla cronologia (`data/timeline.jsonl`). Si gestiscono dalla pagina **Uscite** del
frontend; lo stato di ognuna è anche in `GET /api/outputs`.

| Uscita | Cosa riceve | Codice / documento |
|---|---|---|
| **MQTT** | ogni evento su `perception/events` (schema v3), sempre | `src/outputs.ts` |
| **Home Assistant** | la vista: chi c'è per stanza, occupazione, eventi delle regole, ultimo evento, foto degli eventi esterni | `src/ha.ts`, `src/publish.ts` |
| **Webhook** | gli eventi delle regole con la reazione `webhook` verso quel nome, firmati | `src/webhooks.ts` |
| Arkimede | memoria, annunci, notifiche, presenza: dal plugin, non da qui | [arkimede-plugin.it.md](arkimede-plugin.it.md) |
| Agenti | domande (`/mcp`) ed eventi in diretta (`/events`) | [mcp.it.md](mcp.it.md), [live-events.it.md](live-events.it.md) |

## Outbox: nessun evento perso
Ogni destinazione (MQTT, ogni webhook) ha la sua coda su disco in `data/outbox/`:
- l'evento si scrive prima nel file `<uscita>.jsonl`, poi si invia; `<uscita>.pos` ricorda l'ultimo consegnato, così un
  riavvio riprende da lì;
- si invia in ordine. Se la destinazione è giù si ritenta dopo 5 s, poi 10, 20… fino a 5 minuti, senza saltare nulla;
  quando il broker MQTT si ricollega si ritenta subito;
- una destinazione giù non blocca le altre;
- una risposta 4xx di un webhook (tranne 408 e 429) vuol dire «non lo prenderò mai»: quell'evento si scarta e si va
  avanti, con l'errore nella pagina Uscite;
- dopo 7 giorni senza consegna un evento si scarta;
- la consegna è «almeno una volta»: dopo un crash può arrivare un doppione, che si riconosce dall'`event_id`.

## Home Assistant
Entità create da sole via MQTT discovery, nel dispositivo «Percezione». Si spengono con `outputs.homeassistant.enabled`
(pagina Uscite, «Home Assistant attivo»): spento, le entità spariscono da HA; `perception/events` resta.
- Per ogni luogo delle camere interne che osservano la presenza (una camera interna senza l'osservazione «presenza»
  non crea entità: lì nessuno verrebbe mai visto):
  - `sensor.perception_who_<luogo>` «Who is in <luogo>»: i nomi, «2 unrecognized» o «nobody»; negli attributi
    `people`, `unrecognized`, `occupied` e `persons`, cioè ogni persona riconosciuta con `camera`, `activity`
    (l'attività corrente, `null` finché non è stabile) e `posture` (con il modello di postura). Esempio:
    `{{ state_attr('sensor.perception_who_kitchen', 'persons') | selectattr('name', 'eq', 'Alice') | map(attribute='activity') | first }}`;
  - `binary_sensor.perception_occupied_<luogo>` «<luogo> occupied» (occupancy): qualcuno inquadrato, riconosciuto o no.
  Stato su `perception/presence/<luogo>` (retained), aggiornato a ogni evento e ogni 5 secondi.
- `event.perception_rule` «Percezione rule»: un evento ogni volta che scatta una regola con la reazione `ha`.
  `event_type` è l'id della regola; negli attributi `event_id`, `type`, `camera`, `place`, `person`, `text`,
  `importance`, `ts`. Passa dall'outbox MQTT. Esempio di automazione:
  ```yaml
  # lo stato di un'entità event è l'ora dell'ultimo evento: cambia sempre, anche se la regola è la stessa di prima
  triggers:
    - trigger: state
      entity_id: event.perception_rule
      not_from: unavailable
  conditions:
    - condition: state
      entity_id: event.perception_rule
      attribute: event_type
      state: night_entrance
  actions:
    - action: notify.mobile_app_phone
      data:
        message: "{{ state_attr('event.perception_rule', 'text') }}"
  ```
- `sensor.perception_last_event` «Last event», per una card della dashboard: lo stato è la frase dell'ultimo evento,
  l'attributo `events` gli ultimi eventi (`perception/recent`, retained).
- `image.perception_last_<tipo>` «Last <tipo>», **solo se accese** dalla pagina Uscite («Foto degli eventi esterni»,
  `outputs.homeassistant.external_photos`, spente di default: sono foto di persone). Un'entità per ogni tipo di
  [evento esterno](external-events.it.md) ricevuto (`ring` → «Last ring», `call` → «Last call», `gate_open` → «Last
  gate open»), creata al primo evento di quel tipo; all'accensione compaiono subito quelle dei tipi già nella
  cronologia, con la loro ultima foto. Mostra la foto migliore dell'ultimo evento di quel tipo, ridotta a 1280 px;
  negli attributi `event_id`, `time`, `kind`, `label`, `camera`, `place`, `text`, `people` (chi era davanti alla
  camera), `seen_on_the_way` (visti dalle altre camere del gruppo) e `unrecognized`. Foto su
  `perception/external_last/<tipo>/image`, attributi su `perception/external_last/<tipo>`, retained. Spente, le
  entità e le foto vengono tolte dal broker. Esempio di notifica con la foto, per il tipo `ring`:
  ```yaml
  triggers:
    - trigger: state
      entity_id: image.perception_last_ring
      not_from: unavailable
  actions:
    - action: notify.mobile_app_phone
      data:
        message: "{{ state_attr('image.perception_last_ring', 'text') }}"
        data:
          image: "/api/image_proxy/image.perception_last_ring"
  ```

**Doppio conteggio:** con il plugin di Arkimede installato, le entità «Who is in» e «occupied» **non vanno esposte ad
Assist**. Arkimede riceve già la presenza dal plugin e conterebbe due volte le stesse persone.

## Webhook
In `outputs.webhooks`, per nome: `{ "url": "https://…", "enabled": true }`. Una regola li usa con
`{ "react": "webhook", "to": "<nome>" }`.

Ogni POST porta l'evento v3 ([events.it.md](events.it.md)) come corpo JSON e:
```
X-Percezione-Event: <event_id>
X-Percezione-Timestamp: <secondi Unix>
X-Percezione-Signature: sha256=<HMAC-SHA256 esadecimale di "<timestamp>.<corpo>" con il segreto>
```
Il **segreto** lo crea Percezione, uno per webhook, e lo mostra una volta sola nella pagina Uscite («Mostra il segreto»
o «Nuovo segreto», che invalida il vecchio). Sta in `data/webhook-secrets.json` (permessi 600), mai in `config.json`
né nei log. Togliendo un webhook spariscono anche la sua coda e il suo segreto.

Verifica dal lato di chi riceve (Node):
```js
import { createHmac, timingSafeEqual } from "node:crypto";
function verify(secret, headers, rawBody) {
  const ts = Number(headers["x-percezione-timestamp"]);
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false; // vecchio: forse ripetuto
  const want = "sha256=" + createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  const got = String(headers["x-percezione-signature"] ?? "");
  return got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
```
Una consegna ritardata dall'outbox ha il timestamp dell'invio, non dell'evento: la finestra di 5 minuti vale anche dopo
un fermo lungo. L'ora dell'evento è `ts` nel corpo.

«Invia una prova» manda subito, fuori dalla coda, un evento `{"type": "test"}` firmato.
