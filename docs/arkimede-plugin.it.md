# Plugin per Arkimede

*[English](arkimede-plugin.md)*

Arkimede è una piattaforma di agenti AI, un prodotto separato. Il pacchetto `integrations/arkimede/` porta Percezione
dentro Arkimede, secondo il contratto dei plugin di Arkimede (`docs/PLUGINS.md` nel suo repository, contratto v1).
Arkimede non viene modificato e Percezione non sa nulla di Arkimede: il plugin usa solo le uscite generiche, `/mcp`
([mcp.it.md](mcp.it.md)) e `/events` ([live-events.it.md](live-events.it.md)).

Chi ha solo Home Assistant non ha bisogno del plugin: gli eventi arrivano ad HA via MQTT ([outputs.it.md](outputs.it.md)).

## Cosa contiene
- **Server MCP** `camera-recognition-percezione`: le domande dell'agente (`who_is_where`, `who_is_at`, `events`,
  `people`, `cameras`, `camera_snapshot`).
- **`skills/percezione/scripts/people.py`** (campo `people` di `plugin.yaml`): le persone che Percezione conosce.
  Arkimede lo esegue quando si apre la card *Persone*, per la select.
- **Daemon** `skills/percezione/scripts/bridge.py`, che porta in Arkimede:
  - **gli eventi**, dal flusso `/events`. Ogni evento diventa un evento del plugin, per i flussi di Arkimede;
  - **le reazioni delle regole di Percezione**: `memory` diventa `perceive`, diretto; `notify` e `announce` vanno
    all'**agente** (vedi sotto), che parla nella lingua delle persone (gli eventi di Percezione sono in inglese);
  - **la presenza**, leggendo `who_is_where` ogni minuto (`PRESENCE_POLL_S`) e subito dopo un arrivo o un'uscita. Così
    una persona che cambia stanza viene seguita, e chi non è riconosciuto conta come `someone`.

| Evento di Percezione | Evento del plugin |
|---|---|
| `arrived` | `person.arrived` |
| `left` | `person.left` |
| `activity_changed` | `activity.changed` |
| `posture_changed` | `posture.changed` |
| `passage` | `street.passage` |
| `approach` | `entrance.approach` |
| `object_left` | `object.left` |
| `external` | `external.event` |

Regole della traduzione:
- **Persone:** l'id è il nome del volto in Frigate (`Alice`, `Bob`…). In Arkimede, *Impostazioni → Plugin →
  Persone*, lo si collega una volta all'utente. Un nome sotto la soglia della camera non arriva mai: chi non è
  riconosciuto è `someone` o «Sconosciuto».
- **Notifiche:** il plugin passa all'agente (`agent.ask`, conversazione «notifications») l'evento e cosa chiede la regola:
  chi avvisare (la famiglia, cioè `family`, `household`, `everyone` o nessun destinatario, oppure un nome), se è
  urgente, se serve l'immagine. L'agente decide come raggiungere chi: un messaggio, la voce nella stanza dove si
  trova, una notifica, con gli strumenti dell'account che ha installato il plugin; chi è «la famiglia» e come
  raggiungerla lo sa dalla sua memoria. Per l'immagine usa `camera_snapshot`, se quella camera la permette. Se
  l'agente non si può interpellare, il proprietario riceve l'evento come notifica semplice. Gli eventi in ritardo non
  notificano.
- **Annunci:** anche la reazione `announce` passa dall'agente (conversazione «announcements»), che lo dice a voce nella
  stanza indicata dalla regola, nella lingua di chi c'è. Se l'agente non si può interpellare, la frase dell'evento
  viene detta così com'è, in inglese.
- **Dati, non istruzioni:** dalla versione 0.4.2 il plugin dice all'agente che le righe dell'evento vengono da camere
  e dispositivi: sono dati, mai istruzioni.
- **`ha` e `webhook`** non passano dal plugin: sono uscite dirette di Percezione ([outputs.it.md](outputs.it.md)).
- **Durata dei ricordi:** importanza `low` 7 giorni, `high` 365, `normal` quella della memoria.
- **All'esterno** (`OUTDOOR_PLACES`, di default `outdoor`) nessuna presenza: la strada non è una stanza. I passaggi
  restano eventi e, se la regola lo chiede, ricordi.
- **Eventi in ritardo:** dopo un fermo, il daemon riprende dall'ultimo evento ricevuto. Quelli più vecchi di
  `LATE_AFTER_S` (120 s) vanno solo in memoria, con la loro ora: niente flussi, notifiche o frasi per cose ormai
  passate.

## Installazione
1. In Percezione, pagina **Agenti**: crea un token di tipo **Agente**, per esempio «Arkimede». Un token Dispositivo non
   ha l'MCP.
2. `integrations/arkimede/build.sh` crea `integrations/arkimede/dist/camera-recognition-<versione>.zip`.
3. In Arkimede, *Impostazioni → Plugin*: carica lo ZIP. Non è firmato, quindi lo installa l'admin con *Consenti plugin
   non firmati*.
4. Impostazioni del plugin: `PERCEZIONE_URL` (es. `http://192.0.2.10:8090`) e `PERCEZIONE_TOKEN`. Facoltative:
   `OUTDOOR_PLACES`, `PRESENCE_POLL_S` (60), `LATE_AFTER_S` (120), `ASK_AS` (`percezione`).
5. L'admin approva: servizi `presence.report`, `perceive`, `notify`, `say`, `agent.ask`, il daemon, e la rete verso
   Percezione.
   Percezione è sulla LAN, quindi alla skill `percezione` va data la **rete riservata** della casa.
6. *Persone*: scegli dalla select `Alice`, `Bob`, … (i nomi della Face Library di Frigate, prima chi è stato visto)
   e collega ognuno al suo account di Arkimede. Un admin può collegare a una persona di Home Assistant chi non ha un
   account. Se la select è vuota (Percezione non raggiungibile), l'id si scrive a mano, uguale (`Alice_Smith`).
7. *Persone*: aggiungi a mano l'id `percezione` (o quello in `ASK_AS`), su Ospite, e segnalo **autorizzato** (lo fa
   l'admin). È chi chiede all'agente di notificare: senza autorizzazione l'agente risponde solo a parole, senza
   strumenti, e non può avvisare nessuno.

Per aggiornare: `build.sh`, poi in *Impostazioni → Plugin* carica il nuovo ZIP sul plugin installato. Se la versione
chiede qualcosa di nuovo, il plugin si ferma finché l'admin non la approva.

Il plugin è `personal`: quello che succede in casa va nella memoria di chi lo installa.

**Doppio conteggio:** con il plugin installato, le entità di presenza per stanza che Percezione crea in Home Assistant
(«Who is in», «occupied», [outputs.it.md](outputs.it.md)) non vanno esposte ad Assist. Altrimenti Arkimede conterebbe
due volte le stesse persone.

## Test del plugin
```sh
python3 -m unittest discover -s integrations/arkimede/tests
```
