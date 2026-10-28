/**
 * Plain one-line summaries for activity, the bell and the queue history: "Couldn't start downloading Fate/Grand Order:
 * a download source is offline." The raw message (release names, hosts, paths, codes) stays as the detail, shown
 * under "Details". Worked out when read, from the stored message, so old rows get a summary too. null = no better
 * words than the message itself (the UI then shows its first sentence).
 */

export interface SummaryInput {
  /** Activity kind (grab, fail, verify-fail, skip, …) when known. */
  kind?: string | null;
  why: string;
  /** Show or movie title, and a short episode label ("S01E04"). */
  title?: string | null;
  label?: string | null;
}

let names: Intl.DisplayNames | null | undefined;
const LANG3: Record<string, string> = { eng: "en", jpn: "ja", chi: "zh", zho: "zh", spa: "es", por: "pt", fre: "fr", fra: "fr", ger: "de", deu: "de", ita: "it", rus: "ru", ara: "ar", ind: "id", tha: "th", vie: "vi", kor: "ko" };
/** "en" → "English" (the code itself when Intl doesn't know it). */
export function langName(code: string): string {
  const c = LANG3[code.toLowerCase()] ?? code.toLowerCase();
  if (names === undefined)
    try {
      names = new Intl.DisplayNames(["en"], { type: "language", fallback: "code" });
    } catch {
      names = null;
    }
  try {
    const n = names?.of(c);
    if (n && n.toLowerCase() !== c) return n;
  } catch {
    /* not a language tag */
  }
  return code;
}
const langs = (s: string) => s.replace(/\b([a-z]{2,3})\b(?= (?:subtitles?|audio|track|signs))/g, (m) => (/^(no|an?|of|the|all|in|is|it|to)$/.test(m) ? m : langName(m)));

/** Why something went wrong, in plain words (null when it isn't a reason we know how to say). */
export function plainReason(raw: string): string | null {
  const r = raw.replace(/\s+/g, " ");
  const rules: [RegExp, string | ((m: RegExpExecArray) => string)][] = [
    [/no space left|ENOSPC|disk (?:is )?full/i, "the disk is full"],
    [/not found \(DNS\)|ENOTFOUND|EAI_AGAIN|getaddrinfo/i, "a download source is offline"],
    [/HTTP 410|HTTP 404|Download link failed|link (?:has )?expired/i, "the download link no longer works"],
    [/HTTP 429|rate.?limit/i, "a download source is limiting requests"],
    [/fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timed out|unreachable|socket hang up|didn't answer|slow to answer/i, "a download source didn't answer"],
    [/HTTP 401|HTTP 403|refused the (?:token|key)/i, "a download source refused AnimeArr's key"],
    [/HTTP 5\d\d/i, "a download source had an error"],
    [/Aborted, cannot be completed|not-complete|missing articles|incomplete/i, "parts of it are missing on the server"],
    [/no download progress|no seeders|stalled/i, "nobody is sharing it right now"],
    [/no subtitles at all/i, "it has no subtitles"],
    [/only a forced\/signs (\w+) track/i, (m) => `it only has ${langName(m[1])} signs, not full ${langName(m[1])} subtitles`],
    [/(\w+(?:\/\w+)*) audio only.*\bdub\b/i, "it's a dub (no Japanese audio)"],
    [/no (?:full )?(\w{2,3}) subtitles?|without (\w{2,3}) subtitles/i, (m) => `it has no ${langName(m[1] ?? m[2])} subtitles`],
    [/several large video files|import the right (?:one|file) by hand/i, "it has several video files, so pick the right one"],
    [/\.animearr-part already exists/i, "a half-finished copy from an earlier try was in the way"],
    [/restarted during the import/i, "AnimeArr restarted during the import"],
    [/two files look like the same episode/i, "two files look like the same episode"],
    [/couldn't tell which (?:file is which )?episode|couldn't map the episode/i, "AnimeArr couldn't tell which episode it is"],
    [/isn't in AnimeArr's own download folders|only a manual import can take it/i, "it's outside AnimeArr's download folders, so it needs a manual import"],
    [/Radarr hasn't picked them up|Radarr hasn't picked it up/i, "Radarr hasn't picked it up yet"],
    [/importer is paused|imports? .*(?:switched off|aren't switched on yet)|paused for a review/i, "imports are paused"],
    [/not sure it's the right episode/i, "AnimeArr isn't sure the results are the right episode"],
    [/covers other episodes too/i, "the only results also cover other episodes"],
    [/no result passes the automatic rules|nothing acceptable|0 acceptable/i, "nothing found was good enough"],
    [/nothing found|no results?\b/i, "nothing was found"],
    [/EACCES|EPERM|permission denied/i, "AnimeArr isn't allowed to write there"],
    [/ENOENT|no such file|can't read/i, "the downloaded file can't be found"],
    [/AnimeArr's importer: /i, "the import ran into an error"],
    [/banned/i, "AniDB is blocking requests for a while"],
  ];
  for (const [re, out] of rules) {
    const m = re.exec(r);
    if (m) return typeof out === "string" ? out : out(m);
  }
  return null;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;
const tidyTitle = (s: string) => s.replace(/\s+/g, " ").trim();

/** What the entry is about: "Bleach S17E50", "KanColle Movie (2016)", or (failing that) the "for X:" in the message. */
function subjectOf(x: SummaryInput): string {
  const named = [x.title, x.label].filter(Boolean).join(" ");
  if (named) return tidyTitle(named);
  const m = / for (.+?): \d+% /.exec(x.why) ?? /^(?:Automatic|Movie) search for (.+?): /.exec(x.why) ?? /^Imported ✓ (?!as )(.+?)(?: by hand from .*| \(AnimeArr's importer\)|: .*)?$/.exec(x.why);
  return m ? tidyTitle(m[1]) : "";
}

/** A queue/history row's problem in one line ("Turned down: it has no subtitles."); null when there's none. */
export function queueSummary(state: string, error: string | null, verifyFailed: boolean): string | null {
  if (!error || !["failed", "needs-attention"].includes(state)) return null;
  if (/^(?:removed|closed) by you/i.test(error)) return "You removed it.";
  const r = plainReason(error);
  const lead = verifyFailed ? "Turned down" : state === "failed" ? "Failed" : "Needs you";
  return r ? `${lead}: ${r}.` : verifyFailed ? "Turned down: it didn't pass the language check." : null;
}

export function summarize(x: SummaryInput): string | null {
  const why = x.why.replace(/\s+/g, " ").trim();
  if (!why) return null;
  const what = subjectOf(x);
  const it = what || "it";
  const kind = x.kind ?? "";
  const because = (r: string | null) => (r ? `: ${r}` : "");
  let m: RegExpExecArray | null;

  // ---- problems
  if ((m = /^Couldn't send .+?: (.*)$/.exec(why))) return `Couldn't download ${it}${because(plainReason(m[1]))}.`;
  if ((m = /^download failed: (.*?)(?:; blocklisted .*)?$/i.exec(why))) return `The download of ${it} failed${because(plainReason(m[1]))}. AnimeArr won't use that version again.`;
  if (/^no download progress for/i.test(why)) return `The download of ${it} got stuck: nobody is sharing it. AnimeArr removed it.`;
  if ((m = /^Downloaded .+? but couldn't import it: (.*)$/.exec(why))) {
    const kept = /The download is kept/i.test(m[1]);
    return `Downloaded ${it}, but couldn't import it${because(plainReason(m[1]))}.${kept ? " The download is kept." : ""}`;
  }
  if ((m = / failed verification: (.*)$/.exec(why))) {
    const next = /looking for the next release/i.test(why);
    const already = /already imported/i.test(why);
    return `Turned down a download of ${it}${because(plainReason(m[1]))}.${already ? " The file stays until a better one turns up." : ""}${next ? " Looking for another version." : ""}`;
  }
  if ((m = /^No more candidates to try after: (.*)$/.exec(why))) {
    const r = plainReason(m[1]);
    return `No other versions of ${it} left to try${r ? ` (the last one failed: ${r})` : ""}. AnimeArr searches again later.`;
  }
  if ((m = /^Couldn't try the next candidate: (.*)$/.exec(why))) return `Couldn't try another version of ${it}${because(plainReason(m[1]))}.`;
  if ((m = /^(?:Automatic|Movie) search for .+?: needs a look — (.*?)\. Nothing was grabbed/.exec(why))) return `Couldn't pick a version of ${it} by itself${because(plainReason(m[1]) ?? m[1])}. Pick one yourself.`;
  if ((m = /^Movie search for .+?: nothing acceptable yet .*?Next try in ([^.]+)\./.exec(why))) return `No good version of ${it} yet. Next try in ${m[1]}.`;
  if ((m = /: picked .*Next try in ([^.]+)\.$/.exec(why))) return `Found a version of ${it}, but not a good enough one yet. Next try in ${m[1]}.`;
  if ((m = /^(.+?) is off for grabbing: (\d+) (downloads|searches) failed in a row \(last error: (.*?)\)\./.exec(why)))
    return `Stopped using ${m[1]} for now: its last ${m[2]} ${m[3]} failed${plainReason(m[4]) ? ` (${plainReason(m[4])})` : ""}. AnimeArr tries it again later.`;
  if ((m = /^(.+?) is working again/.exec(why))) return `${m[1]} is working again.`;
  if (/^Replace season: kept the old file/.test(why)) return `Replace season: kept the old file for ${/for (S\d+E\d+(?:[–-]E?\d+)?)/.exec(why)?.[1] ?? "an episode"}${because(plainReason(why))}.`;
  if ((m = /^AniDB: (.*)$/.exec(why)) && kind === "fail") return `AniDB lookups are paused${because(plainReason(m[1]))}.`;

  // ---- everyday steps
  if (kind === "would-grab" || /^Dry-run: /.test(why)) return `Practice mode: would have downloaded ${it}.`;
  if (/^Sent .+ to \S+/.test(why)) return `Started downloading ${it}.`;
  if (/^Trying the next candidate/.test(why)) return `Trying another version of ${it}.`;
  if ((m = /^Imported ✓.*?(?:has full (\w{2,3}) subtitles)?$/.exec(why))) return `Imported ${it}${m[1] ? ` with ${langName(m[1])} subtitles` : ""}.`;
  if (/^Imported .+ → /.test(why)) return `Imported ${it}${/replaced file moved to/.test(why) ? ", replacing the old file (it went to the recycling bin)" : ""}.`;
  if (kind === "verify-ok") {
    const l = /has full (\w{2,3}) subtitles/.exec(why)?.[1];
    return l ? `Checked ${it}: it has ${langName(l)} subtitles.` : `Checked ${it}: it passed.`;
  }
  if ((m = /^Plex: asked to scan (.*)$/.exec(why))) {
    const folder = /\/([^/]+?)(?:\/Season \d+)?(?: \([^)]*\))?(?:,|$)/.exec(m[1])?.[1];
    return `Asked Plex to pick up ${what || folder || "the new files"}.`;
  }
  if (/^Cleaned up after the import/.test(why)) return "Cleaned up the finished download.";
  if ((m = /^Download clean-up: (\d+) step/.exec(why))) return `Cleaned up ${plural(Number(m[1]), "leftover download", "leftover downloads")}.`;
  if ((m = /^Synced from Sonarr\/Radarr: (\d+) anime series.*?(\d+) anime movies(?:, (\d+) need an AniDB match)?/.exec(why)))
    return `Synced the library: ${plural(Number(m[1]), "show", "shows")} and ${plural(Number(m[2]), "movie", "movies")}${m[3] && m[3] !== "0" ? `; ${plural(Number(m[3]), "needs", "need")} matching by hand` : ""}.`;
  if ((m = /^You marked (audio|subtitle) track (\d+) as (signs-only )?(\w{2,3})(?: subtitles)? in (\d+) files?/.exec(why)))
    return `You marked ${m[1]} track ${m[2]} as ${m[3] ? `${langName(m[4])} signs only` : langName(m[4])} in ${plural(Number(m[5]), "file", "files")}.`;
  if ((m = /^Set (.+) to unmonitored in Sonarr/.exec(why))) return `${m[1]}: only AnimeArr searches for it now (Sonarr stopped).`;
  // Language codes in what's left ("subtitles zh only") still read better as names.
  const named = langs(why);
  return named !== why ? named : null;
}
