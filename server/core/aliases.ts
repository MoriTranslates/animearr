/**
 * Alias index (PROPOSAL §6.2): every known title → candidate series, keyed by spaceless normalised keys.
 * Sources, strongest first: user aliases, the library's own titles, Sonarr's alternate titles, learned aliases,
 * AniDB titles (main/official > synonym > short). The user's library is preferred over the global AniDB index.
 * Pure: built from plain inputs so it can be unit-tested with fixtures.
 */
import { anidbToTvdb, type AnidbAnime, type AnimeListEntry } from "./animedata.js";
import { compactKey, lookupKeys, splitSeason } from "./normalize.js";

export interface LibSeries {
  seriesId: number;
  tvdbId: number;
  title: string;
  path: string;
  seriesType?: string;
  originalLanguage?: string | null;
  /** Sonarr alternate titles; sceneSeason = the scene/fan season the title implies. */
  altTitles: { title: string; sceneSeason: number | null }[];
}

export interface UserAlias {
  title: string;
  tvdbId: number;
  /** TVDB season the alias implies, or null. */
  season: number | null;
  source: "user" | "learned";
}

export type HitSource = "user" | "library" | "library-alt" | "learned" | "anidb-main" | "anidb-official" | "anidb-syn" | "anidb-short";
const WEIGHT: Record<HitSource, number> = { user: 100, library: 96, "library-alt": 92, learned: 88, "anidb-main": 84, "anidb-official": 84, "anidb-syn": 76, "anidb-short": 60 };

interface RawHit {
  source: HitSource;
  title: string;
  tvdbId: number | null;
  aid: number | null;
  /** Season the title itself implies (alias season, Sonarr scene season, or season suffix of the key). */
  season: number | null;
  /** TVDB season of the AniDB entry, from Anime-Lists (null when unmapped). */
  entrySeason: number | "a" | null;
  entryOffset: number;
  /** Stored under the base key of a season-suffixed title ("Quanzhi Fashi VII" → "quanzhifashi", season 7). */
  fromSuffix?: boolean;
}

export interface Candidate {
  tvdbId: number;
  seriesId: number | null;
  aid: number | null;
  /** Season implied by the alias (fan/scene season for library alts and suffixes; null if none). */
  impliedSeason: number | null;
  /** When the alias is an AniDB entry mapped by Anime-Lists: its TVDB season and episode offset. */
  entry: { aid: number; season: number | "a"; offset: number } | null;
  score: number;
  inLibrary: boolean;
  matchedTitle: string;
  source: HitSource;
  inferred: boolean;
  why: string[];
}

export class AliasIndex {
  private keys = new Map<string, RawHit[]>();
  private libByTvdb = new Map<number, LibSeries>();
  private anidb: Map<number, AnidbAnime>;
  private animeList: Map<number, AnimeListEntry>;

  constructor(input: { library: LibSeries[]; anidb?: Map<number, AnidbAnime>; animeList?: Map<number, AnimeListEntry>; userAliases?: UserAlias[] }) {
    this.anidb = input.anidb ?? new Map();
    this.animeList = input.animeList ?? new Map();
    for (const s of input.library) this.libByTvdb.set(s.tvdbId, s);

    for (const a of input.userAliases ?? []) this.addTitle(a.title, { source: a.source, title: a.title, tvdbId: a.tvdbId, aid: null, season: a.season, entrySeason: null, entryOffset: 0 });
    for (const s of input.library) {
      this.addTitle(s.title, { source: "library", title: s.title, tvdbId: s.tvdbId, aid: null, season: null, entrySeason: null, entryOffset: 0 });
      for (const alt of s.altTitles) this.addTitle(alt.title, { source: "library-alt", title: alt.title, tvdbId: s.tvdbId, aid: null, season: alt.sceneSeason !== null && alt.sceneSeason >= 1 ? alt.sceneSeason : null, entrySeason: null, entryOffset: 0 });
    }
    for (const a of this.anidb.values()) {
      const al = this.animeList.get(a.aid);
      for (const t of a.titles) {
        if (t.type === "kana") continue;
        const source: HitSource = t.type === "main" ? "anidb-main" : t.type === "official" ? "anidb-official" : t.type === "short" ? "anidb-short" : "anidb-syn";
        this.addTitle(t.title, { source, title: t.title, tvdbId: al?.tvdbId ?? null, aid: a.aid, season: null, entrySeason: al?.defaultSeason ?? null, entryOffset: al?.offset ?? 0 });
      }
    }
  }

  private addTitle(title: string, hit: RawHit) {
    for (const k of lookupKeys(title)) {
      if (!k.key) continue;
      const h: RawHit = k.season !== null ? { ...hit, season: hit.season ?? k.season, fromSuffix: true } : hit;
      const arr = this.keys.get(k.key) ?? [];
      if (!arr.some((x) => x.source === h.source && x.tvdbId === h.tvdbId && x.aid === h.aid && x.season === h.season && !!x.fromSuffix === !!h.fromSuffix)) arr.push(h);
      this.keys.set(k.key, arr);
    }
  }

  get size() {
    return this.keys.size;
  }

  library(tvdbId: number) {
    return this.libByTvdb.get(tvdbId) ?? null;
  }

  /** Every title variant for a series (for alias-expanded search): library titles, alternates, user aliases, AniDB titles. */
  titlesFor(tvdbId: number, season?: number): string[] {
    const out = new Set<string>();
    const lib = this.libByTvdb.get(tvdbId);
    if (lib) {
      out.add(lib.title);
      for (const a of lib.altTitles) if (a.sceneSeason === null || a.sceneSeason < 1 || season === undefined || a.sceneSeason === season) out.add(a.title);
    }
    for (const [, hits] of this.keys) for (const h of hits) if (h.tvdbId === tvdbId && (h.source === "user" || h.source === "learned")) out.add(h.title);
    for (const e of this.animeList.values()) {
      if (e.tvdbId !== tvdbId) continue;
      if (season !== undefined && e.defaultSeason !== season && e.defaultSeason !== 1 && !(e.defaultSeason === "a")) continue;
      for (const t of this.anidb.get(e.aid)?.titles ?? []) if ((t.type === "main" || t.type === "official" || t.type === "syn") && /^[\x20-\x7eÀ-ɏ]+$/.test(t.title)) out.add(t.title);
    }
    return [...out];
  }

  /** Raw key lookup across all variants of a title. */
  private hits(title: string): { hit: RawHit; keySeason: number | null; exact: boolean }[] {
    const out: { hit: RawHit; keySeason: number | null; exact: boolean }[] = [];
    const full = compactKey(title);
    for (const k of lookupKeys(title)) for (const h of this.keys.get(k.key) ?? []) out.push({ hit: h, keySeason: k.season, exact: k.key === full });
    return out;
  }

  /**
   * Candidates for a parsed title (plus any alternative titles found in the release name).
   * Unmapped AniDB entries (new seasons Anime-Lists doesn't know yet) are inferred from their base title:
   * "Quanzhi Fashi VII" → base "Quanzhi Fashi" (TVDB 328670) + season 7, marked inferred.
   */
  lookup(title: string, altTitles: string[] = []): Candidate[] {
    const byTvdb = new Map<number, Candidate>();
    const consider = (h: RawHit, keySeason: number | null, exact: boolean, viaAlt: boolean) => {
      let tvdbId = h.tvdbId;
      let inferred = false;
      // A season suffix in the query itself ("... VII", "... S7") beats a season stored on the alias.
      let impliedSeason = keySeason ?? h.season;
      const why: string[] = [];
      // A suffixed title reached through its base key ("Re Zero ... 2nd Season" found by "Re Zero ...") only points at
      // the franchise: it implies no season unless the query carried the same suffix.
      let franchiseOnly = false;
      if (h.fromSuffix && keySeason !== h.season) {
        impliedSeason = keySeason;
        franchiseOnly = true;
      }
      if (tvdbId === null && h.aid !== null && !franchiseOnly) {
        // Unmapped AniDB entry: infer from the base of its main title.
        const main = this.anidb.get(h.aid)?.titles.find((t) => t.type === "main")?.title ?? h.title;
        const split = splitSeason(main);
        if (split.season === null) return;
        const base = this.keys.get(split.base.replace(/ /g, "")) ?? [];
        const mapped = base.find((b) => b.tvdbId !== null && (b.source === "library" || b.source === "library-alt" || b.source.startsWith("anidb")));
        if (!mapped?.tvdbId) return;
        tvdbId = mapped.tvdbId;
        impliedSeason = split.season;
        inferred = true;
        why.push(`AniDB ${h.aid} "${main}" has no TVDB mapping yet; inferred season ${split.season} of "${mapped.title}" from its title`);
      }
      if (tvdbId === null) return;
      const lib = this.libByTvdb.get(tvdbId);
      const score = WEIGHT[h.source] - (exact ? 0 : 4) - (viaAlt ? 3 : 0) - (inferred ? 6 : 0) - (franchiseOnly ? 10 : 0) + (lib ? 0 : -15);
      const entry = h.aid !== null && h.entrySeason !== null && !inferred && !franchiseOnly ? { aid: h.aid, season: h.entrySeason, offset: h.entryOffset } : null;
      why.unshift(`title "${h.title}" (${h.source.replace("-", " ")}${h.aid ? `, AniDB ${h.aid}` : ""})${impliedSeason !== null ? ` implies season ${impliedSeason}` : ""}`);
      const prev = byTvdb.get(tvdbId);
      // Prefer a hit that pins a season/entry over a plain franchise hit of similar strength.
      const specific = (c: { impliedSeason: number | null; entry: unknown }) => (c.impliedSeason !== null || c.entry ? 3 : 0);
      const cand: Candidate = { tvdbId, seriesId: lib?.seriesId ?? null, aid: h.aid, impliedSeason, entry, score, inLibrary: !!lib, matchedTitle: h.title, source: h.source, inferred, why };
      if (!prev || score + specific(cand) > prev.score + specific(prev)) {
        if (prev) cand.why.push(...prev.why.filter((w) => !cand.why.includes(w)).slice(0, 1));
        byTvdb.set(tvdbId, cand);
      } else if (prev.why.length < 3 && !prev.why.includes(why[0])) prev.why.push(why[0]);
    };
    for (const { hit, keySeason, exact } of this.hits(title)) consider(hit, keySeason, exact, false);
    for (const alt of altTitles) for (const { hit, keySeason, exact } of this.hits(alt)) consider(hit, keySeason, exact, true);
    return [...byTvdb.values()].sort((a, b) => Number(b.inLibrary) - Number(a.inLibrary) || b.score - a.score);
  }

  /** AniDB entries mapped to a TVDB series (for the numbering resolver). */
  entriesFor(tvdbId: number): AnimeListEntry[] {
    return [...this.animeList.values()].filter((e) => e.tvdbId === tvdbId);
  }

  anidbTitle(aid: number) {
    return this.anidb.get(aid)?.titles.find((t) => t.type === "main")?.title ?? null;
  }

  /** AniDB ids mapped to a TVDB series, with the TVDB season each covers. */
  anidbIdsFor(tvdbId: number) {
    return this.entriesFor(tvdbId).map((e) => ({ aid: e.aid, season: e.defaultSeason, offset: e.offset, name: e.name, firstEp: anidbToTvdb(e, 1) }));
  }
}
