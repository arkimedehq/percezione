# Backup e ripristino

*[English](backup.md)*

Si fa dalla pagina «Utilizzo», sezione Backup.

## Cosa c'è in un backup
Un solo file `percezione-backup-AAAA-MM-GG.json.gz`, un JSON compresso:

| Contenuto | Note |
|---|---|
| Configurazione (`config.json`) | Camere, zone, maschere, sorgenti senza password, regole, uscite, analizzatori |
| Persone e volti | Tutti i volti come li elenca Frigate, quelli notturni con il prefisso `~ir/` |
| `mcp-clients.json` | Token degli agenti e dei client (solo gli hash) |
| `webhook-secrets.json` | Segreti dei webhook |
| `secrets/ui.json` | Hash della password della UI scelta al primo avvio |
| `people-imports.json` | Impronte delle foto già importate con l'API di import ([people.it.md](people.it.md)) |
| `source-passwords.json` | **Solo con «Includi le password delle camere»** |

Non contiene:
- lo storico degli eventi e le foto degli eventi e degli oggetti lasciati;
- i segreti di sistema (`secrets/system.json`: login di go2rtc e MQTT), perché una nuova installazione crea i suoi.

Un backup **con** le password delle camere va conservato come le password stesse. Uno **senza** contiene comunque i
volti delle persone: non va condiviso.

## Ripristino
Dalla pagina «Utilizzo»: si sceglie il file, poi «Ripristina» e una conferma. In ordine:
1. **File:** si riscrivono solo quelli dell'elenco sopra. Qualunque altro percorso nel file viene rifiutato.
2. **Configurazione:** diventa una nuova versione, quindi arriva a Frigate e a go2rtc come ogni modifica, e la
   versione precedente resta nella cronologia.
3. **Volti:** vanno solo alle persone che non ne hanno. Chi ha già volti resta com'è, così il ripristino non duplica
   nulla. I volti notturni tornano nella cartella notturna.
4. **Riavvio:** Percezione si riavvia da solo, perché token, segreti e password si leggono all'avvio. In Docker il
   container riparte da sé; la pagina si ricarica quando il servizio risponde.

**La password della UI torna quella del backup**, se il backup ne ha una.

### Frigate appena installato
Al primo avvio Frigate scarica da GitHub i modelli dei volti (circa 320 MB) e li carica. Fino ad allora risponde «No
face was detected» a ogni volto, di solito per un paio di minuti. Il ripristino riprova il primo volto per al
massimo 5 minuti; dopo il primo volto accettato, uno rifiutato è considerato un volto illeggibile e finisce tra i
problemi del risultato. Anche un volto caricato a mano subito dopo l'installazione viene rifiutato, senza nuovi
tentativi: basta riprovare dopo qualche minuto.

## API
- `GET /api/backup` (con `?secrets=1` per le password delle camere): scarica il file. Serve il login della UI.
- `POST /api/restore`: corpo = il file. Risponde con `config_version`, `files`, `people` (`added`, `kept`), `errors`
  e `restarting`, poi riavvia il servizio.

