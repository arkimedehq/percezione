# Installare Percezione

*[English](install.md)*

## 1. Cosa serve

- **Macchina:** Linux su x86-64 o ARM64, sempre accesa. 4 GB di RAM per qualche camera sulla CPU; 16 GB o più con il
  modello delle attività (Ollama). Un SSD per il sistema; un secondo disco per lo storage di Frigate è il benvenuto.
- **Software:** Docker Engine con il plugin Compose. Segui
  [Install Docker Engine](https://docs.docker.com/engine/install/) per la tua distribuzione; non usare il pacchetto
  snap.
- **Camere:** camere IP con uno stream RTSP (quasi tutte le marche). Ti servono indirizzo RTSP, utente e password.
- **macOS e Windows:** con Docker Desktop Percezione gira solo sulla CPU. Va bene per provarlo, non per l'uso 24/7.

## 2. Accelerazione hardware (facoltativa)

Salta questa sezione se usi la CPU.

### GPU NVIDIA (amd64)
1. **Driver.** Su Ubuntu: `sudo ubuntu-drivers install`, poi riavvia. Con Secure Boot attivo registra la chiave che
   il driver chiede al riavvio, oppure spegni Secure Boot.
2. **NVIDIA Container Toolkit:** segui
   [la guida di NVIDIA](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html),
   poi esegui:
   ```sh
   sudo nvidia-ctk runtime configure --runtime=docker
   sudo systemctl restart docker
   ```
3. **Verifica:** `docker run --rm --gpus all ubuntu nvidia-smi` deve mostrare la tua GPU.
4. **Primo avvio:** il servizio `frigate-model` costruisce sulla tua macchina un modello di detection YOLOv9. Scarica
   qualche GB (PyTorch) e impiega 5–15 minuti, una volta sola. La taglia del modello si sceglie con
   `YOLO_MODEL_SIZE` e `YOLO_IMG_SIZE` nel `.env`.

### GPU o NPU Intel
- Deve esistere `/dev/dri` (`ls /dev/dri`). A Frigate va solo il nodo di render Intel: `renderD128`, salvo che
  `INTEL_RENDER_DEVICE` nel `.env` ne indichi un altro.
- Frigate fa sia la detection sia la decodifica del video sulla GPU Intel (VAAPI), quindi la CPU resta quasi libera.
- Per la NPU l'host deve avere un firmware recente; vedi
  [le note di Frigate](https://docs.frigate.video/configuration/object_detectors#openvino-detector).

### GPU Intel per Frigate, GPU NVIDIA per il modello di visione
Su un PC con una CPU Intel con grafica integrata (per esempio un Core i9-9900K, non i modelli «F») e una scheda
NVIDIA, la divisione migliore è Frigate sulla GPU Intel e tutta la scheda NVIDIA per Ollama:
```sh
docker compose -f docker-compose.yml -f hardware/intel.yml -f hardware/ollama-nvidia.yml --profile vlm up -d
```
1. **BIOS:** con una scheda NVIDIA montata, molte schede madri spengono la GPU integrata. Riaccendila, per esempio con
   «iGPU Multi-Monitor» o «Internal Graphics: Enabled».
2. **Nodi di render:** `ls -l /dev/dri/by-path` ne mostra due. Quello Intel è sul PCI `00:02.0`; se non è
   `renderD128`, imposta `INTEL_RENDER_DEVICE` nel `.env`.
3. **NVIDIA:** segui i passi del driver e del Container Toolkit qui sopra.

### Google Coral
- **USB:** non c'è nulla da installare.
- **PCIe / M.2:**
  1. Installa il driver `gasket` della tua distribuzione e verifica che esista `/dev/apex_0`.
  2. In `deploy/hardware/coral.yml` sostituisci `/dev/bus/usb` con `/dev/apex_0`.
  3. Imposta `CORAL_DEVICE=pci` nel `.env`.

## 3. Installazione

```sh
git clone https://github.com/arkimedehq/percezione.git
cd percezione/deploy
cp .env.example .env      # facoltativo: fuso orario, porte, un broker tuo
docker compose up -d      # con un acceleratore: -f docker-compose.yml -f hardware/<il tuo>.yml
docker compose logs -f setup percezione
```

`setup` parte per primo e poi esce. Crea:
- i segreti in `data/secrets`, leggibili solo dal proprietario;
- la `config.yml` di Frigate, con il detector del tuo hardware;
- la configurazione di go2rtc e di Mosquitto.

Non sovrascrive mai quello che c'è già, quindi puoi modificare `frigate/config/config.yml` senza timori.

Per costruire le immagini dal codice invece di scaricarle, aggiungi `--build`.

### Parti facoltative

```sh
docker compose --profile vlm --profile pose up -d
```

- **`vlm`** (attività): Ollama parte senza modelli; Percezione scarica da sola quello impostato
  (`qwen3-vl:4b-instruct` di default, circa 3 GB; `qwen3-vl:8b-instruct` con 8 GB di memoria sulla GPU), con
  l'avanzamento nella pagina **Analizzatori**.
- **`pose`** (postura): scarica RTMPose al primo avvio. Per gli oggetti lasciati aggiungi CLIP con
  `ONNX_MODELS=pose clip` in `.env`.

## 4. Primo avvio

1. **Password:** apri `http://<questa macchina>:8090` e scegli la password (almeno 8 caratteri). La sceglie chi apre
   la pagina per primo, quindi fallo subito dopo l'installazione.
2. Pagina **Camere:** aggiungi una camera dal suo indirizzo RTSP. La password si chiede a parte e non si rivede più.
3. **Zone:** sulla camera, disegna le zone che contano (il divano, l'ingresso) e le maschere per quello che si muove
   ma non conta (l'orologio della camera, gli alberi).
4. Pagina **Persone:** crea le persone di casa e aggiungi 3–10 foto del volto a testa.
   - Al primo avvio Frigate scarica i suoi modelli dei volti (circa 320 MB). Fino ad allora rifiuta ogni foto con «No
     face was detected»: aspetta qualche minuto e riprova.
   - Quando i modelli ci sono, Percezione riavvia Frigate una volta: Frigate li carica solo all'avvio, e prima non
     riconoscerebbe i volti visti dalle camere.
   - Col tempo la casella «da nominare» si riempie dei volti visti dalle camere: nominarli è la fonte migliore.
5. **Regole** e **Uscite:** scegli di cosa essere avvisato, e dove (Home Assistant, webhook, agenti).
6. **Regolazioni** (facoltativo): tempi di presenza, soglie delle attività, immagine per il VLM e frequenza del
   collegamento con Frigate. Ogni campo vuoto usa il suo valore predefinito.

## 5. Porte

| Porta | Cosa |
|---|---|
| 8090 | Percezione: UI e API (`PERCEZIONE_PORT`) |
| 8091 | La UI di Frigate, dietro il login di Percezione (`FRIGATE_UI_PORT`) |
| 8554 | RTSP delle camere per altre app, dietro il login di go2rtc, quando la condivisione è attiva (`GO2RTC_RTSP_PORT`) |
| 8555 | WebRTC, quando la condivisione è attiva |
| 1984 | API di go2rtc, dietro il suo login, solo con `-f share.yml` (`GO2RTC_API_PORT`): per le app che controllano i nomi degli stream |

L'API di Frigate e Mosquitto non sono esposti; l'API di go2rtc solo con `share.yml`.

## 6. Un broker tuo

Per usare un broker MQTT che hai già (per esempio il Mosquitto di Home Assistant) al posto di quello incluso:
1. Crea due utenti: uno per Frigate, uno per Percezione.
2. Imposta `MQTT_HOST` (e `MQTT_PORT`) nel `.env`.
3. Dopo il primo avvio, metti i due login in `data/secrets/system.json` (`mqtt.frigate`, `mqtt.percezione`).
4. Esegui di nuovo `docker compose up -d`.

Il Mosquitto incluso resta acceso, inutilizzato.

## 7. Aggiornamenti

1. Prima fai un backup: pagina **Utilizzo** → *Scarica il backup*.
2. Esegui:
   ```sh
   git pull
   docker compose pull
   docker compose up -d      # con le stesse opzioni -f e --profile di prima
   ```

## 8. Backup

La pagina **Utilizzo** scarica un solo file con la configurazione, le persone con i volti e i token; le password delle
camere solo se lo chiedi. Ripristinandolo su una nuova installazione torna tutto, e Percezione si riavvia da solo.
Dettagli: [backup.it.md](backup.it.md).

## 9. Problemi frequenti

- **È tutto acceso?** `curl http://localhost:8090/healthz` risponde `{"ok":true,…}`, oppure nomina la parte giù
  (mqtt, frigate, go2rtc).
- **Log:** `docker compose logs -f percezione frigate`.
- **«Unknown host name»** aprendo l'interfaccia: risponde solo agli indirizzi, a `localhost` e ai nomi locali
  (`server`, `*.local`, `*.lan`, `*.home.arpa`). Per usare un nome del tuo dominio aggiungilo a `PERCEZIONE_HOSTS` in
  `.env` e lancia `docker compose up -d`.
- **«Too many wrong passwords»**: dopo due password sbagliate ogni tentativo aspetta di più, fino a un minuto. Aspetta
  e riprova.
- **L'utente «admin» di Frigate:** al primo avvio Frigate crea un utente `admin` per la sua UI protetta (porta 8971) e
  ne scrive la password nel suo log. Percezione non lo usa e non espone quella porta: puoi ignorarlo.
- **Docker Desktop per Mac:** Mosquitto avvisa che il file delle password non è di `mosquitto`. Lì i proprietari dei
  file sono simulati; funziona lo stesso.
- **Una camera si riavvia di continuo con la GPU Intel** (nel log di Frigate: «Failed to sync surface», «Failed to
  download frame»): il suo H.264 non è decodificabile con VAAPI (succede con alcuni citofoni Hikvision). Nell'editor
  della camera imposta **Decodifica del video** su **CPU**: solo quella camera viene decodificata dalla CPU.
- **Frigate lamenta la memoria condivisa:** alza `FRIGATE_SHM_SIZE` nel `.env` (circa 128 MB per camera 1080p).

## 10. Disinstallare

```sh
docker compose down
```

Tutto quello che Percezione conserva è in `deploy/data` e `deploy/frigate`. Cancella queste due cartelle per
ripartire da zero.
