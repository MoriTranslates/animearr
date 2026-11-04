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
  // When the parsed title is unknown, two readings the parser can't settle without the library get a second try. A
  // fallback show is accepted only when its episodes confirm the reading (`confirm` says why not); otherwise the name
  // stays unknown, exactly as without the fallback, so a shorter title never pulls the release onto a decoy show.
  let confirm = null as ((r: Resolution) => string | null) | null;
  // A fallback that is only a guess from the library: its match is capped below the auto threshold (≤ 70%).
  let guess: string | null = null;
  const retry = (alt: ParsedRelease, check: (r: Resolution) => string | null, guessWhy: string | null = null) => {
    const altCands = lookup(alt);
    if (!altCands.length) return;
    parsed = alt;
    cands = altCands;
    confirm = check;
    guess = guessWhy;
  };
  // "One Piece 1050 S21E1050": the parser keeps a number before SxxEyy in the title ("Mob Psycho 100 S03E05"). Try
  // "Title" + absolute number; the resolved episode must have exactly that absolute number.
  const numbered =
    !cands.length && parsed.episodes.length === 1 && !parsed.absolute.length ? /^(.*\S)\s+(\d{1,4})$/.exec(parsed.title) : null;
  if (numbered) {
    const n = Number(numbered[2]);
    // A name whose N is also its own SxxEyy episode ("Golden Kamuy 4 S01E04") is a sequel, not an absolute number: only
    // a remapped episode (scene numbering) can prove the number.
    const season = parsed.season;
    const ep = parsed.episodes[0];
    retry({ ...parsed, title: numbered[1], absolute: [n] }, (r) =>
      r.episodes.length !== 1 || r.episodes[0].absolute !== n
        ? `${n} isn't the absolute number of ${r.label}`
        : r.episodes[0].season === season && r.episodes[0].episode === ep
          ? `"${numbered[1]} ${n}" is likely a sequel, not "${numbered[1]}" episode ${n}`
          : null,
    );
  }
  // "Show 0 - 12" with no batch word: the parser reads "Show 0", episode 12 ("Steins;Gate 0 - 05"). Try "Show",
  // episodes 0-12; the show must hold every one of them, and a human confirms it (a "Steins;Gate" with an episode 0
  // would also fit "Steins;Gate 0 - 05"). With a batch word the parser reads the range itself.
  const zero = !cands.length && !parsed.episodes.length && parsed.absolute.length === 1 ? /^(.*\S)\s+0$/.exec(parsed.title) : null;
  if (zero && parsed.absolute[0] > 0) {
    const last = parsed.absolute[0];
    retry(
      { ...parsed, title: zero[1], absolute: Array.from({ length: last + 1 }, (_, i) => i), batch: true, fullSeason: false },
      (r) => (r.episodes.length === last + 1 ? null : `the show doesn't hold episodes 0-${last}`),
      `read as episodes 0-${last} of "${zero[1]}" because "${parsed.title}" is not a known title: confirm it by hand`,
    );
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
    const notConfirmed = confirm && r.ok ? confirm(r) : null;
    if (notConfirmed) r = { ...r, ok: false, why: [...r.why, notConfirmed] };
    else if (guess && r.ok) r = { ...r, confidence: Math.min(r.confidence, Math.round(c.score * 0.7)), why: [...r.why, guess] };
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
  if (confirm)
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
