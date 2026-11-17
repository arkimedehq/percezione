# Eventi esterni

*[English](external-events.md)*

Un dispositivo dice a Percezione che è successo qualcosa davanti a una camera: hanno suonato il campanello, è arrivata
una chiamata, si è aperto un cancello. Percezione lo registra come un suo evento, con la foto del momento e chi c'è.
Da lì segue le strade di ogni evento: cronologia, regole e reazioni, `/events`, MQTT, plugin di Arkimede.

Percezione non conosce i tipi in anticipo: `kind` è libero (minuscole, cifre e `_`, fino a 40 caratteri).
L'interfaccia traduce quelli noti (`ring` → campanello, `call` → chiamata); gli altri li mostra come sono. Un evento
esterno non apre e non comanda mai nulla: lo registra e dice chi c'è.

## Richiesta

MQTT su `perception/external`, oppure `POST /external` con un token di tipo **Dispositivo** (pagina Agenti; un token
**Agente** riceve 403), oppure `POST /api/external` dall'interfaccia:

```json
{ "kind": "ring", "camera": "front_door", "id": "ring-1731440000", "source": "doorbell", "label": "Doorbell" }
```

- `kind` e `camera` sono obbligatori; la camera deve essere una camera di Percezione, oppure l'id di un gruppo
  (l'evento va sulla sua camera principale).
- Se la camera è la principale di un gruppo ([people.it.md](people.it.md), «Gruppi di camere»), le risposte sono quelle
  del gruppo: i nomi visti dalle altre camere lungo il percorso hanno `seen_by` e non contano tra le persone davanti
  alla camera principale.
- `id` è di chi chiama e torna in ogni risposta; `source` e `label` sono facoltativi (`label` dà il nome nella frase).
- `source` e `label` sono nomi brevi: lettere, cifre, spazi e `. , ' ( ) _ -`, al massimo 60 caratteri. Altrimenti la
  richiesta viene rifiutata: 422 in HTTP, una risposta con `error` su MQTT. L'etichetta finisce nel testo dell'evento,
  che un agente legge: solo un nome, mai testo libero.

## Risposte

Su `perception/external/result` (con HTTP arriva solo l'evento, a fine sguardo):

```json
{ "id": "ring-1731440000", "event_id": "…", "kind": "ring", "final": false,
  "camera": "front_door", "place": "entrance", "time": "…",
  "people": [], "unrecognized": 1, "unknown_faces": [ … ] }
```

- La prima risposta arriva subito, con chi Frigate sta seguendo in quel momento (come `who_is_at`).
- Percezione continua a guardare per `after_s` secondi («Sguardo dopo», 4 di default, impostabili per camera; un
  gruppo usa quelli della sua camera principale): appena trova un nome nuovo manda un'altra risposta, e smette prima
  se tutti gli inquadrati hanno un nome. Poi cerca il volto migliore di ognuno, dai `before_s` secondi prima della
  richiesta («Sguardo prima», 10 di default), e manda la risposta con `"final": true`: ha le stesse persone
  dell'evento, anche chi Frigate ha riconosciuto ma non segnala più in vista.
- `people` sono tutti i nomi visti dall'inizio. Chi aspetta un nome può fermarsi alla prima risposta che ne ha uno.
- Nella risposta finale ogni persona ha anche `face`, il ritaglio del volto, e, con la «Memoria breve» accesa sulla
  sua camera, `photo`, il fotogramma intero (gli stessi file dell'evento); `unknown_people` ha le foto di chi era
  davanti alla camera senza nome. Un pannello può mostrare subito chi c'era (`GET /external/<file>`).
- Una richiesta sbagliata risponde `{ "id": …, "error": "…" }`.

## L'evento

A fine sguardo, un solo evento v3 di tipo `external` ([events.it.md](events.it.md)):

- `value.to` è il tipo (`ring`): le regole lo filtrano con `value`, come l'oggetto di `object_left`;
- `person` è il primo riconosciuto, `people` tutti, `unrecognized` quanti altri erano inquadrati senza nome;
- con un gruppo: in `people` prima chi è davanti alla camera principale, poi chi è stato visto dalle altre camere
  (`seen_by`); `cameras` elenca le camere del gruppo;
- `external` = `{ request_id, source?, label? }`;
- ogni persona ha `face`, il suo volto migliore visto da Frigate (anche nei `before_s` secondi prima della richiesta),
  e, con la memoria breve accesa sulla sua camera, `photo`, il fotogramma intero di quell'istante
  ([people.it.md](people.it.md)); `unknown_people` ha le stesse foto per chi era sulla camera principale senza nome;
- `image` è la foto della prima persona; senza volti, quella del momento. Le foto sono in `data/external/`, tenute
  **30 giorni**, e si leggono con `GET /external/<file>`;
- il testo: `Doorbell at entrance: Alice and an unknown person`, oppure, con un gruppo,
  `Doorbell at entrance: Alice (seen by yard) and an unknown person` (l'interfaccia lo traduce).

## Elenco e foto (per un pannello)

Con il token di un client:

- `GET /external?kind=ring&limit=20`: gli ultimi eventi esterni, dal più recente;
- `GET /external/<image>`: la foto.

Un token **Dispositivo** riceve tutte le foto. Anche un token **Agente** può leggere, ma riceve le foto (`image`,
`photo` e `face` di `people` e `unknown_people`) solo se ogni camera dell'evento è abilitata in Agenti → Immagini delle
camere (per un gruppo: tutte le sue camere). Altrimenti l'evento arriva senza, e `GET /external/<file>` risponde 404
([mcp.it.md](mcp.it.md)).

Dall'interfaccia gli stessi su `/api/external`. Serve per esempio a un pannello a parete che mostra gli ultimi eventi
di un tipo con la foto. Due prompt pronti per costruire un client così sono in [client-prompts.it.md](client-prompts.it.md).
