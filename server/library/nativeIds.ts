/**
 * Id ranges of AnimeArr's own (native) shows and movies. A leaf module, so anything can ask "is this one of ours?"
 * without importing native.ts and everything behind it.
 */

/** Cache ids of native shows/episodes/files start here (Sonarr's ids are far below). */
export const NATIVE_BASE = 900_000_000;
/** Synthetic TVDB ids for shows TVDB doesn't have: NATIVE_BASE + AniList id. */
export const isNativeSeriesId = (id: number) => id >= NATIVE_BASE;
export const isNativeMovieId = (id: number) => id >= NATIVE_BASE;
