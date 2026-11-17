# Prompt per un pannello e per Home Assistant

*[English](client-prompts.md)*

Due prompt da incollare nella sessione di chi sviluppa un client di Percezione: quando un dispositivo segnala un evento
esterno davanti a una camera, il client mostra chi c'era, con il nome e la foto del volto migliore. Le foto arrivano
solo ai client che le chiedono.
Riferimenti: [external-events.it.md](external-events.it.md) (eventi esterni), [people.it.md](people.it.md) («Chi c'è a
una camera»), [outputs.it.md](outputs.it.md) (Home Assistant).

Nei prompt vanno sostituiti:
- `<kind>`, il tipo dell'evento, libero: `ring` (uno squillo), `call`, `gate_open`…;
- `<camera>`, la camera davanti a cui succede, oppure l'id di un gruppo di camere;
- `<host>`, l'indirizzo di Percezione.

Il pannello usa un token di tipo **Dispositivo** (pagina Agenti): un token Agente non può segnalare eventi e non riceve
sempre le foto.

## Pannello

```text
Percezione (http://<host>:8090) registra gli eventi esterni: un dispositivo dice che è successo qualcosa davanti a
una camera, e Percezione risponde con chi c'era, con il nome e la foto del volto migliore di ognuno. Prepara la
schermata del pannello per l'evento <kind> sulla camera <camera>:

1. L'evento parte così: si pubblica {"kind":"<kind>","camera":"<camera>","id":"<id>"} su perception/external
   (oppure POST /external con il token del pannello, di tipo Dispositivo) e si ascolta perception/external/result.
2. Le risposte con "final": false arrivano subito: mostra i nomi in "people" (chi ha "seen_by" è stato visto da
   un'altra camera del gruppo lungo il percorso, non è per forza davanti alla camera) e "unrecognized" persone senza
   nome.
3. La risposta con "final": true arriva qualche secondo dopo: ogni persona può avere "face" (il ritaglio del volto) e
   "photo" (il fotogramma intero); "unknown_people" ha gli stessi file per chi era davanti alla camera senza nome.
   Le immagini si scaricano con GET http://<host>:8090/external/<file> e l'intestazione
   "Authorization: Bearer <token del pannello>". Mostra il volto accanto al nome; un tocco apre la foto intera.
4. "face" manca quando Frigate non ha visto un volto; "photo" anche quando la camera non ha la memoria breve: resta
   solo il nome, o "persona sconosciuta". Non fallire se un file risponde 404.
5. Chi c'è adesso, su richiesta: {"camera":"<camera>","id":"<id>","photos":true} su perception/who/request,
   risposta su perception/who/result con gli stessi campi della risposta finale (volti degli ultimi secondi).
6. Gli ultimi eventi: GET /external?kind=<kind>&limit=20 con lo stesso token; ogni evento ha "people" con "face" e
   "photo", "unknown_people" e "image" (la foto principale).

Non mettere il token negli URL e non tenere le foto oltre la schermata: restano su Percezione per 30 giorni.
```

## Home Assistant

```text
Percezione pubblica su MQTT (lo stesso broker di Home Assistant) il risultato di un evento esterno, cioè chi c'era
davanti alla camera. Prepara l'automazione dell'evento <kind> sulla camera <camera>:

1. L'automazione che segnala l'evento pubblica {"kind":"<kind>","camera":"<camera>",
   "id":"{{ now().timestamp() }}","source":"<dispositivo>","label":"<nome da mostrare>"} su perception/external.
   source e label devono essere nomi brevi (lettere, cifre, spazi e . , ' ( ) _ -, al massimo 60 caratteri):
   altrimenti Percezione rifiuta la richiesta e risponde con "error" su perception/external/result.
2. Il testo: un'automazione con trigger MQTT su perception/external/result e condizione
   {{ trigger.payload_json.final and trigger.payload_json.kind == '<kind>' }}. I nomi sono in
   trigger.payload_json.people (escludi chi ha "seen_by", oppure scrivilo come "visto da <camera>"), più
   "N persone sconosciute" se trigger.payload_json.unrecognized > 0; se non c'è nessuno: "nessuno in vista".
3. La foto: se in Percezione (Uscite → Home Assistant) sono accese «Foto degli eventi esterni», c'è l'entità
   image.perception_last_<kind>, aggiornata a ogni evento di quel tipo; i suoi attributi hanno text, people,
   seen_on_the_way e unrecognized. L'automazione può partire dal cambio di stato di quell'entità invece che dal
   trigger MQTT, e allegare la foto con data: { image: "/api/image_proxy/image.perception_last_<kind>" }.
   L'entità va bene anche in una dashboard (card picture-entity).
4. Manda il testo come notifica e, se serve, come annuncio vocale. Non aprire e non comandare nulla in base al nome:
   il riconoscimento può sbagliare.
```

## Nota

Percezione chiede a Home Assistant l'id `image.perception_last_<kind>`, creato al primo evento di quel tipo. Se era
già stato rinominato a mano, quello giusto si trova in Impostazioni → Dispositivi e servizi → Percezione.
