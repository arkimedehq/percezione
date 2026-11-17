import type { history as en } from "../en/history.ts";

export const history: typeof en = {
  title: "Cronologia della configurazione",
  subtitle: "Ogni versione salvata delle impostazioni, da confrontare o ripristinare.",
  help: [
    "Si aggiunge una versione ogni volta che le impostazioni cambiano: salvate da qui, modificate a mano nel file, importate da Frigate, o rimesse com'erano dopo una modifica rifiutata.",
    "Scegli una versione per vedere cosa ha cambiato rispetto alla precedente. Ripristinarla la aggiunge di nuovo come nuova versione.",
  ],
  emptyTitle: "Ancora nessuna versione",
  emptyText: "Si aggiunge una versione ogni volta che salvi una modifica.",
  current: "in vigore",
  versus: (v) => `rispetto a v${v}`,
  first: "(prima versione)",
  confirmLoseChanges: "Le modifiche non salvate andranno perse: conferma",
  confirmRestore: "Conferma il ripristino",
  restored: (v) => `Ripristinata come v${v}`,
  restore: "Ripristina questa versione",
  noDiff: "nessuna differenza",
};
