# Analizzatori: contratto v1

*[English](analyzers.md)*

Un analizzatore guarda un'immagine e risponde con un risultato strutturato: punti del corpo, una classe, risposte
sì/no. Il perception-service non sa come è fatto dentro: lo chiama via HTTP con questo contratto, che è un
sottoinsieme dell'*AI Adapter Contract v1* di OpenNVR. Un adapter OpenNVR compatibile si può quindi registrare
così com'è.

Gli analizzatori si dichiarano in `data/config.json`, oppure dalla schermata **Analizzatori** del frontend:

```json
"analyzers": {
  "vlm": { "model": "qwen3-vl:4b-instruct", "vocabulary": { … }, "attributes": { … } },
  "endpoints": { "onnx": { "url": "http://127.0.0.1:8100" } }
}
```

`vlm` è interno: è Ollama chiamato dal servizio, con domande sì/no. Gli `endpoints` sono servizi esterni con il
contratto qui sotto. Il servizio interroga salute e capacità ogni 30 s e a ogni cambio di configurazione.

## Endpoint

### `GET /health`
```json
{ "status": "ok", "adapter": "onnx-runner", "version": "0.1.0", "providers": ["CPUExecutionProvider"],
  "models": 1, "broken": { "gate": "model.yml: missing «task»" } }
```
`status` diverso da `"ok"`, oppure nessuna risposta entro 5 s, vuol dire analizzatore non disponibile.
`providers` e `broken` sono facoltativi: sono estensioni di Percezione.

### `GET /capabilities`
```json
{ "adapter": "onnx-runner", "version": "0.1.0", "contract": "v1",
  "tasks_advertised": ["pose_estimation"],
  "models": [ { "name": "pose", "task": "pose_estimation", "family": "rtmpose",
                "outputs": ["standing", "sitting", "lying", "uncertain"] } ] }
```
`models[].outputs` è un'estensione di Percezione: le etichette che il modello può restituire. La UI le propone nelle
regole. Un adapter con un solo modello può omettere `models` e dichiarare solo `tasks_advertised`.

### `POST /infer`
`multipart/form-data` con:
- `frame`: JPEG del frame intero, alla risoluzione del detect di Frigate;
- `params`: JSON con `model` (nome del modello) e, per i modelli top-down, `box` = `[x1, y1, x2, y2]` in pixel del frame.

Risposta:
```json
{ "status": "ok", "model_name": "pose", "inference_ms": 10.4,
  "result": { "label": "standing", "features": { "torso_deg": 17.5, "thigh_deg": 13.9 },
              "keypoints": [ { "name": "nose", "x": 2211.3, "y": 291.0, "score": 0.566 }, … ] } }
```
Errori:
- 4xx con `detail` per richieste sbagliate (modello sconosciuto, box non valido, immagine illeggibile);
- `{"status": "error", "error": "…"}` se l'inferenza fallisce.

### `PUT /models/{name}` (facoltativo)
`multipart/form-data` con `model` (il `.onnx`) e `manifest` (il `model.yml`). Il runner prova a caricare il modello
in una cartella temporanea e lo installa solo se va: un manifest che non corrisponde al modello viene rifiutato
con 422. Il frontend lo usa per «Carica un modello», passando dal servizio.

## Compiti

| Compito | `result` | Chi lo usa |
|---|---|---|
| `pose_estimation` | `keypoints`, e facoltativi `label` e `features` | osservazione `posture` |
| `zero_shot_classification` | `label`, `score`, `top` | osservazione `left_object`; filtro rapido facoltativo di `activity` (`fast`) |
| `image_classification` | `label`, `score`, `top` | famiglia pronta, nessuna osservazione la usa ancora |
| `vqa_yes_no` | risposte booleane per nome | VLM interno, osservazione `activity` |

## onnx-runner

`analyzers/onnx-runner/` è un solo processo Python (onnxruntime) che serve tutti i modelli di
`analyzers/models/<nome>/`. Ogni cartella contiene:
- `model.onnx`, i pesi, che non sono versionati: ogni cartella ha un `fetch.sh` che li scarica e ne controlla lo sha256;
- `model.yml`, il manifest: compito, famiglia, preparazione dell'immagine, etichette e regole derivate.

Copiare una cartella basta: il runner rilegge `analyzers/models/` ogni 5 s. Un modello rotto non ferma gli altri e
compare in `broken`.

Famiglie supportate:
- **`rtmpose`**: top-down, SimCC (RTMPose di OpenMMLab).
  - Ritaglio attorno a `box` con margine `input.padding`, al rapporto dell'ingresso.
  - Normalizzazione con `input.mean` e `input.std`.
  - Punti dall'argmax di `simcc_x` e `simcc_y` divisi per `simcc_split_ratio`; la confidenza è il minore dei due
    massimi, come in MMPose.
  - Con `derive.posture` aggiunge `label` e `features` (`posture.py`): busto più inclinato di `lying_torso_deg`
    vuol dire sdraiato, coscia più inclinata di `sitting_thigh_deg` vuol dire seduto, altrimenti in piedi.
    Senza busto visibile decide la forma del box: molto più largo che alto (`lying_aspect`) è sdraiato, altrimenti
    `uncertain`.
    Busto tra `upright_torso_deg` (30°) e `lying_torso_deg` (55°): seduto e appoggiato (regola `reclined`).
    Sul divano, visto da una camera alta, le cosce puntano verso l'obiettivo e sembrano verticali.
    Un busto orizzontale è «sdraiato» solo se lo è tutto il corpo:
    - cosce verticali vuol dire chinato in piedi (regola `bent`);
    - cosce orizzontali con un box più alto che largo (sotto `lying_min_aspect`, 0,9) vuol dire seduto e piegato in
      avanti (regola `leaning`);
    - senza ginocchia visibili, con un box alto, il risultato è `uncertain`.
- **`clip`**: zero-shot. L'etichetta è quella le cui frasi (`prompts` nel manifest, oppure `params.prompts`)
  somigliano di più all'immagine. Con `box`, ritaglio largo attorno alla persona.
- **`classifier`**: ritaglio facoltativo su `box`, ridimensionamento a `input.width`×`input.height`,
  normalizzazione, softmax su `labels`.

```sh
cd analyzers/models/pose && ./fetch.sh            # pesi di RTMPose-m (51 MB, Apache 2.0)
cd analyzers/onnx-runner && uv sync
uv run uvicorn app:app --host 127.0.0.1 --port 8100
uv run pytest
```

Provider: CUDA se disponibile, altrimenti CPU. CoreML non viene usato: per modelli così piccoli la CPU basta.

## Osservazione `posture`

```json
"posture": { "analyzer": "onnx", "model": "pose", "interval_s": 5, "stable_s": 15, "rest_zones": ["sofa"] }
```
- Per ogni persona riconosciuta e presente nella camera, ogni `interval_s` si fa un campione: frame di Frigate e
  box del track.
- `lying` con il centro del box fuori da tutte le `rest_zones` diventa `on_floor`.
- Se la camera non ha zone di riposo:
  - di norma `lying` resta `lying`, perché il divano potrebbe non essere ancora disegnato;
  - con `no_rest_place: true` («In questa stanza non c'è un divano né un letto») diventa sempre `on_floor`.
  - Se ci sono zone di riposo disegnate, contano quelle e `no_rest_place` viene ignorato.
- Debounce come per le attività: un cambio diventa `posture_changed` (`value: {from, to}`) solo quando è stabile per
  `stable_s`. `uncertain` non conta.
- Un'assenza breve non azzera la postura: Frigate spezza spesso una permanenza in più track. La postura si dimentica
  solo dopo 5 minuti di assenza, quindi un nuovo track non riannuncia «→ sitting». Cambiando camera, invece, riparte
  da capo.
- Le regole filtrano con `when.value` su `standing`, `sitting`, `lying` e `on_floor`.

Limite attuale: solo le persone riconosciute dal volto, come per presenza e attività. Una persona sconosciuta a terra
non genera eventi.

## Osservazione `left_object` (oggetti lasciati)

```json
"left_object": { "zone": "sidewalk", "analyzer": "onnx", "model": "clip", "check_s": 20, "persist_s": 90, "min_score": 0.5, "min_cells": 2 }
```
Rifiuti, pacchi o ingombranti lasciati in una zona della camera (`src/left-objects.ts`). OpenNVR non ha un modello
per l'abbandono dei rifiuti: qui si combina un confronto della scena con CLIP.

1. **Zona libera.** Si confronta solo quando sulla camera non c'è nessuno: nessuna persona attiva per Frigate e
   nessun evento di persona negli ultimi 15 s.
2. **Impronta.** Ogni `check_s` il rettangolo della zona diventa una griglia 24×24 di luminosità media. Contano
   solo le celle dentro il poligono.
3. **Confronto.**
   - Contro il riferimento (la zona vuota) si toglie prima la variazione comune, la mediana: il sole che cala non
     è un cambiamento.
   - Una cella è cambiata oltre 18 livelli di grigio.
   - Meno di `min_cells` celle cambiate: il riferimento segue piano la scena.
   - Oltre metà della zona cambiata è luce (nuvola, infrarossi): si prende un riferimento nuovo.
4. **Persistenza.** Il cambiamento deve restare uguale per `persist_s`: foglie e ombre che si muovono ripartono
   da capo.
5. **Classificazione.**
   - CLIP classifica lo stesso riquadro **prima e dopo**, con le frasi di `OBJECT_PROMPTS`: `trash`, `parcel`,
     `bulky`, `nothing`.
   - L'oggetto è quello la cui probabilità sale di più, purché salga di almeno 0,25 e arrivi a `min_score`.
   - Su un solo ritaglio CLIP sbaglia: piastrelle o un muro vuoti arrivano a 0,7 come «pacco». Lo stesso errore
     però c'è anche nel ritaglio di prima, quindi la differenza lo toglie.
6. **Evento.** Nasce `object_left` con:
   - `value.to`: l'oggetto;
   - `zone`;
   - `person`: chi Frigate ha riconosciuto tra l'ultima zona vuota e il cambiamento;
   - `media.frigate_ids`: tutte le persone passate in quell'intervallo;
   - `object`: punteggio, aumento, riquadro, numero di passaggi e foto.

   Le foto prima/dopo sono in `data/left-objects/` e si vedono da `/api/left-objects/<id>-before|after.jpg`. In
   ogni caso la scena nuova diventa il riferimento, quindi lo stesso oggetto non scatta due volte.

Le regole filtrano con `when.event: "object_left"` e `when.value` su `trash`, `parcel`, `bulky`.

Limiti noti:
- Frigate segue solo le persone: chi scarica da un'auto non è collegato all'evento, ma l'oggetto viene trovato
  lo stesso.
- Un'auto che parcheggia nella zona è un cambiamento persistente: CLIP la mette in `nothing` e diventa il
  riferimento.
- Un oggetto che viene portato via non produce un evento.
