/**
 * Deep Search (PROPOSAL §7.1): an alias-expanded Prowlarr search for specific episodes, with every result parsed,
 * mapped to Sonarr episodes by the numbering resolver and ranked against the language profile.
 * Read-only: searching never grabs anything.
 */
import { indexerHealth } from "./health.js";
import { prowlarrSearch, type ProwlarrRelease } from "./arr/prowlarr.js";
import { identify, type IdentifyContext } from "./core/identify.js";
import { normalizeTitle, splitSeason } from "./core/normalize.js";
import { rankRelease, compareRanked, type Known, type Ranked } from "./core/rank.js";
import type { LibEpisode, NumberingRule } from "./core/resolver.js";
import { burnedInFact, coverFor, seasonResolution } from "./audit.js";
import { cache, db } from "./db.js";
import { learnedFor, sourceKey } from "./library.js";
import { aliasIndex } from "./metadata.js";
import { profileFor } from "./profiles.js";

export function episodesFor(tvdbId: number): LibEpisode[] {
  const rows = cache.prepare("SELECT e.id, e.season, e.episode, e.absolute, e.scene_season, e.scene_episode, e.scene_absolute, e.air_utc, e.title, e.has_file, e.monitored, e.runtime FROM episodes e JOIN series s ON s.id = e.series_id WHERE s.tvdb_id = ?").all(tvdbId) as {
    id: number; season: number; episode: number; absolute: number | null; scene_season: number | null; scene_episode: number | null; scene_absolute: number | null; air_utc: number | null; title: string | null; has_file: number; monitored: number; runtime: number | null;
  }[];
  return rows.map((r) => ({ id: r.id, season: r.season, episode: r.episode, absolute: r.absolute, sceneSeason: r.scene_season, sceneEpisode: r.scene_episode, sceneAbsolute: r.scene_absolute, airUtc: r.air_utc, title: r.title, hasFile: !!r.has_file, monitored: !!r.monitored, runtime: r.runtime }));
}

export function rulesFor(tvdbId: number): NumberingRule[] {
  return (db.prepare("SELECT grp, mode, season, offset FROM rules WHERE tvdb_id = ? ORDER BY grp IS NULL, id").all(tvdbId) as { grp: string | null; mode: NumberingRule["mode"]; season: number | null; offset: number }[]).map((r) => ({ group: r.grp, mode: r.mode, season: r.season, offset: r.offset }));
}

export function identifyContext(): IdentifyContext {
  return { index: aliasIndex(), episodesFor, rulesFor };
}

export interface SeriesInfo {
  id: number;
  tvdbId: number;
  title: string;
  path: string;
  originalLanguage: string | null;
  cover: string | null;
}
export function seriesByTvdb(tvdbId: number): SeriesInfo | null {
  const r = cache.prepare("SELECT id, tvdb_id, title, path, original_language, poster FROM series WHERE tvdb_id = ?").get(tvdbId) as { id: number; tvdb_id: number; title: string; path: string; original_language: string | null; poster: string | null } | undefined;
  return r ? { id: r.id, tvdbId: r.tvdb_id, title: r.title, path: r.path, originalLanguage: r.original_language, cover: coverFor({ tvdb_id: r.tvdb_id, poster: r.poster }) } : null;
}

export interface SearchResult {
  guid: string;
  title: string;
  indexer: string;
  indexerId: number;
  protocol: "usenet" | "torrent";
  size: number;
  seeders: number | null;
  publishDate: string | null;
  ageHours: number | null;
  /** Sonarr episodes the release maps to. */
  episodeIds: number[];
  label: string;
  confidence: number;
  coversTarget: boolean;
  /** More episodes than asked for (a pack or batch). */
  extra: number;
  rank: Ranked;
  mappingWhy: string[];
  group: string | null;
  downloadUrl?: string;
  magnetUrl?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The query grid: every useful title × numbering form, capped by a budget. */
export function queryGrid(titles: string[], targets: LibEpisode[], budget = 18): string[] {
  const qs = new Set<string>();
  const seasons = [...new Set(targets.map((t) => t.season))];
  const single = targets.length === 1 ? targets[0] : null;
  // Titles: indexers match whole tokens, so "Quanzhi Fashi" and "Quan Zhi Fa Shi" are different queries. Keep distinct
  // token forms (not compact keys), drop titles that carry their own season marker, short Latin ones first.
  const seen = new Set<string>();
  const list = titles
    .map((t) => t.replace(/[:!?'’"]/g, " ").replace(/\s+/g, " ").trim())
    .filter((t) => t.length >= 3 && /^[ -~À-ɏ]+$/.test(t))
    .filter((t) => splitSeason(t).season === null)
    .filter((t) => {
      const k = normalizeTitle(t);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.length - b.length)
    .slice(0, 6);
  // Pass 1: bare titles (some indexers only return a show's full list for the plain title), pass 2: numbered forms.
  for (const t of list) qs.add(t);
  for (const t of list) {
    for (const s of seasons) if (s > 0) qs.add(`${t} S${s}`); // catches S6E01, "S6 - 01", S06 packs
    if (single) {
      qs.add(`${t} ${pad(single.episode)}`); // "- 01" per-entry naming
      if (single.absolute && single.absolute !== single.episode) qs.add(`${t} ${single.absolute}`);
      if (single.season > 0) qs.add(`${t} S${pad(single.season)}E${pad(single.episode)}`);
    }
    if (qs.size >= budget) break;
  }
  return [...qs].slice(0, budget);
}

/**
 * Combined "romaji + English" titles, searched across ALL categories: some uploads are named
 * "Quan.Zhi.Fa.Shi.S6.-.1-12.-.Full-Time.Magister" and filed under odd indexer categories.
 */
export function comboQueries(titles: string[], libraryTitle: string, max = 3): string[] {
  const lib = normalizeTitle(libraryTitle);
  const others = [...new Set(titles.map((t) => t.replace(/[:!?'’"]/g, " ").replace(/\s+/g, " ").trim()))]
    .filter((t) => normalizeTitle(t) !== lib && splitSeason(t).season === null && /^[ -~]+$/.test(t))
    .sort((a, b) => a.length - b.length);
  return others.slice(0, max).map((t) => `${t} ${libraryTitle}`);
}

/** Facts and library knowledge about one candidate. */
function knownFor(r: ProwlarrRelease, series: SeriesInfo, season: number | null, groupLess: boolean): Known {
  const k: Known = {};
  const prof = profileFor(series.tvdbId);
  for (const lang of prof.subLangs) {
    const f = burnedInFact(series.tvdbId, season, lang);
    if (f && groupLess) k.burnedIn = { lang, resolution: season !== null ? seasonResolution(series.id, season) : null, note: f.note || `you confirmed season ${season} has burned-in subs` };
  }
  const bl = db.prepare("SELECT reason FROM blocklist WHERE release = ? OR (guid IS NOT NULL AND guid = ?) LIMIT 1").get(r.title, r.guid) as { reason: string } | undefined;
  if (bl) k.blocklisted = bl.reason;
  const scene = cache.prepare("SELECT 1 FROM files WHERE series_id = ? AND scene_name = ? LIMIT 1").get(series.id, r.title.replace(/-xpost$/i, ""));
  if (scene) k.inLibrary = true;
  k.indexerHealth = indexerHealth(r.indexerId);
  return k;
}

/** Short, search-friendly form of a long title: "Magic Repo Man: Dumped by My Party, ..." → "Magic Repo Man". */
export function shortTitle(t: string): string {
  const clean = t.replace(/[!?'’"]/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length <= 40) return clean.replace(/:/g, " ").replace(/\s+/g, " ").trim();
  const head = clean.split(/[:：–—]|\s-\s/)[0].trim();
  return head.length >= 4 ? head : clean.slice(0, 40);
}

/**
 * Tier 1: the canonical title and the top romaji title, with the episode forms groups actually use
 * (S01E01 and "- 01"), or the season form for several episodes. 2-4 queries; most searches end here.
 */
export function tier1Queries(canonical: string, romaji: string | null, targets: LibEpisode[]): string[] {
  const titles = [...new Map([canonical, romaji].filter((x): x is string => !!x).map(shortTitle).filter((t) => t.length >= 3).map((t) => [normalizeTitle(t), t])).values()];
  const out = new Set<string>();
  const seasons = [...new Set(targets.map((t) => t.season))];
  for (const t of titles) {
    if (targets.length === 1) {
      const e = targets[0];
      if (e.season > 0) out.add(`${t} S${pad(e.season)}E${pad(e.episode)}`);
      out.add(`${t} ${pad(e.episode)}`);
    } else for (const s of seasons) out.add(s > 0 ? `${t} S${s}` : t);
  }
  return [...out];
}

export interface SearchProgress {
  searched: number;
  total: number;
  tier: 1 | 2;
  found: number;
  results: SearchResult[];
}

export async function deepSearch(tvdbId: number, episodeIds: number[], opts: { extraQueries?: string[]; budget?: number; full?: boolean; onProgress?: (p: SearchProgress) => void } = {}) {
  const series = seriesByTvdb(tvdbId);
  if (!series) throw Object.assign(new Error("That series isn't in the synced library; run Sync first"), { statusCode: 404 });
  const all = episodesFor(tvdbId);
  const targets = all.filter((e) => episodeIds.includes(e.id));
  if (!targets.length) throw Object.assign(new Error("Pick at least one episode"), { statusCode: 400 });
  const ctx = identifyContext();
  const titles = ctx.index.titlesFor(tvdbId, targets[0].season);
  const season = targets[0].season;
  const entry = ctx.index.anidbIdsFor(tvdbId).sort((x, y) => Number(y.season === season) - Number(x.season === season))[0];
  const romaji = entry ? ctx.index.anidbTitle(entry.aid) : null;
  const tier1 = [...tier1Queries(series.title, romaji, targets), ...(opts.extraQueries ?? [])];
  const combos = comboQueries(titles, series.title);
  const allCats = new Set(combos);
  const started = Date.now();
  const raw = new Map<string, ProwlarrRelease>();
  const errors: string[] = [];
  const prof = profileFor(tvdbId);
  const targetIds = new Set(targets.map((t) => t.id));
  const runtimeOf = new Map(all.map((e) => [e.id, e.runtime]));
  const results: SearchResult[] = [];
  const skipped: Record<string, number> = {};
  const queries: string[] = [];
  let searched = 0;
  let total = tier1.length;
  let tier: 1 | 2 = 1;

  /** Parses, maps and ranks one release as soon as it arrives (so partial results can be shown). */
  const consider = (r: ProwlarrRelease) => {
    const pub = r.publishDate ? Date.parse(r.publishDate) : null;
    const id = identify(r.title, ctx, { tvdbId, publishDate: pub });
    if (!id.resolution?.ok) {
      const reason = !id.candidate ? "other show" : "couldn't map the episode";
      skipped[reason] = (skipped[reason] ?? 0) + 1;
      return;
    }
    const eps = id.resolution.episodes;
    const covers = eps.filter((e) => targetIds.has(e.id)).length;
    if (!covers) {
      skipped["other episodes"] = (skipped["other episodes"] ?? 0) + 1;
      return;
    }
    const ss = eps[0]?.season ?? null;
    const known = knownFor(r, series, ss, !id.parsed.group);
    const learned = learnedFor(id.parsed.group, id.parsed.platform ?? sourceKey(r.title, null, id.parsed.source));
    const rank = rankRelease(id.parsed, { protocol: r.protocol, size: r.size, seeders: r.seeders ?? null, indexer: r.indexer, episodeCount: eps.length, runtimeMin: runtimeOf.get(eps[0]?.id) ?? null }, prof, learned, known);
    results.push({
      guid: r.guid,
      title: r.title,
      indexer: r.indexer,
      indexerId: r.indexerId,
      protocol: r.protocol,
      size: r.size,
      seeders: r.protocol === "torrent" ? (r.seeders ?? null) : null,
      publishDate: r.publishDate ?? null,
      ageHours: pub ? Math.round((Date.now() - pub) / 3_600_000) : null,
      episodeIds: eps.map((e) => e.id),
      label: id.resolution.label,
      confidence: id.resolution.confidence,
      coversTarget: covers === targets.length,
      extra: eps.length - covers,
      rank,
      mappingWhy: id.resolution.why,
      group: id.parsed.group,
      downloadUrl: r.downloadUrl,
      magnetUrl: r.magnetUrl,
    });
  };
  const sorted = () => [...results].sort((a, b) => compareRanked(a, b) || a.extra - b.extra);
  const report = () => opts.onProgress?.({ searched, total, tier, found: raw.size, results: sorted() });

  const run = async (list: string[]) => {
    let i = 0;
    await Promise.all(
      Array.from({ length: Math.min(6, list.length) }, async () => {
        while (i < list.length) {
          const q = list[i++];
          try {
            for (const r of await prowlarrSearch(q, allCats.has(q) ? { categories: [] } : {}))
              if (!raw.has(r.guid)) {
                raw.set(r.guid, r);
                consider(r);
              }
          } catch (e) {
            errors.push(`${q}: ${(e as Error).message}`);
          }
          searched++;
          report();
        }
      }),
    );
  };

  queries.push(...tier1);
  report();
  await run(tier1);
  // Tier 2 only when tier 1 left a target episode without a usable candidate (or when asked for the full search).
  const usable = (eid: number) => results.some((r) => r.rank.accept && r.confidence >= 60 && r.episodeIds.includes(eid));
  const uncovered = targets.filter((t) => !usable(t.id));
  if (opts.full || uncovered.length) {
    tier = 2;
    const done = new Set(queries);
    const more = [...queryGrid(titles, targets, opts.budget), ...(opts.budget && opts.budget < 10 ? [] : combos)].filter((q) => !done.has(q));
    queries.push(...more);
    total += more.length;
    report();
    await run(more);
  }
  const final = sorted();
  return {
    series: { tvdbId: series.tvdbId, title: series.title, cover: series.cover },
    targets: targets.map((t) => ({ id: t.id, season: t.season, episode: t.episode, absolute: t.absolute, title: t.title ?? null, hasFile: !!t.hasFile })),
    queries,
    tier,
    /** True when the wider alias grid was searched too (tier 2); otherwise "Search more" can widen it. */
    complete: tier === 2,
    found: raw.size,
    matched: final.length,
    skipped,
    errors,
    tookMs: Date.now() - started,
    results: final,
  };
}

/** Short "picked X because..., skipped Y because..." summary for the activity log. */
export function decisionSummary(results: SearchResult[]): { best: SearchResult | null; why: string } {
  const best = results.find((r) => r.rank.accept) ?? null;
  const skipped = results.filter((r) => !r.rank.accept).slice(0, 3);
  const parts: string[] = [];
  if (best) parts.push(`picked ${best.title}: ${best.rank.why} → ${best.label} (${best.confidence}% sure of the episode)`);
  else parts.push("nothing acceptable found");
  for (const s of skipped) parts.push(`skipped ${s.title}: ${s.rank.reject}`);
  return { best, why: parts.join("; ") };
}
