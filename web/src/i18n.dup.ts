/** Strings for duplicate listings (a show TVDB lists twice). Spread into `en` in i18n.ts. */
export const dupStrings = {
  "audit.tab.duplicates": "Duplicate listings",
  "dup.intro": "TVDB sometimes lists an OVA or sequel twice: once as specials or a season of a bigger show, and again as its own show. Found from AniList/AniDB ids, never from titles alone. AnimeArr won't search or upgrade episodes a show already holds under another listing; picking a release by hand is still allowed.",
  "dup.empty": "No duplicate listings found.",
  "dup.overlap": "{mine} here is filed as {there} in {other}",
  "dup.files": "{a} of {b} files here · {c} of {d} files there",
  "dup.blocking": "Already owned there: not searched",
  "dup.notBlocking": "Nothing there yet: still searched",
  "dup.stop": "Stop managing this show",
  "dup.stopped": "No longer managed: {title}",
  "dup.sonarrHow": "This show comes from Sonarr. AnimeArr doesn't change Sonarr: to remove the duplicate, open Sonarr, find \"{title}\" and unmonitor or delete it there.",
  "dup.openSonarr": "Open Sonarr",
  "dup.pickWarn": "{n} of these episodes {n|is|are} already in your library under another listing ({why}). Picking a release by hand will download them again.",
} as const;
