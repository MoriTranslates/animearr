/**
 * Episode management (Sonarr parity): per-episode status, detail (file, languages, grab history, activity),
 * delete file, re-grab, the series header and the agenda calendar.
 * Destructive actions are user-confirmed in the UI, guarded by the allowed root folders, and logged.
 */
import path from "node:path";
import { listDecisions, logDecision } from "./activity.js";
import * as sonarr from "./arr/sonarr.js";
import { burnedInFact, coverFor } from "./audit.js";
import { parseRelease } from "./core/parser.js";
import { cache, db, dbState } from "./db.js";
import { refreshSeriesEpisodes } from "./library.js";
import { listManaged } from "./managed.js";
import { aliasIndex } from "./metadata.js";
import { startGrab, type Candidate } from "./pipeline.js";
import { deepSearch, episodesFor, seriesByTvdb, type SearchResult } from "./search.js";
import { profileFor } from "./profiles.js";
import { getSettings, isDryRun, underAllowedRoot } from "./settings.js";
import { judge } from "./verify.js";

export type EpisodeStatus = "have" | "missing" | "downloading" | "unaired" | "attention";

export interface FileInfo {
  id: number;
  path: string;
  name: string;
  size: number | null;
  quality: string | null;
  /** AnimeArr's own reading of the source (WEB/BluRay/...), from the release name; Sonarr's label can differ. */
  source: string | null;
  platform: string | null;
  group: string | null;
  sceneName: string | null;
  subs: string[];
  audio: string[];
  runTime: string | null;
  resolution: string | null;
  /** Every episode this file holds ("S01E01", "S01E02" for a multi-episode file). */
  episodes: string[];
}

/** Groups whose releases are web rips even when the name doesn't say so (SubsPlease = CR/ADN web rips). */
const WEB_GROUPS = new Set(["subsplease", "erai-raws", "toonshub", "varyg", "skyanime", "senpai", "kitsune", "asw", "judas"]);
const SOURCE_LABEL: Record<string, string> = { web: "WEB", bluray: "BluRay", hdtv: "HDTV", dvd: "DVD" };

function sourceLabel(sceneName: string | null, group: string | null, sonarrSource: string | null): { source: string | null; platform: string | null } {
  const p = sceneName ? parseRelease(sceneName) : null;
  const g = (group ?? p?.group ?? "").toLowerCase();
  const src = p?.source ?? (WEB_GROUPS.has(g) ? "web" : null) ?? (sonarrSource && /web/i.test(sonarrSource) ? "web" : sonarrSource && /blu/i.test(sonarrSource) ? "bluray" : null);
  return { source: src ? SOURCE_LABEL[src] : null, platform: p?.platform ?? null };
}

type FileRow = { id: number; path: string; size: number | null; quality: string | null; source: string | null; release_group: string | null; scene_name: string | null; audio_langs: string; sub_langs: string; run_time: string | null; resolution: string | null };
function fileInfo(f: FileRow, episodes: string[] = []): FileInfo {
  const s = sourceLabel(f.scene_name, f.release_group, f.source);
  return {
    id: f.id,
    path: f.path,
    name: path.posix.basename(f.path),
    size: f.size,
    quality: f.quality,
    source: s.source,
    platform: s.platform,
    group: f.release_group,
    sceneName: f.scene_name,
    subs: f.sub_langs.split("/").filter(Boolean),
    audio: f.audio_langs.split("/").filter(Boolean),
    runTime: f.run_time,
    resolution: f.resolution,
    episodes,
  };
}

const sxe = (s: number, e: number) => `S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`;

/** Active grabs by episode id (for "downloading 45%" / "needs attention"). */
function grabStates() {
  const out = new Map<number, { state: string; progress: number | null; grabId: number; release: string }>();
  const rows = db.prepare("SELECT id, episode_ids, state, progress, release FROM grabs WHERE state IN ('sending', 'downloading', 'importing', 'needs-attention') ORDER BY id").all() as { id: number; episode_ids: string; state: string; progress: number | null; release: string }[];
  for (const r of rows) for (const e of JSON.parse(r.episode_ids) as number[]) out.set(e, { state: r.state, progress: r.progress, grabId: r.id, release: r.release });
  return out;
}

export interface EpisodeRow {
  id: number;
  season: number;
  episode: number;
  absolute: number | null;
  title: string | null;
  airUtc: number | null;
  runtime: number | null;
  monitored: boolean;
  status: EpisodeStatus;
  progress: number | null;
  file: FileInfo | null;
}

export function episodeRows(seriesId: number): EpisodeRow[] {
  const now = Date.now();
  const active = grabStates();
  const files = new Map((cache.prepare("SELECT * FROM files WHERE series_id = ?").all(seriesId) as FileRow[]).map((f) => [f.id, f]));
  const eps = cache.prepare("SELECT id, season, episode, absolute, title, air_utc, runtime, monitored, has_file, file_id FROM episodes WHERE series_id = ? ORDER BY season DESC, episode DESC").all(seriesId) as {
    id: number; season: number; episode: number; absolute: number | null; title: string | null; air_utc: number | null; runtime: number | null; monitored: number; has_file: number; file_id: number | null;
  }[];
  const byFile = new Map<number, string[]>();
  for (const e of [...eps].reverse()) if (e.file_id) byFile.set(e.file_id, [...(byFile.get(e.file_id) ?? []), sxe(e.season, e.episode)]);
  return eps.map((e) => {
    const g = active.get(e.id);
    const f = e.file_id ? files.get(e.file_id) : undefined;
    let status: EpisodeStatus = e.has_file ? "have" : e.air_utc === null || e.air_utc > now ? "unaired" : "missing";
    if (g) status = g.state === "needs-attention" ? "attention" : "downloading";
    return { id: e.id, season: e.season, episode: e.episode, absolute: e.absolute, title: e.title, airUtc: e.air_utc, runtime: e.runtime, monitored: !!e.monitored, status, progress: g?.progress ?? null, file: f ? fileInfo(f, byFile.get(f.id)) : null };
  });
}

/** The series header: art, synopsis, status, next airing, counts, language health and links. */
export function seriesHeader(tvdbId: number) {
  const s = cache.prepare("SELECT id, tvdb_id, title, year, status, network, overview, genres, poster, path, next_airing, previous_airing, anidb_ids, monitored, runtime FROM series WHERE tvdb_id = ?").get(tvdbId) as
    | { id: number; tvdb_id: number; title: string; year: number | null; status: string; network: string | null; overview: string | null; genres: string; poster: string | null; path: string; next_airing: string | null; previous_airing: string | null; anidb_ids: string; monitored: number; runtime: number | null }
    | undefined;
  if (!s) return null;
  const rows = episodeRows(s.id).filter((e) => e.season > 0);
  const aired = rows.filter((e) => e.status !== "unaired");
  const have = rows.filter((e) => e.status === "have");
  const prof = profileFor(tvdbId);
  const burned = (season: number) => prof.subLangs.find((l) => !!burnedInFact(tvdbId, season, l)) ?? null;
  const withLang = have.filter((e) => e.file && judge({ subs: e.file.subs, audio: e.file.audio, durationSec: null, sidecars: [], untagged: 0 }, prof, null, burned(e.season)).ok);
  const aids = (JSON.parse(s.anidb_ids) as { aid: number; season: number | "a" | null }[]).sort((a, b) => Number(b.season ?? 0) - Number(a.season ?? 0));
  const cov = aids.length ? (cache.prepare(`SELECT anilist_id, cover, banner, color FROM covers WHERE anidb_id IN (${aids.map(() => "?").join(",")}) AND cover IS NOT NULL`).all(...aids.map((a) => a.aid)) as { anilist_id: number; cover: string; banner: string | null; color: string | null }[]) : [];
  const next = rows.filter((e) => e.status === "unaired" && e.airUtc).sort((a, b) => a.airUtc! - b.airUtc!)[0] ?? null;
  return {
    seriesId: s.id,
    tvdbId: s.tvdb_id,
    title: s.title,
    year: s.year,
    status: s.status,
    network: s.network,
    overview: s.overview,
    genres: JSON.parse(s.genres) as string[],
    path: s.path,
    cover: coverFor({ tvdb_id: s.tvdb_id, poster: s.poster }),
    banner: cov.find((c) => c.banner)?.banner ?? null,
    color: cov[0]?.color ?? null,
    nextEpisode: next ? { id: next.id, season: next.season, episode: next.episode, title: next.title, airUtc: next.airUtc } : null,
    counts: { have: have.length, aired: aired.length, missing: rows.filter((e) => e.status === "missing").length, downloading: rows.filter((e) => e.status === "downloading").length, total: rows.length },
    language: { lang: (prof.watchMode === "dub" ? prof.dubLangs[0] : prof.subLangs[0]) ?? "en", withLang: withLang.length, have: have.length, mode: prof.watchMode, profile: prof.name, profileSource: prof.source },
    profile: { id: prof.id, name: prof.name, watchMode: prof.watchMode, profileMode: prof.profileMode ?? prof.watchMode, source: prof.source, original: prof.originalLangs },
    links: { anilist: cov[0]?.anilist_id ? `https://anilist.co/anime/${cov[0].anilist_id}` : null, anidb: aids[0] ? `https://anidb.net/anime/${aids[0].aid}` : null, tvdb: `https://thetvdb.com/?tab=series&id=${s.tvdb_id}` },
    managed: listManaged().find((m) => m.tvdbId === tvdbId) ?? null,
    allowed: underAllowedRoot(s.path),
    monitoredInSonarr: !!s.monitored,
  };
}

/** One episode in detail: file facts, grab history with the "why", and its activity entries. */
export function episodeDetail(episodeId: number) {
  const e = cache.prepare("SELECT e.*, s.tvdb_id, s.title AS series_title FROM episodes e JOIN series s ON s.id = e.series_id WHERE e.id = ?").get(episodeId) as { series_id: number; tvdb_id: number; series_title: string } | undefined;
  if (!e) return null;
  const row = episodeRows(e.series_id).find((x) => x.id === episodeId)!;
  const grabs = db
    .prepare("SELECT id, at, updated_at, release, protocol, state, dry_run, why, error, progress FROM grabs WHERE EXISTS (SELECT 1 FROM json_each(grabs.episode_ids) WHERE value = ?) ORDER BY id DESC LIMIT 20")
    .all(episodeId);
  const activity = listDecisions({ tvdbId: e.tvdb_id, limit: 300 }).filter((d) => d.episodeIds.includes(episodeId)).slice(0, 30);
  const verify = activity.find((d) => d.kind === "verify-ok" || d.kind === "verify-fail") ?? null;
  return { ...row, tvdbId: e.tvdb_id, seriesTitle: e.series_title, seriesId: e.series_id, grabs, activity, verify: verify ? { at: verify.at, ok: verify.kind === "verify-ok", why: verify.why } : null, currentRelease: row.file ? currentRelease(episodeId, row.file.sceneName) : null };
}

/**
 * The release name of the file an episode has now: AnimeArr's own successful grab if it made the file, else Sonarr's
 * scene name. Null when unknown (a renamed file name never matches an indexer title).
 */
export function currentRelease(episodeId: number, sceneName: string | null): string | null {
  const g = db.prepare("SELECT release FROM grabs WHERE state = 'done' AND EXISTS (SELECT 1 FROM json_each(grabs.episode_ids) WHERE value = ?) ORDER BY id DESC LIMIT 1").get(episodeId) as { release: string } | undefined;
  return g?.release ?? sceneName ?? null;
}

// ---------------------------------------------------------------- actions (injectable for tests)

export interface EpisodeDeps {
  episode: typeof sonarr.getEpisode;
  episodeFile: typeof sonarr.getEpisodeFile;
  deleteFile: typeof sonarr.deleteEpisodeFile;
  refresh(seriesId: number): Promise<void>;
  search: typeof deepSearch;
  grab: typeof startGrab;
}
export const realEpisodeDeps: EpisodeDeps = {
  episode: sonarr.getEpisode,
  episodeFile: sonarr.getEpisodeFile,
  deleteFile: sonarr.deleteEpisodeFile,
  refresh: (id) => refreshSeriesEpisodes(id),
  search: deepSearch,
  grab: startGrab,
};

function guard(tvdbId: number) {
  if (dbState.corrupt) throw Object.assign(new Error("The database failed its integrity check; restore a backup first"), { statusCode: 503 });
  const s = seriesByTvdb(tvdbId);
  if (!s) throw Object.assign(new Error("Unknown series"), { statusCode: 404 });
  if (!underAllowedRoot(s.path)) throw Object.assign(new Error(`${s.title} is outside the allowed root folders, so AnimeArr won't change its files. Allowed: ${getSettings().allowedRoots.join(", ") || "none yet"}`), { statusCode: 403 });
  return s;
}

/** Deletes the files of the given episodes through Sonarr. Returns whether a managed, live show should search again. */
export async function deleteEpisodeFiles(tvdbId: number, episodeIds: number[], deps: EpisodeDeps = realEpisodeDeps) {
  const s = guard(tvdbId);
  const all = episodesFor(tvdbId);
  const own = new Set(all.map((e) => e.id));
  const deleted: { episodeId: number; file: string; episodes: string[] }[] = [];
  const skipped: { episodeId: number; why: string }[] = [];
  const done = new Set<number>();
  for (const eid of episodeIds) {
    if (!own.has(eid)) {
      skipped.push({ episodeId: eid, why: "not an episode of this show" });
      continue;
    }
    try {
      // Live re-checks: the cache could be stale, or the series may have moved in Sonarr.
      const ep = await deps.episode(eid);
      if (ep.seriesId !== s.id) throw new Error("Sonarr says this episode belongs to another series");
      if (!ep.episodeFileId) {
        skipped.push({ episodeId: eid, why: "no file" });
        continue;
      }
      if (done.has(ep.episodeFileId)) continue; // multi-episode file already deleted
      const f = await deps.episodeFile(ep.episodeFileId);
      if (f.seriesId !== s.id) throw new Error("Sonarr says this file belongs to another series");
      if (!underAllowedRoot(f.path)) throw new Error(`the file is outside the allowed root folders (${f.path})`);
      const sharing = cache.prepare("SELECT id, season, episode FROM episodes WHERE file_id = ? ORDER BY season, episode").all(ep.episodeFileId) as { id: number; season: number; episode: number }[];
      const labels = sharing.length ? sharing.map((x) => sxe(x.season, x.episode)) : [sxe(ep.seasonNumber, ep.episodeNumber)];
      await deps.deleteFile(ep.episodeFileId);
      done.add(ep.episodeFileId);
      deleted.push({ episodeId: eid, file: path.posix.basename(f.path), episodes: labels });
      logDecision("info", {
        tvdbId,
        title: s.title,
        episodeIds: sharing.length ? sharing.map((x) => x.id) : [eid],
        release: f.sceneName ?? null,
        why: `Deleted the ${labels.join(" + ")} file ${path.posix.basename(f.path)} (you confirmed). It can't be undone here; if Sonarr has a recycle bin, the file is there.`,
        detail: { kind: "delete", fileId: ep.episodeFileId, path: f.path },
      });
    } catch (e) {
      skipped.push({ episodeId: eid, why: (e as Error).message });
    }
  }
  await deps.refresh(s.id).catch(() => undefined);
  const m = listManaged().find((x) => x.tvdbId === tvdbId);
  const affected = all.filter((e) => deleted.some((d) => d.episodes.includes(sxe(e.season, e.episode)))).map((e) => e.id);
  return { deleted, skipped, affected, askSearch: !!m && !isDryRun(m.dryRun) && deleted.length > 0 };
}

/** Puts episodes of a managed show back on the search schedule, due now. */
export function searchAgainSoon(tvdbId: number, episodeIds: number[]) {
  const s = guard(tvdbId);
  const own = new Set(episodesFor(tvdbId).map((e) => e.id));
  const ids = episodeIds.filter((e) => own.has(e));
  if (!ids.length) throw Object.assign(new Error("Those aren't episodes of this show"), { statusCode: 400 });
  logDecision("search", { tvdbId, title: s.title, episodeIds: ids, why: `You asked AnimeArr to search again for ${ids.length} episode(s) now` });
  const now = Date.now();
  for (const e of ids)
    db.prepare("INSERT INTO search_state (episode_id, tvdb_id, next_at, state) VALUES (?, ?, ?, 'waiting') ON CONFLICT(episode_id) DO UPDATE SET state = 'waiting', next_at = excluded.next_at, attempts = 0, last_why = 'search requested'").run(e, tvdbId, now);
}

const toCand = (r: SearchResult): Candidate => ({ guid: r.guid, title: r.title, indexerId: r.indexerId, indexer: r.indexer, protocol: r.protocol, size: r.size, downloadUrl: r.downloadUrl, magnetUrl: r.magnetUrl, label: r.label, group: r.group, why: r.rank.why, episodeIds: r.episodeIds });

/**
 * Re-grab: searches for the next best release (single-episode, accepted, not the one you have, not blocklisted) and
 * grabs it. Only when a real grab went out is the current release blocklisted (so it isn't picked again later), with
 * undo. In dry-run nothing is blocklisted. At most 10 episodes per request.
 */
export async function regrabEpisodes(tvdbId: number, episodeIds: number[], deps: EpisodeDeps = realEpisodeDeps) {
  const s = guard(tvdbId);
  if (episodeIds.length > 10) throw Object.assign(new Error("Re-grab at most 10 episodes at a time"), { statusCode: 400 });
  const own = new Set(episodesFor(tvdbId).map((e) => e.id));
  const out: { episodeId: number; outcome: string; release?: string; dryRun?: boolean }[] = [];
  for (const eid of episodeIds) {
    if (!own.has(eid)) {
      out.push({ episodeId: eid, outcome: "not an episode of this show" });
      continue;
    }
    try {
      const ep = await deps.episode(eid);
      let current: string | null = null;
      if (ep.episodeFileId) {
        const f = await deps.episodeFile(ep.episodeFileId);
        current = currentRelease(eid, f.sceneName ?? null);
      }
      const res = await deps.search(tvdbId, [eid]);
      const norm = (x: string) => x.replace(/-xpost$/i, "").replace(/\.(mkv|mp4)$/i, "").toLowerCase();
      const ok = res.results.filter((r) => r.rank.accept && r.coversTarget && r.extra <= 0 && (!current || norm(r.title) !== norm(current)));
      if (!ok.length) {
        out.push({ episodeId: eid, outcome: "nothing else acceptable found; the current file stays" });
        logDecision("skip", { tvdbId, title: s.title, episodeIds: [eid], why: `Re-grab S${ep.seasonNumber}E${ep.episodeNumber}: nothing else acceptable found, so the current file stays` });
        continue;
      }
      const g = await deps.grab({ tvdbId, episodeIds: [eid], candidate: toCand(ok[0]), fallbacks: ok.slice(1, 4).map(toCand), origin: "manual" });
      out.push({ episodeId: eid, outcome: g.message, release: ok[0].title, dryRun: g.dryRun });
      if (!g.dryRun && !g.failed && current) {
        const r = db.prepare("INSERT INTO blocklist (guid, release, tvdb_id, reason, at) VALUES (NULL, ?, ?, ?, ?)").run(current, tvdbId, "replaced by a re-grab", Date.now());
        logDecision("info", { tvdbId, title: s.title, episodeIds: [eid], release: current, why: `Re-grab: blocklisted the previous release ${current} so it isn't picked again`, undo: { action: "unblock", args: { id: Number(r.lastInsertRowid), release: current } } });
      }
    } catch (e) {
      out.push({ episodeId: eid, outcome: (e as Error).message });
    }
  }
  return out;
}

// ---------------------------------------------------------------- calendar

export function calendar(fromMs: number, toMs: number, managedOnly: boolean) {
  const managed = new Set(listManaged().map((m) => m.tvdbId));
  const active = grabStates();
  const rows = cache
    .prepare("SELECT e.id, e.season, e.episode, e.title, e.air_utc, e.has_file, e.monitored, s.tvdb_id, s.title AS series, s.poster FROM episodes e JOIN series s ON s.id = e.series_id WHERE e.air_utc BETWEEN ? AND ? AND e.season > 0 ORDER BY e.air_utc")
    .all(fromMs, toMs) as { id: number; season: number; episode: number; title: string | null; air_utc: number; has_file: number; monitored: number; tvdb_id: number; series: string; poster: string | null }[];
  const now = Date.now();
  const covers = new Map<number, string | null>();
  return rows
    .filter((r) => !managedOnly || managed.has(r.tvdb_id))
    .map((r) => {
      if (!covers.has(r.tvdb_id)) covers.set(r.tvdb_id, coverFor({ tvdb_id: r.tvdb_id, poster: r.poster }));
      const g = active.get(r.id);
      const status: EpisodeStatus = g ? (g.state === "needs-attention" ? "attention" : "downloading") : r.has_file ? "have" : r.air_utc > now ? "unaired" : "missing";
      return { episodeId: r.id, tvdbId: r.tvdb_id, series: r.series, cover: covers.get(r.tvdb_id) ?? null, season: r.season, episode: r.episode, title: r.title, airUtc: r.air_utc, status, progress: g?.progress ?? null, managed: managed.has(r.tvdb_id) };
    });
}

export const seriesAdvanced = (tvdbId: number) => {
  const idx = aliasIndex();
  return { anidb: idx.anidbIdsFor(tvdbId).map((x) => ({ ...x, title: idx.anidbTitle(x.aid) })) };
};
