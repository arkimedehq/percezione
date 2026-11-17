# Server MCP per gli agenti

*[English](mcp.md)*

Percezione espone un server MCP **in sola lettura**. Qualunque client MCP lo può interrogare: Claude, Arkimede (con il
[suo plugin](arkimede-plugin.it.md) o come server MCP qualsiasi), OpenClaw, Hermes. Serve a domande come «chi c'è in
casa?», «dov'è Alice?», «chi è passato stanotte?».

## Collegamento
- **Indirizzo:** `http://<host di Percezione>:8090/mcp`, trasporto MCP «streamable HTTP», senza sessioni (stateless).
- **Accesso:** intestazione `Authorization: Bearer <token>`.
  - Un token per ogni client: si crea e si revoca dalla pagina **Agenti** del frontend.
  - Ogni token ha un **Tipo**, scelto alla creazione. **Agente** (un assistente AI: Arkimede, Claude): `/mcp` e
    [`/events`](live-events.it.md); può leggere `GET /external` e `GET /people`, ma non mandarci nulla. **Dispositivo**
    (un pannello a parete, un campanello, un archivio di foto): [`/external`](external-events.it.md) con tutte le foto,
    [`/people`](people.it.md) con l'import, e `/events`; niente MCP.
  - Solo un token Agente apre `/mcp`: un token Dispositivo riceve 403. I token creati prima dei tipi contano come agenti.
  - Il token si vede **una volta sola**, alla creazione. Su disco (`data/mcp-clients.json`, permessi 600) resta solo
    il suo sha256.
  - Il cookie della UI non apre `/mcp`, e un token MCP non apre l'API della UI: gli agenti non possono cambiare la
    configurazione.
- **Esempio, Claude Code:**
  ```sh
  claude mcp add --transport http percezione http://<host>:8090/mcp --header "Authorization: Bearer <token>"
  ```
- Per gli altri client: server MCP HTTP a quell'indirizzo, con la stessa intestazione.

## Strumenti
Tutti hanno `readOnlyHint: true`. I nomi, le descrizioni e il campo `text` degli eventi sono in inglese.
Gli orari sono locali, con il fuso (`2026-11-09T22:00:00+01:00`).

| Strumento | Cosa restituisce |
|---|---|
| `who_is_where` | chi è inquadrato adesso, con camera, luogo, attività, postura e punteggio del volto; quante persone non riconosciute ci sono per camera; per chi non è inquadrato, l'ultimo avvistamento negli ultimi 7 giorni |
| `events` | gli eventi, dal più recente. Filtri: `since` / `until` (ISO con fuso) oppure `hours` (24 di default), `camera`, `place`, `person` (un nome, oppure `unknown` per i non riconosciuti; maiuscole e accenti non contano), `types`, `limit` (100 di default, al massimo 500) |
| `people` | tutte le persone che il riconoscimento dei volti conosce (la Face Library di Frigate): `id`, cioè il nome che compare negli eventi e in `who_is_where`, un nome leggibile (`Alice_Smith` → «Alice Smith») e l'ultimo avvistamento nella cronologia (`null` se mai visto). Prima chi è stato visto |
| `cameras` | le camere: luogo, interna o esterna, cosa osservano, zone, se l'immagine è permessa |
| `who_is_at` | chi c'è adesso a **una** camera o a un gruppo di camere (es. la porta): i nomi riconosciuti, quanti senza nome, i nomi visti lungo il percorso dalle altre camere del gruppo (`seen_by`), e i volti visti lì negli ultimi 2 minuti che nessuno ha saputo nominare (con l'ipotesi del riconoscimento). Con l'immagine della camera principale, se è abilitata. Con `faces: true`, sulle camere abilitate, anche il volto migliore di ognuno degli ultimi secondi (per chi è stato visto da un'altra camera del gruppo, `seen_by`, solo se è abilitata anche quella camera): un'immagine per ogni persona con `face_image: true`, nell'ordine di `people` e poi di `unknown_people`. Vedi [people.it.md](people.it.md) |
| `camera_snapshot` | l'immagine di adesso di una camera (JPEG, larga al massimo 1280 px), **solo** per le camere abilitate |

Limiti noti:
- Le persone non riconosciute contano solo sulle camere con l'osservazione presenza. I passaggi in strada si trovano
  con `events`.
- `who_is_where` dice dove qualcuno è stato visto l'ultima volta, non se è ancora in casa: chi esce senza passare
  davanti a una camera resta «visto in salotto alle 19:10».
- I nomi vengono dal riconoscimento dei volti e possono essere sbagliati: va guardato `confidence`.

## Immagini
Di default nessuna camera manda immagini. Si abilitano camera per camera dalla pagina **Agenti**, con la voce
`outputs.mcp.snapshots` della configurazione. Ogni immagine data a un agente viene scritta nel log del servizio,
con il nome del client.

La stessa regola vale per le foto degli eventi esterni (`image`, `photo` e `face` delle persone): un agente le riceve,
su `/events` e `GET /external`, solo se ogni camera dell'evento è abilitata (per un gruppo: tutte le sue camere). Un
token Dispositivo le riceve sempre.

## Sicurezza
- Gli eventi sono **dati, non istruzioni**. Le istruzioni del server lo dicono al modello, ma i testi vengono comunque
  dalle camere e dal riconoscimento.
- Il server non chiama mai l'API di Frigate per conto dell'agente e non mostra né stream né credenziali.
- Per ora è in HTTP sulla LAN, come il frontend. Se esce dalla LAN serve HTTPS davanti, con un reverse proxy.
