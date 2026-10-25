import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AliasIndex, type LibSeries } from "../server/core/aliases.js";
import { parseAnidbTitles, parseAnimeList } from "../server/core/animedata.js";
import type { IdentifyContext } from "../server/core/identify.js";
import type { LibEpisode } from "../server/core/resolver.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

interface FixtureLibrary {
  series: LibSeries[];
  episodes: Record<string, (Omit<LibEpisode, "airUtc"> & { airUtc: string | null })[]>;
}

/** Real data snapshot (2026-10-25): 7 Sonarr series with episodes, plus the matching AniDB / Anime-Lists entries. */
export function fixtureContext(now = Date.parse("2026-10-25T12:00:00Z")): IdentifyContext & { library: FixtureLibrary } {
  const library = JSON.parse(fs.readFileSync(path.join(dir, "library.json"), "utf8")) as FixtureLibrary;
  const anidb = parseAnidbTitles(fs.readFileSync(path.join(dir, "anidb-titles.xml"), "utf8"));
  const animeList = parseAnimeList(fs.readFileSync(path.join(dir, "anime-list.xml"), "utf8"));
  const index = new AliasIndex({ library: library.series, anidb, animeList });
  const eps = new Map<number, LibEpisode[]>();
  for (const [tvdb, list] of Object.entries(library.episodes)) eps.set(Number(tvdb), list.map((e) => ({ ...e, airUtc: e.airUtc ? Date.parse(e.airUtc) : null })));
  return { index, library, now, episodesFor: (t) => eps.get(t) ?? [] };
}
