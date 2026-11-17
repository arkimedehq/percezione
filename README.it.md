# Percezione

**Chi è in casa, dove, e cosa sta facendo: dalle tue camere, sul tuo computer.**

*[English](README.md)*

Percezione trasforma le camere IP in eventi sulle persone: chi è arrivato, chi è uscito, chi è alla porta, cosa fa
qualcuno in una stanza, quando qualcuno passa fuori o lascia un pacco al cancello. Gira in locale sopra
[Frigate](https://frigate.video) e [go2rtc](https://github.com/AlexxIT/go2rtc). Manda quello che vede a Home
Assistant, MQTT, webhook o agenti AI (MCP), e si configura interamente dalla sua interfaccia web.

## Indice

1. [Cosa fa](#cosa-fa)
2. [Come si compone](#come-si-compone)
3. [Arkimede e Recordare](#arkimede-e-recordare)
4. [Requisiti](#requisiti)
5. [Installazione](#installazione)
6. [Primo avvio](#primo-avvio)
7. [Configurazione](#configurazione)
8. [Collegare altri sistemi](#collegare-altri-sistemi)
9. [Aggiornamenti e backup](#aggiornamenti-e-backup)
10. [Sicurezza](#sicurezza)
11. [Documentazione](#documentazione)
12. [Sviluppo](#sviluppo)
13. [Licenza](#licenza)

## Cosa fa

- **Camere:** si aggiungono dall'interfaccia (un indirizzo RTSP, o importate da un go2rtc che hai già). Una sola
  connessione per camera, condivisa da rilevamento, video dal vivo e, se vuoi, altre app.
- **Persone:** una persona è un nome con qualche foto del volto. I volti visti dalle camere e non riconosciuti
  aspettano in «Da nominare»; dargli un nome insegna al sistema. I volti notturni (infrarosso) stanno a parte, così il
  riconoscimento funziona anche al buio.
- **Eventi** (schema v3):

  | Evento | Quando |
  |---|---|
  | `arrived`, `left` | Una persona entra in un luogo o ne esce |
  | `activity_changed` | Cambia quello che una persona sta facendo (modello visione-linguaggio facoltativo) |
  | `posture_changed` | In piedi, seduto, sdraiato, a terra (modello di postura facoltativo) |
  | `passage`, `approach` | Qualcuno passa fuori, o arriva all'ingresso |
  | `object_left` | Qualcosa viene lasciato in una zona (un pacco, i bidoni) |
  | `external` | Un dispositivo dice che è successo qualcosa davanti a una camera (uno squillo, una chiamata, un cancello aperto) |

- **Gruppi di camere e memoria breve:** le camere che guardano lo stesso luogo da punti diversi rispondono insieme.
  Quando un dispositivo segnala un evento esterno, Percezione guarda i secondi prima e dopo e restituisce, per ogni
  persona, il fotogramma in cui il suo volto si vedeva meglio.
- **Regole:** decidono quali eventi contano, quando e per chi. Le reazioni sono: notifica, memoria, annuncio a voce,
  Home Assistant, webhook.
- **Uscite:** MQTT con il discovery di Home Assistant, webhook firmati con una coda su disco perché non si perda
  nulla, eventi in diretta via SSE (`/events`) e un server MCP per gli agenti, con strumenti in sola lettura:
  `who_is_where`, `who_is_at`, `events`, `people`, `cameras`, `camera_snapshot`.
- **Chiedere chi c'è:** `who_is_at(camera o gruppo)` via MCP, HTTP o MQTT, con il volto di ognuno se richiesto.
- **Backup e ripristino** di configurazione, persone e volti in un solo file.

Percezione riconosce, non agisce mai. Aprire porte o altre azioni fisiche restano alla tua domotica. Un nome
riconosciuto è un'informazione, mai un permesso.

## Come si compone

```
camere ──RTSP──▶ go2rtc ──▶ Frigate (rilevamento, tracking, volti) ──MQTT──▶ Percezione ──▶ MQTT / Home Assistant
                   │                                                          │          ──▶ webhook, /events (SSE)
                   └──────────── video dal vivo, altre app (facoltativo) ◀────┘          ──▶ MCP (agenti)
                                                  facoltativi: Ollama (attività), onnx-runner (postura, oggetti)
```

Tutto gira con Docker Compose:

| Servizio | Ruolo |
|---|---|
| `percezione` | Il servizio e la sua interfaccia web (porta 8090), l'interfaccia di Frigate dietro il suo login (porta 8091) |
| `go2rtc` | Una connessione per camera; il video per Frigate, la vista dal vivo e le altre app |
| `frigate` | Rilevamento, tracking e riconoscimento dei volti |
| `mosquitto` | Broker MQTT, raggiungibile solo dentro Compose (puoi usarne uno tuo) |
| `setup` | Gira una volta a ogni avvio: crea i segreti e la configurazione di base, non sovrascrive mai |
| `ollama` (profilo `vlm`) | Il modello visione-linguaggio per le attività |
| `onnx-runner` (profilo `pose`) | Postura (RTMPose) e classificazione degli oggetti lasciati (CLIP) |

## Arkimede e Recordare

Percezione funziona da sola, con Home Assistant, MQTT o qualunque client MCP. È nata come gli occhi di una famiglia
di tre progetti self-hosted che danno il meglio insieme:

| Progetto | Ruolo |
|---|---|
| **Percezione** (questo) | **Vede:** chi è in casa, dove, cosa sta facendo, chi è alla porta |
| [**Arkimede**](https://github.com/arkimedehq/arkimede) | **Agisce:** la piattaforma degli agenti AI. Il suo plugin di Percezione segue gli eventi in diretta, avvisa la persona giusta, parla in una stanza e risponde «chi c'è alla porta?» con il volto |
| [**Recordare**](https://github.com/arkimedehq/recordare) | **Ricorda:** la memoria a lungo termine di ogni persona. Quello che le camere hanno visto diventa una *percezione*, ricordata come vista e lasciata sbiadire; una presenza dice alla memoria che qualcuno c'è, il momento giusto per ricordargli qualcosa |

Insieme: una camera vede Laura tornare a casa, Arkimede la saluta in cucina e le ricorda cosa aveva in programma per
la sera, e più tardi lei può chiedere «chi ha suonato mentre ero fuori?». Ogni progetto funziona da solo; nessuno ha
bisogno degli altri. Configurazione: [docs/arkimede-plugin.it.md](docs/arkimede-plugin.it.md).

## Requisiti

- **Macchina:** Linux su x86-64 o ARM64, sempre accesa. 4 GB di RAM per qualche camera sulla CPU; 16 GB o più con il
  modello delle attività. Un SSD per il sistema.
- **Software:** Docker Engine con il plugin Compose ([guida](https://docs.docker.com/engine/install/); non il
  pacchetto snap).
- **Camere:** camere IP con uno stream RTSP, con indirizzo, utente e password. Un secondo stream più leggero è utile
  per le anteprime.
- **Facoltativi:** un acceleratore (GPU NVIDIA, GPU o NPU Intel, Google Coral), una GPU con almeno 8 GB per il
  modello delle attività, un broker MQTT tuo (per esempio quello di Home Assistant).

## Installazione

```sh
git clone https://github.com/arkimedehq/percezione.git
cd percezione/deploy
cp .env.example .env      # facoltativo: fuso orario, porte, un broker tuo
docker compose up -d
docker compose logs -f setup percezione
```

Non serve configurare nulla prima. Al primo avvio il servizio `setup` crea le password tra i servizi (in
`deploy/data/secrets`, leggibili solo dal proprietario) e la configurazione di base di Frigate, go2rtc e Mosquitto.
Imposta `TZ` in `.env` (per esempio `TZ=Europe/Rome`) perché gli orari degli eventi siano locali.

### Hardware

Il rilevamento gira sulla CPU di default. Per usare un acceleratore aggiungi il suo file:

| Hardware | Comando | Note |
|---|---|---|
| CPU | `docker compose up -d` | Va bene per 1–3 camere a 5 fps |
| GPU NVIDIA | `docker compose -f docker-compose.yml -f hardware/nvidia.yml up -d` | Servono il driver NVIDIA e il Container Toolkit. Il primo avvio esporta un modello YOLOv9 sulla tua macchina (qualche minuto) |
| GPU / NPU Intel | `docker compose -f docker-compose.yml -f hardware/intel.yml up -d` | OpenVINO, Intel dalla 6ª generazione in poi |
| Google Coral | `docker compose -f docker-compose.yml -f hardware/coral.yml up -d` | USB di default; PCIe nel file |
| GPU integrata Intel + NVIDIA | `docker compose -f docker-compose.yml -f hardware/intel.yml -f hardware/ollama-nvidia.yml --profile vlm up -d` | Frigate sulla GPU Intel, tutta la scheda NVIDIA per il modello visione-linguaggio |

### Parti facoltative

```sh
docker compose --profile vlm up -d    # Ollama: attività (mangia, legge, al computer…)
docker compose --profile pose up -d   # onnx-runner: postura, cadute (a terra)
```

- **Attività:** Ollama parte senza modelli; Percezione scarica da sola quello impostato (circa 3 GB per
  `qwen3-vl:4b-instruct`, il default; `qwen3-vl:8b-instruct` è più preciso con 8 GB di memoria sulla GPU). La pagina
  **Analizzatori** mostra l'avanzamento; le attività partono quando finisce.
- **Oggetti lasciati:** serve anche CLIP: metti `ONNX_MODELS=pose clip` in `.env` prima di avviare il profilo `pose`.

File dell'hardware e profili si combinano: usa le stesse opzioni `-f` e `--profile` ogni volta che lanci
`docker compose`.

### Porte

| Porta | Cosa |
|---|---|
| 8090 | Percezione: interfaccia e API |
| 8091 | L'interfaccia di Frigate, dietro il login di Percezione |
| 8554, 8555 | RTSP e WebRTC delle camere per le altre app, solo con la condivisione accesa |

L'API di Frigate, l'API di go2rtc e Mosquitto non sono esposte. La guida completa copre i prerequisiti per ogni
hardware, un broker tuo, gli aggiornamenti, i problemi frequenti e la disinstallazione:
[docs/install.it.md](docs/install.it.md).

## Primo avvio

1. **Password:** apri `http://<questa macchina>:8090` e scegli la password (almeno 8 caratteri). La sceglie chi apre
   la pagina per primo, quindi fallo subito dopo l'installazione.
2. **Camere → Aggiungi camera:** l'indirizzo RTSP della camera (la password si chiede a parte e non si mostra più),
   una prova dello stream, poi un nome, un luogo (la stanza) e un tipo: interna o esterna.
3. **Modifica la camera:** disegna le zone che contano (il divano, l'ingresso) e le maschere per ciò che si muove ma
   non interessa (l'orologio della camera, gli alberi), poi scegli cosa osservare.
4. **Persone:** crea le persone di casa, con 5–10 foto nitide e frontali ciascuna. Al primo avvio Frigate scarica i
   suoi modelli dei volti (circa 320 MB): fino ad allora ogni foto è rifiutata con «No face was detected»; aspetta
   qualche minuto e riprova.
5. **Regole** e **Uscite:** scegli di cosa vuoi essere avvisato, e dove.

Una guida nella Home accompagna questi passi, e ogni pagina ha il suo aiuto (il pulsante **?**).

## Configurazione

Ogni opzione si imposta dall'interfaccia. `.env` contiene solo porte, indirizzi e hardware; i segreti li crea
`setup`. Ogni modifica salvata è una nuova versione di `data/config.json` (pagina **Versioni**: confronta, ripristina).
Le sezioni seguono il menu.

### Sorgenti video

Gli indirizzi delle camere, aperti una sola volta dal go2rtc di Percezione e condivisi da tutto il resto. Ogni
sorgente ha uno stream principale e, se la camera ce l'ha, uno leggero per le anteprime. **Importa da go2rtc** porta
dentro gli stream di un go2rtc che hai già. Le password delle camere stanno a parte (un file leggibile solo dal
servizio), non vanno mai al browser né nei log; gli indirizzi contengono solo l'utente.

### Camere

Ogni camera legge una sorgente e ha un **luogo** (la stanza o l'area a cui appartiene) e un **tipo**:
- **interna:** presenza, attività e postura delle persone nella stanza;
- **esterna:** passanti, persone che si avvicinano all'ingresso, oggetti lasciati.

Nell'editor della camera:

| Impostazione | Cosa fa |
|---|---|
| **Zone** e **maschere** | Le zone sono aree che contano (un ingresso, il divano, una zona di riposo per la postura); le maschere nascondono ciò che si muove ma non interessa |
| **Osservazioni → Presenza** | Chi c'è nel luogo: eventi `arrived` e `left`, le entità «Who is in» in Home Assistant |
| **Osservazioni → Attività** | Ogni pochi secondi il modello visione-linguaggio risponde a domande sì/no su chi è riconosciuto; l'attività cambia solo quando le risposte restano uguali per «Stabile dopo» (serve il profilo `vlm`) |
| **Osservazioni → Postura** | In piedi, seduto, sdraiato; sdraiato fuori dalle zone di riposo diventa «a terra» (serve il profilo `pose`) |
| **Osservazioni → Passaggi** e **Avvicinamento** | Fuori: qualcuno che passa, unito tra le camere dello stesso gruppo; qualcuno che arriva in una zona d'ingresso |
| **Osservazioni → Oggetti lasciati** | Un cambiamento in una zona che dura mentre non c'è nessuno, classificato da CLIP (un pacco, i bidoni) |
| **Volto minimo (px²)** | Frigate ignora su questa camera i volti più piccoli di quest'area |
| **Memoria breve**, **Sguardo prima / dopo** | Per gli eventi esterni: gli ultimi secondi di video tenuti in RAM, mai su disco, così ogni persona ha il fotogramma col volto migliore |
| **Decodifica del video** | Automatica (la GPU, se c'è) o CPU, per una camera il cui video la GPU non sa decodificare |

L'interruttore di una camera la spegne: Frigate smette di leggerla, le impostazioni restano. Le domande a cui risponde
il modello e le attività che ne derivano sono comuni a tutte le camere (scheda **Attività (VLM)**, «Domande e
attività»).

### Gruppi di camere

**Camere → Gruppi di camere.** Un gruppo unisce camere che guardano lo stesso luogo da punti diversi, per esempio la
camera di un campanello (la principale) e una camera del cortile limitata alla zona del vialetto. Quando si chiede chi
c'è al gruppo, o arriva un evento esterno sulla camera principale, Percezione conta le persone sulla camera
principale e aggiunge i nomi riconosciuti dalle altre camere negli ultimi secondi («Alice, vista da cortile»). Le
richieste possono indicare il gruppo con il suo id o con la sua camera principale.

### Persone

Una persona è un nome e qualche foto del volto; il riconoscimento è di Frigate. Comincia con 5–10 foto nitide, poi
aggiungi i volti visti dalle camere: la loro luce e il loro angolo aiutano più di tutto.
- **Da nominare:** i volti visti dalle camere e non riconosciuti, raggruppati per passaggio. Dagli un nome, o scarta i
  passaggi senza nessuno che conosci.
- **Volti notturni:** i volti in infrarosso (bianco e nero) stanno in una classe a parte, segnati «notte»; aggiungine
  qualcuno per chi entra ed esce col buio.
- **Riconoscimento:** le soglie di Frigate, per tutte le camere (il volto minimo si imposta per camera).
- **API di import:** altri programmi (un archivio di foto) possono aggiungere persone e volti con un token:
  [docs/people.it.md](docs/people.it.md).

### Regole

Una regola dice **quando** (evento, persona, luogo, fascia oraria) e **cosa fare** (una o più reazioni). Ogni regola
attiva si controlla su ogni evento; se due regole chiedono la stessa reazione, avviene una volta sola. Senza regole
gli eventi si registrano comunque e si vedono in **Live**.

| Reazione | Cosa succede |
|---|---|
| Notifica | L'assistente collegato avvisa qualcuno (una persona, o `family` per tutta la casa): un messaggio, una voce, una notifica; anche con l'immagine della camera |
| Memoria | L'assistente conserva l'evento, così puoi chiederlo dopo |
| Annuncio a voce | L'assistente lo dice ad alta voce in una stanza |
| Home Assistant | Un evento sull'entità `Percezione rule`, con l'id della regola come tipo, per le tue automazioni |
| Webhook | Un POST firmato a uno degli indirizzi impostati in **Uscite** |

Notifica, memoria e annuncio a voce li esegue un assistente che segue gli eventi di Percezione, come Arkimede con il
suo plugin. Dettagli: [docs/events.it.md](docs/events.it.md).

### Uscite

| Uscita | Cosa fa |
|---|---|
| **MQTT** | Ogni evento su `perception/events` (schema v3), per qualunque piattaforma. Sempre acceso |
| **Home Assistant** | Entità create con il discovery MQTT nel dispositivo «Percezione»: «Who is in …» e «… occupied» per ogni luogo che osserva la presenza (attività e postura negli attributi), «Percezione rule», «Last event» e, con **Foto degli eventi esterni** accese, «Last <tipo>» con la foto dell'ultimo evento esterno di ogni tipo |
| **Webhook** | Un POST firmato (HMAC) al tuo indirizzo per le regole con la reazione webhook; ogni destinazione ha la sua coda su disco e riprova in ordine |
| **Flussi video** | Con la condivisione accesa, le altre app (un pannello, Home Assistant, VLC) aprono ogni camera in RTSP, MP4 o WebRTC con il login di go2rtc |

Dettagli: [docs/outputs.it.md](docs/outputs.it.md).

### Agenti

**Agenti** crea un token per ogni client, di uno di due tipi:

| Tipo | Per | Può |
|---|---|---|
| **Agente** | Assistenti AI (Arkimede, Claude…) | MCP (`http://<host>:8090/mcp`), eventi in diretta (`/events`, Server-Sent Events, con il recupero dopo un riavvio); leggere eventi esterni e persone. Immagini solo delle camere abilitate in **Immagini delle camere**, anche negli eventi |
| **Dispositivo** | Un pannello a parete, un campanello, un archivio di foto | Segnalare eventi esterni e riceverne le foto (`/external`), aggiungere persone e volti (`/people`), eventi in diretta; niente MCP |

I token si mostrano una volta sola e si revocano uno per uno; gli agenti non cambiano mai nulla. Con Claude Code:

```sh
claude mcp add --transport http percezione http://<host>:8090/mcp --header "Authorization: Bearer <token>"
```

Dettagli: [docs/mcp.it.md](docs/mcp.it.md), [docs/live-events.it.md](docs/live-events.it.md).

### Analizzatori

Il modello visione-linguaggio (VLM) gira in Ollama e risponde alle domande sulle attività; il modello si sceglie
nell'editor di una camera, scheda **Attività (VLM)**, e Percezione lo scarica da sola in Ollama. L'onnx-runner serve il modello di postura e CLIP; puoi caricare altri
modelli ONNX con la loro descrizione. La pagina mostra se ogni analizzatore risponde, i suoi modelli e il tempo medio
per chiamata. Dettagli: [docs/analyzers.it.md](docs/analyzers.it.md).

### Regolazioni

Tempi della presenza, soglie delle attività, l'immagine mandata al VLM e ogni quanto Percezione parla con Frigate. Un
campo vuoto usa il valore di default; le modifiche valgono subito.

### Utilizzo

Spazio su disco e memoria di ogni parte, i processi e il **Backup**: scarica un solo file con la configurazione, le
persone con i loro volti e i token (le password delle camere solo se lo chiedi), oppure ripristinane uno.

## Collegare altri sistemi

- **Home Assistant:** usa il Mosquitto di Home Assistant come broker ([docs/install.it.md](docs/install.it.md), «Un
  broker tuo») e accendi **Uscite → Home Assistant**. Le entità compaiono da sole; le regole con la reazione Home
  Assistant fanno scattare l'evento `Percezione rule` per le automazioni.
- **Dispositivi ed eventi esterni:** un campanello, un videocitofono o un cancello dicono a Percezione che è successo
  qualcosa davanti a una camera con `{"kind": "ring", "camera": "front_door", "id": "…"}` sul topic MQTT
  `perception/external`, oppure con `POST /external` e un token. La risposta arriva su `perception/external/result`:
  subito con i nomi, qualche secondo dopo con il volto migliore di ognuno. `kind` è libero: ring, call, gate_open…
  Dettagli: [docs/external-events.it.md](docs/external-events.it.md).
- **Chi c'è adesso:** `{"camera": "front_door", "id": "…", "photos": true}` su `perception/who/request`, risposta su
  `perception/who/result`; lo stesso via MCP (`who_is_at`).
- **Agenti AI:** qualunque client MCP con un token da **Agenti**. Il plugin per Arkimede è in `integrations/arkimede`
  ([docs/arkimede-plugin.it.md](docs/arkimede-plugin.it.md)).
- **Scrivere un client** (un pannello a parete, automazioni di Home Assistant): prompt pronti in
  [docs/client-prompts.it.md](docs/client-prompts.it.md).

## Aggiornamenti e backup

1. Prima scarica un backup: **Utilizzo → Backup**.
2. Aggiorna:
   ```sh
   cd percezione/deploy
   git pull
   docker compose pull
   docker compose up -d      # con le stesse opzioni -f e --profile di prima
   ```

Ripristinare un backup su una nuova installazione riporta configurazione, persone, volti e token; Percezione si
riavvia da sola. Dettagli: [docs/backup.it.md](docs/backup.it.md).

## Sicurezza

- **Interfaccia:** dietro una password, scelta al primo avvio e salvata come hash scrypt. Le sessioni sono cookie
  (`HttpOnly`, `SameSite=Strict`).
- **Login:** dopo due password sbagliate ogni tentativo aspetta di più (fino a un minuto), per tutti insieme.
  L'interfaccia risponde solo agli indirizzi e ai nomi locali (protezione dal DNS rebinding): per aprirla con un nome
  del tuo dominio aggiungilo a `PERCEZIONE_HOSTS` in `.env`. Le modifiche si accettano solo dalle pagine di Percezione.
- **Agenti e dispositivi:** token separati, creati dall'interfaccia e revocabili. Un token agente non vede mai le
  immagini delle camere che non hai abilitato; un token dispositivo non ha l'MCP. Il testo che mandano i dispositivi
  (l'etichetta di un evento) è limitato a un nome breve, così non può portare istruzioni a un agente.
- **Password delle camere:** mai mandate al browser né scritte nei log. Stanno in un file a parte, con permessi 600.
- **Rete:** l'API di Frigate, l'API di go2rtc e Mosquitto sono raggiungibili solo dentro la rete di Compose.
  L'interfaccia di Frigate si vede attraverso il login di Percezione e dà pieno controllo di Frigate, configurazione
  compresa. Il Mosquitto incluso fa scrivere a Frigate solo `frigate/#` e a Percezione solo i suoi topic.
- **Condivisione dei flussi:** il login di go2rtc mostrato in **Uscite → Flussi video** controlla anche go2rtc: con
  `share.yml` (porta 1984) chi lo ha può cambiare o togliere le sorgenti delle camere. Dallo solo a dispositivi fidati.
- **Un broker tuo:** sul broker di Home Assistant qualunque utente MQTT può pubblicare su `frigate/events` e
  `perception/external`, quindi da lì sono possibili eventi finti. Tieni i suoi utenti a chi ti fidi.
- **Solo LAN:** Percezione è pensata per la rete di casa. Non esporla su internet; per raggiungerla da fuori usa una
  VPN.
- **Privacy:** immagini, volti ed eventi restano sulla tua macchina. Le foto degli eventi esterni si tengono 30 giorni.

## Documentazione

| Documento | Di cosa parla |
|---|---|
| [install.it.md](docs/install.it.md) | Installazione, hardware, broker, porte, aggiornamenti, problemi frequenti |
| [events.it.md](docs/events.it.md) | Tipi di evento, schema v3, regole e reazioni |
| [people.it.md](docs/people.it.md) | Persone, volti, volti notturni, «Da nominare», API di import |
| [external-events.it.md](docs/external-events.it.md) | Eventi esterni, gruppi di camere, memoria breve, chi c'è |
| [outputs.it.md](docs/outputs.it.md) | MQTT, Home Assistant, webhook, flussi video |
| [mcp.it.md](docs/mcp.it.md) | Il server MCP e i suoi strumenti |
| [live-events.it.md](docs/live-events.it.md) | Eventi in diretta via SSE |
| [analyzers.it.md](docs/analyzers.it.md) | Il VLM, l'onnx-runner, le descrizioni dei modelli |
| [backup.it.md](docs/backup.it.md) | Backup e ripristino |
| [arkimede-plugin.it.md](docs/arkimede-plugin.it.md) | Il plugin per Arkimede |
| [client-prompts.it.md](docs/client-prompts.it.md) | Prompt per scrivere un pannello o automazioni di Home Assistant |

Ogni documento ha la versione inglese accanto (stesso nome senza `.it`).

## Sviluppo

```sh
cd perception-service && npm ci && npm test        # servizio (Node 24, TypeScript)
cd frontend && npm ci && npm run dev                # interfaccia (React, Vite), su un servizio avviato
cd analyzers/onnx-runner && uv run pytest           # runner della postura (Python)
docker build --target test .                        # i test dentro l'immagine
```

Codice, identificatori e commenti sono in inglese; i nomi dei test in inglese e italiano. L'interfaccia è tradotta in
inglese e italiano (`frontend/src/i18n`).

## Licenza

[MIT](LICENSE).

Percezione si appoggia ad altri progetti, ognuno con la sua licenza:
- Frigate (MIT), go2rtc (MIT) ed Eclipse Mosquitto (EPL-2.0 / EDL-1.0) girano con le loro immagini;
- Ollama (MIT) gira con la sua immagine;
- RTMPose (Apache-2.0) e CLIP (MIT) si scaricano al primo avvio del profilo `pose`;
- YOLOv9 (GPL-3.0) è esportato sulla tua macchina dal profilo NVIDIA e non è mai distribuito con Percezione.
