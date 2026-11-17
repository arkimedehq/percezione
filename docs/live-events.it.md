# Eventi in diretta (`/events`)

*[English](live-events.md)*

Percezione manda i suoi eventi in diretta a qualunque programma: il plugin di Arkimede, uno script, un'altra
piattaforma. Non conosce i destinatari: chi vuole gli eventi si collega e li legge.

## Collegamento
- **Indirizzo:** `GET http://<host di Percezione>:8090/events`, in formato Server-Sent Events.
- **Accesso:** `Authorization: Bearer <token>`, con i token della pagina **Agenti**, di entrambi i tipi (Agente o
  Dispositivo, [mcp.it.md](mcp.it.md)). Il cookie della UI non vale.
- Ogni evento è l'evento v3 completo ([events.it.md](events.it.md)), come su MQTT e nella cronologia. Un token Agente
  riceve gli eventi esterni senza le loro foto (`image`, `photo` e `face` delle persone) se non è abilitata ogni camera
  dell'evento in Agenti → Immagini delle camere; un token Dispositivo le riceve sempre:
  ```
  id: 6f0c…            ← event_id
  event: perception
  data: {"event_id": "6f0c…", "schema_version": 3, "type": "passage", "ts": "…", "text": "…", "reactions": […], …}
  ```
- Ogni 20 secondi arriva un commento `: ping`: 60 secondi di silenzio vogliono dire una connessione morta.

## Nessun evento perso
- Chi si ricollega manda `Last-Event-ID` (o `?after=<id>`) con l'ultimo id ricevuto, e riceve dalla cronologia tutto quello che è
  successo dopo (al massimo 7 giorni).
- Se quell'id non c'è più nella cronologia, riceve l'ultimo giorno: i doppioni si scartano per id.
- Un client nuovo, senza id, riceve solo gli eventi da quel momento. Con `?since=<ISO>` può chiedere anche quelli dopo
  un certo istante.

Prova veloce:
```sh
curl -N -H "Authorization: Bearer <token>" http://<host>:8090/events
```
