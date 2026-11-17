# Novità

*[English](CHANGELOG.md)*

## 0.1.0 — prima release pubblica

Percezione trasforma le camere IP in eventi sulle persone, in locale, sopra Frigate e go2rtc.

- **Installazione** con Docker Compose dalle immagini pubblicate (`ghcr.io/arkimedehq/percezione:0.1.0`, amd64 e
  arm64): il servizio `setup` crea i segreti e la configurazione di base; la password della UI si sceglie alla prima
  apertura. File per l'hardware NVIDIA, Intel (GPU/NPU) e Coral; profili facoltativi per il modello delle attività
  (`vlm`, Ollama, scaricato da solo) e per postura e oggetti lasciati (`pose`).
- **Camere, gruppi e zone** dalla UI, con una connessione go2rtc per camera, condivisibile con altre app.
- **Persone:** foto del volto, una casella «da nominare» per i volti visti dalle camere, volti notturni (infrarosso)
  a parte.
- **Eventi** (schema v3): `arrived`, `left`, `activity_changed`, `posture_changed`, `passage`, `approach`,
  `object_left`, `external`; la memoria breve restituisce il volto migliore di ogni persona attorno a un evento
  esterno.
- **Regole e reazioni:** notifica, memoria, annuncio vocale, Home Assistant, webhook.
- **Uscite:** MQTT con discovery di Home Assistant, webhook firmati con coda d'uscita, eventi in diretta via SSE,
  server MCP per gli agenti (sola lettura), `who_is_at` via MCP, HTTP e MQTT; plugin di Arkimede.
- **Sicurezza:** token agente e dispositivo, login con attesa crescente, solo nomi host locali, ACL del Mosquitto,
  file con segreti leggibili solo dal servizio.
- **Backup e ripristino** di configurazione, persone, volti e token in un solo file.

Da sapere: Frigate carica i modelli dei volti solo all'avvio; su un'installazione nuova Percezione lo riavvia una
volta quando li ha scaricati (qualche minuto dopo il primo avvio). Fino ad allora le foto dei volti sono rifiutate con
«No face was detected».
