/** Parse → alias lookup → numbering resolver, as one pure step. */
import type { AnimeListEntry } from "./animedata.js";
import type { AliasIndex, Candidate } from "./aliases.js";
import { parseRelease, type ParsedRelease } from "./parser.js";
import { resolveRelease, type LibEpisode, type NumberingRule, type Resolution } from "./resolver.js";

export interface IdentifyContext {
  index: AliasIndex;
  episodesFor(tvdbId: number): LibEpisode[];
  rulesFor?(tvdbId: number): NumberingRule[];
  entriesFor?(tvdbId: number): AnimeListEntry[];
  now?: number;
}

export interface Identification {
  parsed: ParsedRelease;
  candidate: Candidate | null;
  resolution: Resolution | null;
  /** Other series the title could also be. */
  others: { tvdbId: number; title: string; score: number }[];
  /** One-line summary, e.g. "Full-Time Magister S06E01 (93%)". */
  summary: string;
}

export function identify(
  name: string,
  ctx: IdentifyContext,
  opts: { publishDate?: number | null; tvdbId?: number; parsed?: ParsedRelease; expect?: number[] } = {},
): Identification {
  const original = opts.parsed ?? parseRelease(name);
  let parsed = original;
  const lookup = (p: ParsedRelease) => {
    const found = ctx.index.lookup(p.title, p.altTitles);
    return opts.tvdbId !== undefined ? found.filter((c) => c.tvdbId === opts.tvdbId) : found;
  };
  let cands = lookup(parsed);
  // "One Piece 1050 S21E1050": the parser keeps a number before SxxEyy in the title ("Mob Psycho 100 S03E05"). When
  // that title is unknown, try it as "Title" + absolute number, but only accept a show whose resolved episode has
  // exactly that absolute number, so "Mob Psycho 100" never lands on a show called "Mob Psycho".
  let absCheck: number | null = null;
  const numbered =
    !cands.length && parsed.episodes.length === 1 && !parsed.absolute.length ? /^(.*\S)\s+(\d{1,4})$/.exec(parsed.title) : null;
  if (numbered) {
    const alt = { ...parsed, title: numbered[1], absolute: [Number(numbered[2])] };
    const altCands = lookup(alt);
    if (altCands.length) {
      parsed = alt;
      cands = altCands;
      absCheck = alt.absolute[0];
    }
  }
  const others = cands
    .slice(1)
    .map((c) => ({ tvdbId: c.tvdbId, title: ctx.index.library(c.tvdbId)?.title ?? c.matchedTitle, score: c.score }));
  if (!cands.length)
    return {
      parsed,
      candidate: null,
      resolution: null,
      others,
      summary: `"${parsed.title}" is not a known title${opts.tvdbId !== undefined ? " for this show" : ""}`,
    };
  // Try candidates in order; the first that resolves wins (a library show that can't hold the episode loses to one that can).
  let first: { c: Candidate; r: Resolution } | null = null;
  for (const c of cands.slice(0, 4)) {
    let r = resolveRelease(parsed, c, ctx.episodesFor(c.tvdbId), {
      entries: ctx.entriesFor?.(c.tvdbId) ?? ctx.index.entriesFor(c.tvdbId),
      rules: ctx.rulesFor?.(c.tvdbId),
      publishDate: opts.publishDate ?? null,
      now: ctx.now,
      expect: opts.expect,
    });
    if (absCheck !== null && r.ok && !(r.episodes.length === 1 && r.episodes[0].absolute === absCheck))
      r = { ...r, ok: false, why: [...r.why, `${absCheck} isn't the absolute number of ${r.label}`] };
    first ??= { c, r };
    if (r.ok) {
      const title = ctx.index.library(c.tvdbId)?.title ?? c.matchedTitle;
      return {
        parsed,
        candidate: c,
        resolution: r,
        others: others.filter((o) => o.tvdbId !== c.tvdbId),
        summary: `${title} ${r.label} (${r.confidence}%)`,
      };
    }
  }
  // The fallback found no show that confirms the number: the name stays unknown, as without it.
  if (absCheck !== null)
    return {
      parsed: original,
      candidate: null,
      resolution: null,
      others: [],
      summary: `"${original.title}" is not a known title${opts.tvdbId !== undefined ? " for this show" : ""}`,
    };
  const title = ctx.index.library(first!.c.tvdbId)?.title ?? first!.c.matchedTitle;
  return { parsed, candidate: first!.c, resolution: first!.r, others, summary: `${title}: ${first!.r.why.at(-1)}` };
}
