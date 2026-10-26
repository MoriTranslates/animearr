/**
 * Read-only audits over the synced library (nothing is changed in Sonarr/Radarr).
 * - Missing my language: files with neither a subtitle track nor an audio track in a profile subtitle language.
 * - Gaps: aired, monitored episodes without a file, and whole seasons with nothing (unaired episodes are hidden).
 * - Specials: Season 0 split into real content (OVA/episode/movie) and junk (PVs, recaps, promos...), with movies of
 *   60+ minutes flagged "belongs in Radarr" and whether Radarr already has them.
 */
import { movieSpecials } from "./franchise.js";
import { ownFile, probeOf } from "./mediafiles.js";
import fs from "node:fs";
import path from "node:path";
import { db, cache } from "./db.js";
import { compactKey } from "./core/normalize.js";
import { sidecarLang } from "./core/langs.js";
import { animeListEntries } from "./metadata.js";
import { profileFor } from "./profiles.js";
import { judge } from "./verify.js";
import { localPath } from "./paths.js";

interface SeriesRow {
  id: number;
  tvdb_id: number;
  title: string;
  path: string;
  monitored: number;
  status: string;
  poster: string | null;
  seasons: string;
  original_language: string | null;
}

const seriesRows = () => cache.prepare("SELECT id, tvdb_id, title, path, monitored, status, poster, seasons, original_language FROM series ORDER BY sort_title").all() as unknown as SeriesRow[];

export function coverFor(s: { tvdb_id: number; poster: string | null }): string | null {
  // AniList art when mapped (newest entry first), else Sonarr's poster.
  const aids = animeListEntriesFor(s.tvdb_id);
  for (const aid of aids) {
    const c = cache.prepare("SELECT cover FROM covers WHERE anidb_id = ? AND cover IS NOT NULL").get(aid) as { cover: string } | undefined;
    if (c) return c.cover;
  }
  return s.poster;
}
function animeListEntriesFor(tvdbId: number): number[] {
  const out: { aid: number; season: number }[] = [];
  for (const e of animeListEntries().values()) if (e.tvdbId === tvdbId) out.push({ aid: e.aid, season: typeof e.defaultSeason === "number" ? e.defaultSeason : 0 });
  return out.sort((a, b) => b.season - a.season).map((x) => x.aid);
}

// ---------------------------------------------------------------- facts the user confirmed

export interface Fact {
  id: number;
  tvdbId: number;
  season: number | null;
  kind: "burned_in" | "no_release";
  lang: string;
  note: string;
  at: number;
}
export function listFacts(tvdbId?: number): Fact[] {
  const rows = (tvdbId ? db.prepare("SELECT * FROM facts WHERE tvdb_id = ?").all(tvdbId) : db.prepare("SELECT * FROM facts").all()) as { id: number; tvdb_id: number; season: number | null; kind: Fact["kind"]; lang: string; note: string; at: number }[];
  return rows.map((r) => ({ id: r.id, tvdbId: r.tvdb_id, season: r.season, kind: r.kind, lang: r.lang, note: r.note, at: r.at }));
}
export function burnedInFact(tvdbId: number, season: number | null, lang: string) {
  return listFacts(tvdbId).find((f) => f.kind === "burned_in" && f.lang === lang && (f.season === null || f.season === season)) ?? null;
}

/** Most common resolution of the library files of a season ("1280x720" → "720p"). */
export function seasonResolution(seriesId: number, season: number): string | null {
  const rows = cache.prepare("SELECT resolution, COUNT(*) AS n FROM files WHERE series_id = ? AND season = ? AND resolution IS NOT NULL GROUP BY resolution ORDER BY n DESC").all(seriesId, season) as { resolution: string; n: number }[];
  const r = rows[0]?.resolution;
  const h = r ? Number(r.split("x")[1]) : NaN;
  if (!Number.isFinite(h)) return null;
  return h >= 2000 ? "2160p" : h >= 1000 ? "1080p" : h >= 700 ? "720p" : h >= 560 ? "576p" : "480p";
}

// ---------------------------------------------------------------- missing my language

export interface MissingGroup {
  seriesId: number;
  tvdbId: number;
  title: string;
  cover: string | null;
  season: number;
  files: { id: number; path: string; name: string; group: string | null; audio: string[]; subs: string[]; sidecar: string | null; reason: string }[];
  /** User confirmed burned-in subs in a profile language for this season. */
  confirmedBurnedIn: boolean;
}

function sidecarFor(videoPath: string, langs: string[]): string | null {
  const local = localPath(videoPath);
  if (!local) return null;
  try {
    const dir = path.dirname(local);
    const base = path.basename(local).replace(/\.[^.]+$/, "");
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(base) || f === path.basename(local)) continue;
      const l = sidecarLang(f);
      if (l && langs.includes(l)) return f;
    }
  } catch {
    /* share not reachable */
  }
  return null;
}

export function missingLanguage(opts: { checkSidecars?: boolean } = {}) {
  const def = profileFor(null);
  const out: MissingGroup[] = [];
  let checked = 0;
  for (const s of seriesRows()) {
    const prof = profileFor(s.tvdb_id);
    const files = cache.prepare("SELECT id, season, path, size, date_added, release_group, audio_langs, sub_langs FROM files WHERE series_id = ? ORDER BY season, path").all(s.id) as { id: number; season: number; path: string; size: number | null; date_added: string | null; release_group: string | null; audio_langs: string; sub_langs: string }[];
    const bySeason = new Map<number, MissingGroup>();
    for (const f of files) {
      checked++;
      // AnimeArr's own scan first (it sees forced flags and sidecars); Sonarr's mediaInfo otherwise.
      const own = ownFile(f.path, { size: f.size, dateAdded: f.date_added });
      const p = own ? probeOf(own) : null;
      const subs = p ? p.subs : f.sub_langs.split("/").filter(Boolean);
      const audio = p ? p.audio : f.audio_langs.split("/").filter(Boolean);
      const v = judge(p ? { ...p, durationSec: null } : { subs, audio, durationSec: null, sidecars: [], untagged: 0 }, prof, null, null);
      if (v.ok) continue;
      const sidecar = opts.checkSidecars && prof.watchMode !== "dub" ? sidecarFor(f.path, prof.subLangs) : null;
      if (sidecar) continue;
      const reason = !subs.length && !audio.length ? "no track languages recorded (MP4 with burned-in or sidecar subs?)" : v.why;
      // (Without our own scan, Sonarr's mediaInfo has no forced flag: a forced-only track can look like full subtitles.)
      const g = bySeason.get(f.season) ?? { seriesId: s.id, tvdbId: s.tvdb_id, title: s.title, cover: null, season: f.season, files: [], confirmedBurnedIn: prof.subLangs.some((l) => !!burnedInFact(s.tvdb_id, f.season, l)) };
      g.files.push({ id: f.id, path: f.path, name: path.posix.basename(f.path), group: f.release_group, audio, subs, sidecar, reason });
      bySeason.set(f.season, g);
    }
    for (const g of bySeason.values()) out.push({ ...g, cover: coverFor(s) });
  }
  // Movies (Radarr anime), against the default profile.
  const movies = (cache.prepare("SELECT id, tmdb_id, title, year, file, poster FROM movies WHERE is_anime = 1 AND file IS NOT NULL ORDER BY title").all() as { id: number; tmdb_id: number; title: string; year: number; file: string; poster: string | null }[])
    .map((m) => ({ ...m, f: JSON.parse(m.file) as { path: string | null; audio: string[]; subs: string[]; releaseGroup: string | null } }))
    .map((m) => {
      const own = m.f.path ? ownFile(m.f.path) : null;
      return own ? { ...m, f: { ...m.f, audio: probeOf(own).audio, subs: [...new Set([...probeOf(own).subs, ...probeOf(own).sidecars])] }, p: probeOf(own) } : { ...m, p: null };
    })
    .map((m) => ({ ...m, v: judge(m.p ? { ...m.p, durationSec: null } : { subs: m.f.subs, audio: m.f.audio, durationSec: null, sidecars: [], untagged: 0 }, def, null, null) }))
    .filter((m) => !m.v.ok)
    .map((m) => ({ movieId: m.id, tmdbId: m.tmdb_id, title: `${m.title} (${m.year})`, cover: m.poster, path: m.f.path, group: m.f.releaseGroup, audio: m.f.audio, subs: m.f.subs, reason: !m.f.subs.length && !m.f.audio.length ? "no track languages recorded" : m.v.why }));
  return {
    profile: def.watchMode === "dub" ? def.dubLangs : def.subLangs,
    mode: def.watchMode,
    checkedFiles: checked,
    series: out.filter((g) => !g.confirmedBurnedIn),
    confirmed: out.filter((g) => g.confirmedBurnedIn).map((g) => ({ seriesId: g.seriesId, tvdbId: g.tvdbId, title: g.title, season: g.season, files: g.files.length })),
    movies,
  };
}

// ---------------------------------------------------------------- gaps

export function gaps() {
  const now = Date.now();
  const out: { seriesId: number; tvdbId: number; title: string; cover: string | null; status: string; missing: { id: number; season: number; episode: number; absolute: number | null; title: string | null; airUtc: number | null }[]; missingSeasons: { season: number; aired: number; monitored: boolean }[] }[] = [];
  for (const s of seriesRows()) {
    const eps = cache.prepare("SELECT id, season, episode, absolute, title, air_utc, monitored, has_file FROM episodes WHERE series_id = ? AND season > 0 ORDER BY season, episode").all(s.id) as { id: number; season: number; episode: number; absolute: number | null; title: string | null; air_utc: number | null; monitored: number; has_file: number }[];
    const aired = eps.filter((e) => e.air_utc !== null && e.air_utc <= now);
    const missing = aired.filter((e) => e.monitored && !e.has_file);
    const seasons = new Map<number, { aired: number; files: number; monitored: boolean }>();
    for (const e of aired) {
      const x = seasons.get(e.season) ?? { aired: 0, files: 0, monitored: false };
      x.aired++;
      x.files += e.has_file;
      x.monitored ||= !!e.monitored;
      seasons.set(e.season, x);
    }
    const anyFiles = eps.some((e) => e.has_file);
    // A whole season with nothing (only interesting when the show has files elsewhere, i.e. it's being collected).
    const missingSeasons = [...seasons].filter(([, x]) => x.files === 0 && anyFiles).map(([season, x]) => ({ season, aired: x.aired, monitored: x.monitored }));
    const fullyMissing = new Set(missingSeasons.map((m) => m.season));
    const partial = missing.filter((e) => !fullyMissing.has(e.season));
    if (partial.length || missingSeasons.length)
      out.push({ seriesId: s.id, tvdbId: s.tvdb_id, title: s.title, cover: coverFor(s), status: s.status, missing: partial.map((e) => ({ id: e.id, season: e.season, episode: e.episode, absolute: e.absolute, title: e.title, airUtc: e.air_utc })), missingSeasons });
  }
  return { series: out, episodes: out.reduce((n, s) => n + s.missing.length, 0), seasons: out.reduce((n, s) => n + s.missingSeasons.length, 0) };
}

// ---------------------------------------------------------------- specials

const JUNK = /\b(PV|CM|trailer|teaser|promo(?:tion(?:al)?)?|preview|recap|digest|picture drama|mini ?anime|chibi|commentary|music video|MV|opening|ending|NCOP|NCED|creditless|interview|making of|behind the scenes|announcement|web preview|character song|bonus|omake|talk|event|live|stage|radio|countdown|summary|highlights?|blooper|spot)\b/i;
const REAL = /\b(OVA|OAD|ONA|episode\s*\d+(\.\d)?|special episode|movie|film|gekijouban|the movie|extra episode|unaired)\b|劇場版|\d+\.5\b/i;

export type SpecialClass = "movie" | "real" | "junk" | "unknown";
export function classifySpecial(title: string | null, runtime: number | null): { cls: SpecialClass; why: string } {
  const t = title ?? "";
  if (runtime !== null && runtime >= 60) return { cls: "movie", why: `${runtime} min long` };
  if (/\b(movie|film|gekijouban)\b|劇場版/i.test(t) && (runtime === null || runtime >= 40)) return { cls: "movie", why: "titled as a movie" };
  if (JUNK.test(t)) return { cls: "junk", why: `title looks like "${t.match(JUNK)![0]}"` };
  if (runtime !== null && runtime > 0 && runtime < 8) return { cls: "junk", why: `only ${runtime} min` };
  if (REAL.test(t)) return { cls: "real", why: `title looks like "${t.match(REAL)![0]}"` };
  if (runtime !== null && runtime >= 18) return { cls: "real", why: `${runtime} min (episode length)` };
  return { cls: "unknown", why: runtime ? `${runtime} min, title unclear` : "no runtime or clear title" };
}

/** A finer label for a special, for the UI: OVA, Movie, Recap, Promo/PV, Picture drama, Extra episode… */
export function specialType(title: string | null, runtime: number | null): { type: string; cls: SpecialClass } {
  const t = title ?? "";
  const c = classifySpecial(title, runtime);
  if (c.cls === "movie") return { type: "movie", cls: c.cls };
  if (/\b(OVA|OAD)\b/i.test(t)) return { type: "ova", cls: c.cls };
  if (/\bONA\b/i.test(t)) return { type: "ona", cls: c.cls };
  if (/\b(recap|digest|summary|highlights?)\b/i.test(t)) return { type: "recap", cls: "junk" };
  if (/\b(PV|CM|trailer|teaser|promo(tion(al)?)?|preview|announcement|spot|web preview)\b/i.test(t)) return { type: "promo", cls: "junk" };
  if (/\bpicture drama\b/i.test(t)) return { type: "pictureDrama", cls: "junk" };
  if (/\b(NCOP|NCED|creditless|opening|ending|music video|MV|character song)\b/i.test(t)) return { type: "music", cls: "junk" };
  if (c.cls === "junk") return { type: "extra", cls: c.cls };
  if (c.cls === "real") return { type: "episode", cls: c.cls };
  return { type: "special", cls: c.cls };
}

export function specials() {
  const movies = cache.prepare("SELECT id, tmdb_id, title, original_title, year, alt_titles, has_file FROM movies").all() as { id: number; tmdb_id: number | null; title: string; original_title: string | null; year: number; alt_titles: string; has_file: number }[];
  const movieKeys = new Map<string, (typeof movies)[number]>();
  for (const m of movies) for (const t of [m.title, m.original_title ?? "", ...(JSON.parse(m.alt_titles) as string[])]) if (t) movieKeys.set(compactKey(t), m);
  const byTmdb = new Map(movies.filter((m) => m.tmdb_id).map((m) => [m.tmdb_id!, m]));
  const out: { seriesId: number; tvdbId: number; title: string; cover: string | null; items: { id: number; episode: number; title: string | null; runtime: number | null; hasFile: boolean; monitored: boolean; cls: SpecialClass; why: string; radarr: { inRadarr: boolean; title?: string; hasFile?: boolean; movieId?: number } | null }[] }[] = [];
  const totals = { movie: 0, real: 0, junk: 0, unknown: 0, movieInRadarr: 0 };
  const allSpecials = movieSpecials();
  for (const s of seriesRows()) {
    const eps = cache.prepare("SELECT id, episode, title, runtime, has_file, monitored FROM episodes WHERE series_id = ? AND season = 0 ORDER BY episode").all(s.id) as { id: number; episode: number; title: string | null; runtime: number | null; has_file: number; monitored: number }[];
    if (!eps.length) continue;
    const s0Movies = [...animeListEntries().values()].filter((e) => e.tvdbId === s.tvdb_id && e.tmdbMovie);
    const linked = allSpecials;
    const items = eps.map((e) => {
      const fm = linked.get(e.id);
      const c = fm ? { cls: "movie" as SpecialClass, why: "a movie of this franchise (handled by Radarr)" } : classifySpecial(e.title, e.runtime);
      totals[c.cls]++;
      let radarr: { inRadarr: boolean; title?: string; hasFile?: boolean; movieId?: number } | null = null;
      if (c.cls === "movie") {
        const keys = [compactKey(e.title ?? ""), compactKey(`${s.title} ${e.title ?? ""}`)];
        let m = fm?.movieId ? movies.find((x) => x.id === fm.movieId) : keys.map((k) => movieKeys.get(k)).find(Boolean);
        // Anime-Lists may know the TMDB movie id of this franchise's movies.
        if (!m) for (const al of s0Movies) if (byTmdb.has(al.tmdbMovie!) && compactKey(al.name).includes(compactKey(e.title ?? "").slice(0, 12))) m = byTmdb.get(al.tmdbMovie!);
        radarr = m ? { inRadarr: true, title: `${m.title} (${m.year})`, hasFile: !!m.has_file, movieId: m.id } : { inRadarr: false };
        if (m) totals.movieInRadarr++;
      }
      return { id: e.id, episode: e.episode, title: e.title, runtime: e.runtime, hasFile: !!e.has_file, monitored: !!e.monitored, cls: c.cls, why: c.why, radarr };
    });
    out.push({ seriesId: s.id, tvdbId: s.tvdb_id, title: s.title, cover: coverFor(s), items });
  }
  return { series: out, totals };
}
