# Persone

*[English](people.md)*

Le persone che le camere sanno riconoscere. **La libreria dei volti di Frigate resta l'unico archivio**: una
cartella per persona in `clips/faces/<id>/`. Percezione è l'interfaccia e l'API sopra di essa, senza tenere una
seconda copia.
- L'**id** di una persona è il nome della cartella. È anche il nome negli eventi (`person.name`, il `sub_label` di
  Frigate).
- `train` non è una persona: contiene i tentativi di riconoscimento recenti di Frigate, da cui viene
  «Da nominare».

## Pagine

**Persone** (menu Configura): ogni persona con miniatura, numero di volti e «visto l'ultima volta», preso dalla
cronologia. C'è la ricerca per nome e si può aggiungere una persona, con nome e foto.

**Una persona**:
- i suoi volti, dal più recente;
- aggiungere foto: Frigate trova il volto in ogni foto e tiene solo il ritaglio. Le foto senza volto vengono
  rifiutate;
- un volto sbagliato si toglie, oppure si sposta su un'altra persona;
- rinominare. Gli eventi passati tengono il vecchio nome;
- unire a un'altra persona: tutti i volti passano a lei e la cartella sparisce;
- eliminare la persona con tutti i volti.

Con meno di 5 volti la pagina avvisa che il riconoscimento sarà incerto.

**Consigli**, dalla guida di Frigate, ripresi nella pagina:
- 5–10 foto frontali per cominciare, poi i volti visti dalle camere;
- niente foto sfocate, buie o all'infrarosso, né occhiali da sole o cappelli;
- evitare tante foto scattate nello stesso momento.

## Da nominare

Scheda **Da nominare** della pagina Persone, apribile anche con `/people?to-name`. Mostra i volti che Frigate ha
visto senza riconoscerli.
- Le schede vengono dai suoi tentativi in `train`, i cui file si chiamano `<evento>-<ora>-<ipotesi>-<punteggio>.webp`.
  Quanti tenerne si imposta in Persone → Riconoscimento (vedi sotto).
- Un passaggio è una scheda: un evento di Frigate segue una persona sola. La scheda dice dove e quando, e l'ipotesi
  di Frigate se c'è.
- Sono già scelti 3 volti, quelli col punteggio più alto, perché la guida di Frigate sconsiglia tanti volti simili
  insieme.
- **«È …»** con un nome nuovo o esistente (le maiuscole non contano): i volti scelti passano a quella persona, con
  `POST /api/faces/train/<id>/classify`.
- **«Scarta»** cancella i tentativi del passaggio: nessuno che conosci, o ritagli che non sono volti.
- I passaggi già riconosciuti con almeno il 90% sono nascosti, perché aggiungono poco e rischiano di sbilanciare la
  libreria. Un interruttore li mostra.

**Dove è stato visto un volto**, cercato in quest'ordine:
1. dalla cronologia, se il passaggio ha fatto un evento (`media.frigate_ids`);
2. dal registro delle tracce `data/tracks.jsonl`, scritto dal servizio per ogni traccia di persona vista su MQTT e
   tenuto 7 giorni;
3. dall'evento di Frigate.

Frigate non conserva gli eventi delle camere senza istantanee, e una persona non riconosciuta non produce eventi
di Percezione: per i tentativi più vecchi del registro la camera resta «non nota».

## Chi c'è a una camera

`who_is_at(camera)`: chi c'è adesso a una camera. Utile per un ingresso, vale per qualunque camera.

```json
{ "camera": "front_door", "place": "entrance", "time": "…",
  "people": [{ "name": "Alice", "confidence": 0.93 }],
  "unrecognized": 1,
  "unknown_faces": [{ "file": "…", "time": "…", "guess": "Dave", "score": 0.62 }] }
```

- `people` e `unrecognized` vengono dagli oggetti che Frigate sta seguendo su quella camera, cioè dall'ultimo
  `camera_activity` del suo WebSocket.
- `unknown_faces` sono i tentativi degli ultimi **2 minuti** sulle tracce di quella camera (ancora in vista, oppure
  trovate nel registro delle tracce). Sono esclusi quelli già riconosciuti con almeno il 90%.

Si chiede in tre modi:

| Dove | Come |
|---|---|
| MCP (agenti) | strumento `who_is_at {camera}`; aggiunge l'immagine della camera se è tra quelle permesse agli agenti. Con `faces: true` anche il volto migliore di ognuno, come immagini |
| API (interfaccia) | `GET /api/cameras/<camera>/who`, con `?photos=1` le foto |
| MQTT (Home Assistant, i dispositivi) | pubblica `{"camera": "…", "id": "…"}`, o solo il nome della camera, su `perception/who/request`; la risposta arriva su `perception/who/result` con lo stesso `id`. Con `"photos": true` le foto. Una camera sconosciuta risponde con `error` |

**Con le foto.** Chi chiede le foto riceve, per ogni persona, `face` (il suo volto migliore degli ultimi
`before_s` secondi, come l'ha ritagliato Frigate) e, con la memoria breve accesa, `photo` (il fotogramma intero di
quell'istante); `unknown_people` ha le stesse foto per chi è sulla camera principale senza nome. Entra anche chi Frigate
ha riconosciuto pochi secondi prima ma non segnala più in vista. Le foto si leggono con `GET /external/<file>` (token di
tipo **Dispositivo**; un token **Agente** solo per le camere con le immagini abilitate, [mcp.it.md](mcp.it.md)) o
`/api/external/<file>` dall'interfaccia, e restano 30 giorni. Senza `photos` la risposta non ha foto.

### Impostazioni del riconoscimento

Si impostano dalla UI e Percezione le scrive nella configurazione di Frigate, come zone e flussi; un cambio fatto
nella UI di Frigate torna in Percezione.

- **Persone → Riconoscimento** (globali): punteggio per un nome (`recognition_threshold`, default di Frigate 0,9),
  sconosciuto sotto (`unknown_score`, 0,8), tentativi recenti tenuti (`save_attempts`, 200; in RAM, vedi
  «Sguardo» più sotto). In `config.json` sono in `faces`.
- **Editor della camera → Volto minimo** (`face_min_area`, in px²; vuoto: il globale di Frigate, 750). Frigate fa al
  più 12 tentativi per persona senza nome: se i volti lontani o sfocati li consumano prima che la persona si avvicini,
  il volto minimo va alzato.

### Gruppi di camere

Un gruppo unisce camere che guardano lo stesso luogo da punti diversi. Per esempio «Ingresso» = la camera sulla
porta (principale) più una camera sul percorso per arrivarci, limitata alla zona del vialetto. Si configura in Camere → Gruppi di camere, oppure in
`config.json`:

```json
"groups": { "door": { "label": "Door", "main": "front_door", "members": { "yard": { "zones": ["path"] } },
            "window_s": 60 } }
```

`who_is_at` su un gruppo, per id o con la sua camera principale, risponde così:

```json
{ "camera": "front_door", "group": { "id": "door", "label": "Door", "cameras": ["front_door", "yard"] },
  "people": [{ "name": "Alice", "confidence": 0.93 },
             { "name": "Bob", "confidence": 0.9, "seen_by": "yard", "seen_at": "…" }],
  "unrecognized": 1, … }
```

- Le persone si contano sulla camera principale: `unrecognized` è solo di quella.
- Le altre camere aggiungono i nomi riconosciuti negli ultimi `window_s` secondi, nelle zone scelte (nessuna zona vuol
  dire tutta l'inquadratura). Questi nomi hanno `seen_by` e `seen_at`.
- Un nome con `seen_by` può essere una delle persone non riconosciute davanti alla camera principale, ma Percezione
  non sa dire quale.
- `unknown_faces` copre tutte le camere del gruppo.
- Una camera che è solo membro di un gruppo, chiesta da sola, risponde come una camera qualunque.
- API: `GET /api/groups/<id>/who`. MQTT e MCP accettano l'id del gruppo al posto della camera. Lo strumento MCP
  `cameras` dice il gruppo di ogni camera.

**Sguardo e foto migliore.** Un evento esterno ([external-events.it.md](external-events.it.md): uno squillo, una
chiamata…) guarda da `before_s` prima a `after_s` dopo (10 e 4 s di default, impostabili per camera nell'editor; un gruppo usa i tempi della sua camera principale): per
ogni persona prende il tentativo di Frigate col volto più grande e sicuro.

- Il riconoscimento resta di Frigate: il nome di ogni persona è il suo voto. Percezione sceglie solo la foto.
- Con la **memoria breve** accesa sulla camera (editor, spenta di default) Percezione tiene in RAM gli ultimi
  `before_s` secondi del flusso principale, letto da go2rtc a pezzi di ~2 s senza ricodificarlo, e ogni persona ha
  anche il fotogramma intero dell'istante del suo volto migliore. Spazio per camera: bitrate × (`before_s` + un
  pezzo), circa 6 MB a 4 Mbit/s con 10 s. Il tmpfs ha un tetto di 1 GB, che non viene riservato.
- L'orario del tentativo (Frigate) e quello dei pezzi (Percezione) possono differire di un secondo o due, e il
  fotogramma di quell'istante può mostrare la persona già girata. Percezione prova i fotogrammi vicini, dal più
  vicino (fino a ±2 s ogni mezzo secondo), e tiene il primo in cui Frigate trova il volto (con un nome, lo stesso).
  La foto dell'evento è una di queste; se in nessuno si vede un volto, resta quella dell'istante. Ogni scelta è nel
  log («best face of … frame at −1.5 s»), utile a misurare lo scarto.
- I tentativi di Frigate («da nominare») stanno anch'essi in RAM (quanti tenerne si imposta in Persone →
  Riconoscimento, 1000 nell'installazione nuova; tetto 256 MB): si perdono a ogni riavvio di Frigate. La libreria dei volti resta su disco.
- Su disco finiscono solo la foto e il volto di ogni persona, con l'evento.
- La memoria breve richiede una camera con il flusso in go2rtc.

Il nome riconosciuto è un'informazione, mai un permesso: non deve aprire nulla.

## Volti notturni

Di notte le camere riprendono in infrarosso, in bianco e nero. Frigate fa la media dei volti di una persona e scarta
quelli troppo lontani dalla media: un volto all'infrarosso in mezzo a foto a colori viene scartato, e la persona di
notte non viene riconosciuta. Una persona ben riconosciuta di giorno può scendere quasi a zero di notte, anche
con un suo volto notturno aggiunto.

Per questo ogni persona ha una seconda cartella in Frigate, `<id>~ir`, solo per i volti notturni. Frigate ne fa una
media a parte e riconosce di notte con quella.

- Percezione sceglie la cartella da sola guardando l'immagine: senza colore (`isInfrared`, lo scarto medio fra i
  canali di una copia piccola) è un volto notturno. Vale per le foto caricate e per i volti dati da «Da nominare».
- Si vede una persona sola: nell'elenco i volti notturni sono `~ir/<file>`, la pagina li segna «notte»; rinominare,
  unire, togliere e spostare valgono per tutte e due le cartelle.
- Ogni nome letto da Frigate perde il suffisso (eventi, `camera_activity`, tentativi, elenco dei nomi): negli eventi
  e in `who_is_at` c'è `Alice`, mai `Alice~ir`. Solo l'interfaccia di Frigate mostra il nome con il suffisso.
- `~` non è ammesso nel nome di una persona, quindi non si confonde con nessuno.

## API (dietro il login dell'interfaccia)

| Metodo e percorso | Cosa fa | Frigate 0.18 |
|---|---|---|
| `GET /api/people` | `[{ id, faces, last_seen }]` | `GET /api/faces` |
| `POST /api/people` `{name}` | Crea la persona | `POST /api/faces/<id>/create` |
| `PUT /api/people/<id>` `{name}` | Rinomina | `PUT /api/faces/<id>/rename` |
| `DELETE /api/people/<id>` | Elimina con tutti i volti | `POST /api/faces/<id>/delete` |
| `POST /api/people/<id>/merge` `{into}` | Unisce | `reclassify` per volto |
| `POST /api/people/<id>/faces` (multipart `file`) | Aggiunge una foto | `POST /api/faces/<id>/register` |
| `DELETE /api/people/<id>/faces/<file>` | Toglie un volto | `POST /api/faces/<id>/delete` |
| `POST /api/people/<id>/faces/<file>/move` `{to}` | Sposta un volto | `POST /api/faces/<id>/reclassify` |
| `GET /api/people/<id>/faces/<file>` | L'immagine | `/clips/faces/<id>/<file>` |
| `GET /api/people/unknown[?all=1]` | I passaggi da nominare | `GET /api/faces` (`train`) |
| `POST /api/people/unknown/assign` `{files, to}` | Nomina i volti scelti | `POST /api/faces/train/<id>/classify` |
| `POST /api/people/unknown/discard` `{files}` | Scarta | `POST /api/faces/train/delete` |

I nomi accettati sono lettere, cifre, spazi, `'` e `-`, al massimo 50 caratteri. Gli spazi diventano `_`;
`train` e `unknown` sono di Frigate.

## API di import (con un token, per altri programmi)
Per i programmi che hanno già i volti delle persone, per esempio un archivio di foto che riconosce i volti. Usano un
token di tipo **Dispositivo** (pagina Agenti), nell'intestazione `Authorization: Bearer <token>`. Un token **Agente**
può solo leggere l'elenco (`GET /people`): creare persone o aggiungere volti risponde 403.

| Metodo e percorso | Cosa fa |
|---|---|
| `GET /people` | `[{ id, faces }]`: i nomi e quanti volti ha ciascuno |
| `POST /people` `{name}` | Crea la persona: 201 `{id}`, oppure 409 con l'`id` di chi c'è già (senza distinguere maiuscole) |
| `POST /people/<id>/faces` (multipart `file`, al massimo 10 MB) | Aggiunge una foto a una persona che esiste: `{added, night}` |

Regole:
- **Una foto non crea mai una persona.** Se la persona non esiste la risposta è 404, così un nome sbagliato nel
  programma non riempie l'elenco: si crea con `POST /people`, apposta.
- **La stessa foto si importa una volta.** Percezione ricorda l'impronta (sha256) di ogni foto importata in
  `data/people-imports.json`: se la stessa foto arriva di nuovo risponde `added: false` e non la passa a Frigate. Il
  programma può quindi rimandare tutto a ogni sincronizzazione. Se la persona viene eliminata, le sue impronte si
  dimenticano e le stesse foto possono tornare.
- **Volti notturni:** una foto all'infrarosso va da sola nella parte notturna della persona (`night: true`).
- **Errori:** una foto senza un volto riconoscibile risponde 422 con il messaggio di Frigate («No face was
  detected»). Un Frigate appena installato rifiuta tutto finché non ha caricato i modelli dei volti ([backup.it.md](backup.it.md)).

```sh
curl -H "Authorization: Bearer $TOKEN" http://<percezione>:8090/people
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"name":"Alice"}' http://<percezione>:8090/people
curl -H "Authorization: Bearer $TOKEN" -F file=@alice.jpg http://<percezione>:8090/people/Alice/faces
```

## Da sapere su Frigate 0.18

- Il proxy di Frigate tiene in cache per 5 secondi le risposte `GET` dell'API: l'elenco si legge con un parametro
  che la scavalca, altrimenti dopo una modifica si vedrebbe quello vecchio.
- Ogni modifica fa ricostruire a Frigate il classificatore dai file, al volto successivo.
- Non chiamare l'API dei volti nei primi ~30 s dopo l'avvio di Frigate: una richiesta durante
  l'avvio può bloccare il processo degli embeddings fino al riavvio.
