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

export function identify(name: string, ctx: IdentifyContext, opts: { publishDate?: number | null; tvdbId?: number; parsed?: ParsedRelease } = {}): Identification {
  const parsed = opts.parsed ?? parseRelease(name);
  let cands = ctx.index.lookup(parsed.title, parsed.altTitles);
  if (opts.tvdbId !== undefined) cands = cands.filter((c) => c.tvdbId === opts.tvdbId);
  const others = cands.slice(1).map((c) => ({ tvdbId: c.tvdbId, title: ctx.index.library(c.tvdbId)?.title ?? c.matchedTitle, score: c.score }));
  if (!cands.length) return { parsed, candidate: null, resolution: null, others, summary: `"${parsed.title}" is not a known title${opts.tvdbId !== undefined ? " for this show" : ""}` };
  // Try candidates in order; the first that resolves wins (a library show that can't hold the episode loses to one that can).
  let first: { c: Candidate; r: Resolution } | null = null;
  for (const c of cands.slice(0, 4)) {
    const r = resolveRelease(parsed, c, ctx.episodesFor(c.tvdbId), { entries: ctx.entriesFor?.(c.tvdbId) ?? ctx.index.entriesFor(c.tvdbId), rules: ctx.rulesFor?.(c.tvdbId), publishDate: opts.publishDate ?? null, now: ctx.now });
    first ??= { c, r };
    if (r.ok) {
      const title = ctx.index.library(c.tvdbId)?.title ?? c.matchedTitle;
      return { parsed, candidate: c, resolution: r, others: others.filter((o) => o.tvdbId !== c.tvdbId), summary: `${title} ${r.label} (${r.confidence}%)` };
    }
  }
  const title = ctx.index.library(first!.c.tvdbId)?.title ?? first!.c.matchedTitle;
  return { parsed, candidate: first!.c, resolution: first!.r, others, summary: `${title}: ${first!.r.why.at(-1)}` };
}
