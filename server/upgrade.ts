/**
 * Dual-audio upgrades (Sonarr-parity upgrade path for the "dual" watch mode). In dual mode a sub-only release is
 * accepted as a placeholder; this pass looks for a dual-audio release of those episodes now and then and, in "auto"
 * mode, grabs it so it replaces the placeholder.
 *
 * - Managed shows only, effective watch mode "dual", monitored, inside the allowed roots, aired within maxAgeDays,
 *   file known to have no dub.
 * - Search budget per hour (an explicit log), each episode at most every recheckDays.
 * - A candidate must be named dual audio (≥80% sure of the dub), confidently this one episode, not burned-in, not a
 *   lower resolution than the placeholder, alive.
 * - The grab is marked "dual-upgrade": the import verifies strictly (original + dub audio), so a mislabelled
 *   release fails before it replaces anything (blocklist + next candidate, as usual).
 * - Honours dry-run (show + global). "log" mode only reports what it would grab.
 */
import { logDecision } from "./activity.js";
import { prowlarrConfigured } from "./arr/prowlarr.js";
import { langList } from "./core/langs.js";
import { parseRelease } from "./core/parser.js";
import { cache, db, dbState, setJob } from "./db.js";
import { listManaged, toCandidate } from "./managed.js";
import { startGrab } from "./pipeline.js";
import { profileFor } from "./profiles.js";
import { deepSearch, type SearchResult } from "./search.js";
import { getSettings, underAllowedRoot } from "./settings.js";
import { searchMovie, startMovieGrab, type MovieFile } from "./movies.js";
import { moviePrefs, profileForMovie } from "./profiles.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;

export interface UpgradeDeps {
  search: typeof deepSearch;
  grab: typeof startGrab;
  /** Movies (optional in tests of episodes). */
  searchMovie?: typeof searchMovie;
  grabMovie?: typeof startMovieGrab;
}
const realUpgradeDeps: UpgradeDeps = { search: deepSearch, grab: startGrab, searchMovie: (id) => searchMovie(id), grabMovie: (r) => startMovieGrab(r) };

interface Waiting { episodeId: number; tvdbId: number; title: string; label: string; audio: string[]; dub: string[]; fileId: number; height: number | null }

const heightOf = (res: string | null) => {
  const m = /(\d{3,4})\s*$/.exec(res ?? "") ?? /x(\d{3,4})/.exec(res ?? "");
  return m ? Number(m[1]) : null;
};

/** Episodes of dual-mode managed shows whose file is known to have no dub (the sub-only placeholders). */
export function placeholders(now = Date.now()): Waiting[] {
  const s = getSettings().dualUpgrade;
  const out: Waiting[] = [];
  for (const m of listManaged()) {
    const prof = profileFor(m.tvdbId);
    if (prof.watchMode !== "dual") continue;
    const series = cache.prepare("SELECT path FROM series WHERE tvdb_id = ?").get(m.tvdbId) as { path: string } | undefined;
    if (!underAllowedRoot(series?.path)) continue;
    const original = prof.originalLangs ?? ["ja"];
    const dub = (prof.dubLangs ?? []).filter((l) => !original.includes(l));
    if (!dub.length) continue;
    const rows = cache
      .prepare("SELECT e.id, e.season, e.episode, e.file_id, f.audio_langs, f.resolution FROM episodes e JOIN files f ON f.id = e.file_id WHERE e.series_id = ? AND e.season > 0 AND e.monitored = 1 AND e.has_file = 1 AND e.air_utc IS NOT NULL AND e.air_utc >= ?")
      .all(m.seriesId, now - s.maxAgeDays * DAY) as { id: number; season: number; episode: number; file_id: number; audio_langs: string; resolution: string | null }[];
    for (const r of rows) {
      const audio = langList(r.audio_langs);
      if (!audio.length || dub.some((l) => audio.some((a) => a.split("-")[0] === l))) continue; // unknown, or already has the dub
      out.push({ episodeId: r.id, tvdbId: m.tvdbId, title: m.title, label: `S${String(r.season).padStart(2, "0")}E${String(r.episode).padStart(2, "0")}`, audio, dub, fileId: r.file_id, height: heightOf(r.resolution) });
    }
  }
  return out;
}

/** A dual-audio release that can replace the placeholder. */
export function qualifies(r: SearchResult, minConfidence: number, placeholderHeight: number | null = null) {
  const res = parseRelease(r.title).resolution;
  return (
    r.rank.accept &&
    r.rank.langProb >= 0.8 &&
    r.rank.flags.some((f) => f.key === "dual") &&
    !r.rank.flags.some((f) => f.key === "placeholder" || f.key === "burnIn") &&
    r.confidence >= minConfidence &&
    r.coversTarget &&
    r.extra <= 0 &&
    !(placeholderHeight && res && res < placeholderHeight) &&
    !(r.protocol === "torrent" && !r.seeders)
  );
}

const searchesLastHour = (now: number) => (db.prepare("SELECT COUNT(*) AS n FROM upgrade_searches WHERE at > ?").get(now - HOUR) as { n: number }).n;

interface Row { episode_id: number; tvdb_id: number; state: string; last_at: number | null; grab_id: number | null; release: string | null; file_id: number | null }
function save(episodeId: number, tvdbId: number, v: { state: string; why: string; now: number; searched?: boolean; grabId?: number | null; release?: string | null; fileId?: number | null }) {
  const prev = db.prepare("SELECT * FROM upgrade_state WHERE episode_id = ?").get(episodeId) as (Row & { attempts: number }) | undefined;
  db.prepare("INSERT OR REPLACE INTO upgrade_state (episode_id, tvdb_id, state, last_at, attempts, why, grab_id, release, file_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    episodeId,
    tvdbId,
    v.state,
    v.searched ? v.now : (prev?.last_at ?? null),
    (prev?.attempts ?? 0) + (v.searched ? 1 : 0),
    v.why,
    v.grabId === undefined ? (prev?.grab_id ?? null) : v.grabId,
    v.release === undefined ? (prev?.release ?? null) : v.release,
    v.fileId === undefined ? (prev?.file_id ?? null) : v.fileId,
    v.now,
  );
}

/** The newest upgrade grab for an episode (the pipeline may have moved on to a fallback). */
const latestUpgradeGrab = (episodeId: number) =>
  db.prepare("SELECT id, state, release FROM grabs WHERE purpose = 'dual-upgrade' AND EXISTS (SELECT 1 FROM json_each(grabs.episode_ids) WHERE value = ?) ORDER BY id DESC LIMIT 1").get(episodeId) as { id: number; state: string; release: string } | undefined;

/** One pass: follow up on earlier upgrade grabs, then search the due placeholders within the hourly budget. */
export async function upgradePass(deps: UpgradeDeps = realUpgradeDeps, now = Date.now()) {
  const s = getSettings().dualUpgrade;
  if (s.mode === "off" || dbState.corrupt) return { waiting: 0, searched: 0, found: 0 };
  const waiting = placeholders(now);
  const byId = new Map(waiting.map((w) => [w.episodeId, w]));
  db.prepare("DELETE FROM upgrade_searches WHERE at < ?").run(now - DAY);

  // 1. Follow-ups (before any search, so the budget never skips them).
  for (const r of db.prepare("SELECT * FROM upgrade_state WHERE state IN ('grabbed', 'found', 'waiting')").all() as unknown as Row[]) {
    const w = byId.get(r.episode_id);
    if (r.state === "grabbed") {
      const g = latestUpgradeGrab(r.episode_id);
      if (g && ["sending", "downloading", "importing", "needs-attention"].includes(g.state)) continue;
      if (g?.state === "done") {
        // Imported and verified as dual audio by the pipeline; the cache may still show the old file for a while.
        save(r.episode_id, r.tvdb_id, { state: "upgraded", why: `upgraded to ${g.release}`, now, grabId: g.id, release: g.release });
        continue;
      }
      save(r.episode_id, r.tvdb_id, { state: "waiting", why: g ? `the upgrade didn't work out (${g.release}: ${g.state})` : "the upgrade grab is gone", now, grabId: null, release: null });
      continue;
    }
    // Out of scope (got its dub, left dual mode, unmanaged, too old, file gone): done.
    if (!w) save(r.episode_id, r.tvdb_id, { state: "done", why: "no longer a sub-only placeholder (has the dub now, or out of scope)", now, grabId: null });
  }

  // 2. Searches.
  let searched = 0;
  let found = 0;
  const minConf = getSettings().managed.minConfidence;
  const rows = new Map((db.prepare("SELECT * FROM upgrade_state").all() as unknown as Row[]).map((r) => [r.episode_id, r]));
  const due = [...waiting].sort((a, b) => (rows.get(a.episodeId)?.last_at ?? 0) - (rows.get(b.episodeId)?.last_at ?? 0));
  for (const w of due) {
    const row = rows.get(w.episodeId);
    if (row?.state === "grabbed") continue;
    // Upgraded, but the cache still shows the placeholder file: wait for the refresh.
    if (row?.state === "upgraded" && row.file_id === w.fileId) continue;
    if (row?.last_at && now - row.last_at < s.recheckDays * DAY && row.file_id === w.fileId) continue;
    if (searchesLastHour(now) >= s.perHour) break;
    if (db.prepare("SELECT 1 FROM grabs WHERE state IN ('sending', 'downloading', 'importing', 'needs-attention') AND EXISTS (SELECT 1 FROM json_each(grabs.episode_ids) WHERE value = ?)").get(w.episodeId)) continue;
    db.prepare("INSERT INTO upgrade_searches (at) VALUES (?)").run(now);
    searched++;
    let results: SearchResult[];
    try {
      results = (await deps.search(w.tvdbId, [w.episodeId], { budget: 8 })).results;
    } catch (e) {
      save(w.episodeId, w.tvdbId, { state: "waiting", why: `search failed: ${(e as Error).message}`, now, searched: true, fileId: w.fileId, release: null });
      continue;
    }
    const ok = results.filter((r) => qualifies(r, minConf, w.height));
    if (!ok.length) {
      save(w.episodeId, w.tvdbId, { state: "waiting", why: `no dual-audio release yet (${results.length} releases seen); next look in ${s.recheckDays} days`, now, searched: true, fileId: w.fileId, release: null });
      continue;
    }
    found++;
    const best = ok[0];
    if (s.mode !== "auto") {
      save(w.episodeId, w.tvdbId, { state: "found", why: `would upgrade to ${best.title} (${best.rank.why}); log-only mode`, now, searched: true, fileId: w.fileId, release: best.title });
      logDecision("info", { tvdbId: w.tvdbId, title: w.title, episodeIds: [w.episodeId], release: best.title, why: `Dual-audio upgrade for ${w.title} ${w.label}: would replace the sub-only file with ${best.title} (${best.rank.why}). Log-only mode: nothing grabbed.` });
      continue;
    }
    try {
      const out = await deps.grab({ tvdbId: w.tvdbId, episodeIds: [w.episodeId], candidate: toCandidate(best), fallbacks: ok.slice(1).map(toCandidate), origin: "managed", purpose: "dual-upgrade" });
      const state = out.dryRun ? "found" : out.failed ? "waiting" : "grabbed";
      save(w.episodeId, w.tvdbId, { state, why: `${out.dryRun ? "dry-run: " : ""}${out.message}`, now, searched: true, fileId: w.fileId, grabId: out.dryRun || out.failed ? null : out.id, release: best.title });
      logDecision("info", { tvdbId: w.tvdbId, title: w.title, episodeIds: [w.episodeId], release: best.title, why: `Dual-audio upgrade for ${w.title} ${w.label}: ${out.dryRun ? "would grab" : out.failed ? "couldn't grab" : "grabbed"} ${best.title} to replace the sub-only file (${best.rank.why})` });
    } catch (e) {
      save(w.episodeId, w.tvdbId, { state: "waiting", why: `grab failed: ${(e as Error).message}`, now, searched: true, fileId: w.fileId, release: null });
    }
  }
  const mv = await upgradeMovies(deps, now);
  return { waiting: waiting.length + mv.waiting, searched: searched + mv.searched, found: found + mv.found };
}

// ---------------------------------------------------------------- movies

interface MovieWaiting { movieId: number; title: string; audio: string[]; dub: string[]; filePath: string | null; height: number | null }

/** Anime movies watched in Dual mode whose file is known to have no dub. */
export function moviePlaceholders(): MovieWaiting[] {
  const out: MovieWaiting[] = [];
  for (const m of cache.prepare("SELECT id, title, year, path, file FROM movies WHERE is_anime = 1 AND has_file = 1 AND monitored = 1 AND file IS NOT NULL").all() as { id: number; title: string; year: number | null; path: string; file: string }[]) {
    if (!underAllowedRoot(m.path)) continue;
    // Only movies you set to Dual yourself (a default Dual profile doesn't opt the whole movie library in).
    if (moviePrefs(m.id).watch_mode !== "dual") continue;
    const prof = profileForMovie(m.id);
    const original = prof.originalLangs ?? ["ja"];
    const dub = (prof.dubLangs ?? []).filter((l) => !original.includes(l));
    const f = JSON.parse(m.file) as MovieFile;
    if (!dub.length || !f.audio.length || dub.some((l) => f.audio.some((a) => a.split("-")[0] === l))) continue;
    out.push({ movieId: m.id, title: m.year ? `${m.title} (${m.year})` : m.title, audio: f.audio, dub, filePath: f.path, height: heightOf(f.resolution) });
  }
  return out;
}

async function upgradeMovies(deps: UpgradeDeps, now: number) {
  const s = getSettings().dualUpgrade;
  const res = { waiting: 0, searched: 0, found: 0 };
  if (!deps.searchMovie || !deps.grabMovie) return res;
  const waiting = moviePlaceholders();
  res.waiting = waiting.length;
  const byId = new Map(waiting.map((w) => [w.movieId, w]));
  const save = (movieId: number, state: string, why: string, extra: { searched?: boolean; release?: string | null; filePath?: string | null } = {}) => {
    const prev = db.prepare("SELECT * FROM movie_upgrade WHERE movie_id = ?").get(movieId) as { last_at: number | null; attempts: number; release: string | null; file_path: string | null } | undefined;
    db.prepare("INSERT OR REPLACE INTO movie_upgrade (movie_id, state, last_at, attempts, why, release, file_path, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      movieId, state, extra.searched ? now : (prev?.last_at ?? null), (prev?.attempts ?? 0) + (extra.searched ? 1 : 0), why,
      extra.release === undefined ? (prev?.release ?? null) : extra.release, extra.filePath === undefined ? (prev?.file_path ?? null) : extra.filePath, now);
  };
  // Follow-ups first.
  for (const r of db.prepare("SELECT * FROM movie_upgrade WHERE state IN ('grabbed', 'found', 'waiting')").all() as { movie_id: number; state: string }[]) {
    if (r.state === "grabbed") {
      const g = db.prepare("SELECT state, release FROM grabs WHERE movie_id = ? AND purpose = 'dual-upgrade' ORDER BY id DESC LIMIT 1").get(r.movie_id) as { state: string; release: string } | undefined;
      if (g && ["sending", "downloading", "importing", "needs-attention"].includes(g.state)) continue;
      if (g?.state === "done") save(r.movie_id, "upgraded", `upgraded to ${g.release}`, { release: g.release });
      else save(r.movie_id, "waiting", g ? `the upgrade didn't work out (${g.release}: ${g.state})` : "the upgrade grab is gone", { release: null });
      continue;
    }
    if (!byId.has(r.movie_id)) save(r.movie_id, "done", "no longer a sub-only placeholder (has the dub now, or out of scope)");
  }
  const minConf = getSettings().managed.minConfidence;
  for (const w of waiting) {
    const row = db.prepare("SELECT * FROM movie_upgrade WHERE movie_id = ?").get(w.movieId) as { state: string; last_at: number | null; file_path: string | null } | undefined;
    if (row?.state === "grabbed") continue;
    if (row?.state === "upgraded" && row.file_path === w.filePath) continue; // cache not refreshed yet
    if (row?.last_at && now - row.last_at < s.recheckDays * DAY && row.file_path === w.filePath) continue;
    if (searchesLastHour(now) >= s.perHour) break;
    if (db.prepare("SELECT 1 FROM grabs WHERE movie_id = ? AND state IN ('sending', 'downloading', 'importing', 'needs-attention')").get(w.movieId)) continue;
    db.prepare("INSERT INTO upgrade_searches (at) VALUES (?)").run(now);
    res.searched++;
    try {
      const r = await deps.searchMovie(w.movieId);
      const ok = r.results.filter((x) => {
        const resH = parseRelease(x.title).resolution;
        return x.rank.accept && x.rank.langProb >= 0.8 && x.rank.flags.some((f) => f.key === "dual") && !x.rank.flags.some((f) => f.key === "placeholder" || f.key === "burnIn") && x.confidence >= minConf && !(w.height && resH && resH < w.height) && !(x.protocol === "torrent" && !x.seeders);
      });
      if (!ok.length) {
        save(w.movieId, "waiting", `no dual-audio release yet (${r.matched} releases matched); next look in ${s.recheckDays} days`, { searched: true, filePath: w.filePath, release: null });
        continue;
      }
      res.found++;
      const best = ok[0];
      if (s.mode !== "auto") {
        save(w.movieId, "found", `would upgrade to ${best.title} (${best.rank.why}); log-only mode`, { searched: true, filePath: w.filePath, release: best.title });
        logDecision("info", { title: w.title, release: best.title, why: `Dual-audio upgrade for ${w.title}: would replace the sub-only file with ${best.title} (${best.rank.why}). Log-only mode: nothing grabbed.`, detail: { movieId: w.movieId } });
        continue;
      }
      const cand = (x: typeof best) => ({ guid: x.guid, title: x.title, indexerId: x.indexerId, indexer: x.indexer, protocol: x.protocol, size: x.size, downloadUrl: x.downloadUrl, magnetUrl: x.magnetUrl, label: x.label, group: x.group, why: x.rank.why, episodeIds: [] });
      const out = await deps.grabMovie({ movieId: w.movieId, candidate: cand(best), fallbacks: ok.slice(1, 4).map(cand), origin: "managed", replace: true, purpose: "dual-upgrade" });
      save(w.movieId, out.dryRun ? "found" : out.failed ? "waiting" : "grabbed", `${out.dryRun ? "dry-run: " : ""}${out.message}`, { searched: true, filePath: w.filePath, release: best.title });
      logDecision("info", { title: w.title, release: best.title, why: `Dual-audio upgrade for ${w.title}: ${out.dryRun ? "would grab" : out.failed ? "couldn't grab" : "grabbed"} ${best.title} to replace the sub-only file (${best.rank.why})`, detail: { movieId: w.movieId } });
    } catch (e) {
      save(w.movieId, "waiting", `failed: ${(e as Error).message}`, { searched: true, filePath: w.filePath, release: null });
    }
  }
  return res;
}

let running = false;
export async function upgradeTick() {
  if (running || getSettings().dualUpgrade.mode === "off" || !prowlarrConfigured()) return;
  running = true;
  try {
    const r = await upgradePass();
    setJob("dual upgrades", "done", `${r.waiting} sub-only episodes waiting for a dual-audio release; ${r.searched} searched, ${r.found} found (${getSettings().dualUpgrade.mode === "auto" ? "auto" : "log only"})`);
  } catch (e) {
    setJob("dual upgrades", "error", (e as Error).message);
  } finally {
    running = false;
  }
}

/** For the Audit tab: placeholders still waiting, plus upgrades from the last 30 days. */
export function upgradeList(now = Date.now()) {
  const waiting = placeholders(now);
  const rows = new Map((db.prepare("SELECT * FROM upgrade_state").all() as unknown as (Row & { why: string; attempts: number; updated_at: number })[]).map((r) => [r.episode_id, r]));
  const items = waiting.map((w) => {
    const r = rows.get(w.episodeId);
    return { episodeId: w.episodeId, tvdbId: w.tvdbId, title: w.title, label: w.label, audio: w.audio, dub: w.dub, state: r?.state === "upgraded" ? "grabbed" : (r?.state ?? "waiting"), lastAt: r?.last_at ?? null, why: r?.why ?? "not searched yet", release: r?.release ?? null };
  });
  const shown = new Set(items.map((i) => i.episodeId));
  for (const r of rows.values()) {
    if (r.state !== "upgraded" || shown.has(r.episode_id) || now - r.updated_at > 30 * DAY) continue;
    const e = cache.prepare("SELECT e.season, e.episode, s.title FROM episodes e JOIN series s ON s.id = e.series_id WHERE e.id = ?").get(r.episode_id) as { season: number; episode: number; title: string } | undefined;
    items.push({ episodeId: r.episode_id, tvdbId: r.tvdb_id, title: e?.title ?? String(r.tvdb_id), label: e ? `S${String(e.season).padStart(2, "0")}E${String(e.episode).padStart(2, "0")}` : "", audio: [], dub: [], state: "upgraded", lastAt: r.last_at, why: r.why, release: r.release });
  }
  const movies = moviePlaceholders().map((w) => {
    const r = db.prepare("SELECT state, last_at, why, release FROM movie_upgrade WHERE movie_id = ?").get(w.movieId) as { state: string; last_at: number | null; why: string; release: string | null } | undefined;
    return { movieId: w.movieId, title: w.title, audio: w.audio, dub: w.dub, state: r?.state === "upgraded" ? "grabbed" : (r?.state ?? "waiting"), lastAt: r?.last_at ?? null, why: r?.why ?? "not searched yet", release: r?.release ?? null };
  });
  return { mode: getSettings().dualUpgrade.mode, items, movies };
}
