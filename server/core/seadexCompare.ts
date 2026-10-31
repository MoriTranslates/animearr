/**
 * Compares the files a season has now to SeaDex's picks for it. Pure: the caller hands over the files' ORIGINAL
 * release names (a Tdarr re-encode keeps the scene name it came from) and SeaDex's cached entry.
 *
 * Verdict: "best" = every file is SeaDex's best pick; "alt" = every file is a SeaDex pick, some only the alt;
 * "worse" = at least one file isn't a SeaDex pick (wrong group, or the group's other source: a BD pick doesn't
 * bless the same group's WEB or TV raw).
 */
import { parseRelease, type Source } from "./parser.js";
import { seadexPick, seadexSource, seadexTop, type SeadexEntry, type SeadexTorrent } from "./quality.js";

export type WatchMode = "sub" | "dub" | "dual" | "either";
export interface SeadexComparison {
  verdict: "best" | "alt" | "worse";
  files: number;
  counts: { best: number; alt: number; other: number };
  /** What the files not on a SeaDex pick are (the most common group + source); the best file's group when none are off. */
  have: { group: string | null; source: Source };
  /** SeaDex's best pick for the watch mode. */
  best: { group: string; dualAudio: boolean; source: NonNullable<Source> };
}

/** "best" / "alt" / null for one file's original release name. */
export function pickOfRelease(release: string, entry: SeadexEntry | null | undefined, mode: WatchMode = "sub"): "best" | "alt" | null {
  const p = parseRelease(release);
  return seadexPick(p.group, entry, mode, p.source)?.level ?? null;
}

export function compareToSeadex(releases: string[], entry: SeadexEntry | null | undefined, mode: WatchMode = "sub"): SeadexComparison | null {
  const top: SeadexTorrent | null = entry ? seadexTop(entry, mode) : null;
  if (!entry || !top || !releases.length) return null;
  const counts = { best: 0, alt: 0, other: 0 };
  const off = new Map<string, { group: string | null; source: Source; n: number }>();
  const on = new Map<string, { group: string | null; source: Source; n: number }>();
  for (const r of releases) {
    const p = parseRelease(r);
    const level = seadexPick(p.group, entry, mode, p.source)?.level ?? null;
    counts[level ?? "other"]++;
    const bucket = level ? on : off;
    const k = `${(p.group ?? "").toLowerCase()}|${p.source ?? ""}`;
    bucket.set(k, { group: p.group, source: p.source, n: (bucket.get(k)?.n ?? 0) + 1 });
  }
  const most = (m: Map<string, { group: string | null; source: Source; n: number }>) => [...m.values()].sort((a, b) => b.n - a.n)[0];
  const shown = most(off) ?? most(on);
  return {
    verdict: counts.other ? "worse" : counts.alt ? "alt" : "best",
    files: releases.length,
    counts,
    have: { group: shown?.group ?? null, source: shown?.source ?? null },
    best: { group: top.group, dualAudio: top.dualAudio, source: seadexSource(top) },
  };
}
