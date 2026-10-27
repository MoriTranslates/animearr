/**
 * Strings for first-run setup, Settings, the wizard and connection errors (kept apart from i18n.ts so parallel work
 * on other screens doesn't collide; spread into the English dictionary there, same rules).
 */
export const setupStrings = {
  "managed.group.older": "Older episodes missing ({n})",
  "managed.olderOn": "These shows have nothing on the 30-day schedule, but older episodes are missing. The missing-episode search works through them a few per hour.",
  "managed.olderOff": "These shows have nothing on the 30-day schedule, but older episodes are missing. The missing-episode search finds them once it's switched on, or tap ⚡ on the show's page.",
  "managed.olderOpen": "Switch it on",
  "managed.olderN": "{n} missing",
  "wiz.stepDone": "done",
  "folders.remove": "Remove",
  "folders.add": "Add a library folder",
  "folders.chosen": "Already chosen",
  "folders.notLibrary": "Can't use this one",
  "folders.notHere": "not for your library",
  "folders.readOnlyHelp": "AnimeArr can't write here, so it can't put shows in this folder. Pick another one, or give the container write access to it.",
  "folders.fromArr": "Folders Sonarr and Radarr use",
};
