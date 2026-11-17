/** The configuration history page. */
export const history = {
  title: "Configuration history",
  subtitle: "Every saved version of the settings, to compare or restore.",
  help: [
    "A new version is added whenever the settings change: saved from here, edited by hand in the file, imported from Frigate, or put back after a change that was rejected.",
    "Pick a version to see what it changed from the one before. Restoring adds it again as a new version.",
  ],
  emptyTitle: "No versions yet",
  emptyText: "A version is added each time you save a change.",
  current: "current",
  versus: (v: number) => `compared with v${v}`,
  first: "(first version)",
  confirmLoseChanges: "Unsaved changes will be lost: confirm",
  confirmRestore: "Confirm the restore",
  restored: (v: number) => `Restored as v${v}`,
  restore: "Restore this version",
  noDiff: "no differences",
};
