/**
 * Home: one summary for the dashboard (airing today, what needs you, downloading, just arrived, ready to binge, this
 * week), from data AnimeArr already has. The expensive counts (files without the profile's language) are memoized.
 */
import { cache, db } from "./db.js";
import { calendar, episodeRows } from "./episodes.js";
import { missingLanguage } from "./audit.js";
import { coverFor } from "./audit.js";
import { profileFor } from "./profiles.js";
import { judge } from "./verify.js";
import { listManaged } from "./managed.js";

const DAY = 86_400_000;
const startOfDay = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

const seriesInfo = (tvdbId: number) => cache.prepare("SELECT id, tvdb_id, title, poster, anidb_ids FROM series WHERE tvdb_id = ?").get(tvdbId) as { id: number; tvdb_id: number; title: string; poster: string | null; anidb_ids: string } | undefined;

/** AniList's cover colour for a show (the per-show accent), when known. */
export function colorFor(tvdbId: number): string | null {
  const s = seriesInfo(tvdbId);
  if (!s) return null;
  const aids = (JSON.parse(s.anidb_ids || "[]") as { aid: number }[]).map((a) => a.aid);
  if (!aids.length) return null;
  const r = cache.prepare(`SELECT color FROM covers WHERE anidb_id IN (${aids.map(() => "?").join(",")}) AND color IS NOT NULL LIMIT 1`).get(...aids) as { color: string } | undefined;
  return r?.color ?? null;
}

const sxe = (s: number, e: number) => `S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`;

let langMemo: { at: number; v: { files: number; series: number } } | null = null;
function noLangCount() {
  if (langMemo && Date.now() - langMemo.at < 10 * 60_000) return langMemo.v;
  const r = missingLanguage();
  const v = { files: r.series.reduce((n, g) => n + g.files.length, 0) + r.movies.length, series: new Set(r.series.map((g) => g.tvdbId)).size };
  langMemo = { at: Date.now(), v };
  return v;
}

let bingeMemo: { at: number; v: ReturnType<typeof readyToBingeNow> } | null = null;
/**
 * Ready to binge: seasons that finished airing in the last 120 days, with every episode in the library and every file
 * in the show's language (subs, or audio for dub profiles).
 */
function readyToBingeNow(now = Date.now()) {
  const cands = cache
    .prepare(
      `SELECT s.id AS series_id, s.tvdb_id, s.title, s.poster, e.season, COUNT(*) AS n, SUM(e.has_file) AS have, MAX(e.air_utc) AS last
       FROM episodes e JOIN series s ON s.id = e.series_id
       WHERE e.season > 0 GROUP BY e.series_id, e.season
       HAVING n >= 6 AND have = n AND MAX(e.air_utc) < ? AND MAX(e.air_utc) > ? ORDER BY last DESC LIMIT 40`,
    )
    .all(now, now - 120 * DAY) as { series_id: number; tvdb_id: number; title: string; poster: string | null; season: number; n: number; last: number }[];
  const out: { tvdbId: number; title: string; season: number; episodes: number; cover: string | null; color: string | null; finishedAt: number }[] = [];
  for (const c of cands) {
    const prof = profileFor(c.tvdb_id);
    const rows = episodeRows(c.series_id).filter((r) => r.season === c.season);
    const ok = rows.every((r) => r.file && judge({ subs: r.file.subs, audio: r.file.audio, durationSec: null, sidecars: [], untagged: 0 }, prof, null, null).ok);
    if (!ok) continue;
    out.push({ tvdbId: c.tvdb_id, title: c.title, season: c.season, episodes: c.n, cover: coverFor({ tvdb_id: c.tvdb_id, poster: c.poster }), color: colorFor(c.tvdb_id), finishedAt: c.last });
    if (out.length >= 6) break;
  }
  return out;
}

let airingMemo: { at: number; n: number } | null = null;
/** Shows with an episode airing within a week either side of today (memoized 10 min). */
export function airingShowCount(now = Date.now()) {
  if (airingMemo && now - airingMemo.at < 10 * 60_000) return airingMemo.n;
  const today = startOfDay(now);
  const n = new Set(calendar(today - 7 * DAY, today + 7 * DAY, false).map((e) => e.tvdbId)).size;
  airingMemo = { at: now, n };
  return n;
}

export function homeSummary(now = Date.now()) {
  const today = startOfDay(now);
  const managed = new Set(listManaged().map((m) => m.tvdbId));
  const withColor = <T extends { tvdbId: number }>(x: T) => ({ ...x, color: colorFor(x.tvdbId) });

  const airingToday = calendar(today, today + DAY, false).map(withColor);
  const thisWeek = calendar(today + DAY, today + 8 * DAY, false).slice(0, 12);

  // Needs you: recent missing (aired in the last 14 days), imports that need a look, files without the language.
  const recentMissing = calendar(today - 14 * DAY, now, false).filter((e) => e.status === "missing" && managed.has(e.tvdbId));
  const attention = db.prepare("SELECT id, tvdb_id, movie_id, release, error FROM grabs WHERE dry_run = 0 AND state = 'needs-attention' ORDER BY id DESC").all() as { id: number; tvdb_id: number; movie_id: number | null; release: string; error: string | null }[];
  const lang = noLangCount();

  const active = db.prepare("SELECT id, tvdb_id, movie_id, episode_ids, release, protocol, client, state, progress FROM grabs WHERE dry_run = 0 AND state IN ('sending', 'downloading', 'importing') ORDER BY id").all() as { id: number; tvdb_id: number; movie_id: number | null; episode_ids: string; release: string; protocol: string; client: string | null; state: string; progress: number | null }[];
  const epLabel = (ids: number[]) => {
    const e = ids.length ? (cache.prepare("SELECT season, episode FROM episodes WHERE id = ?").get(ids[0]) as { season: number; episode: number } | undefined) : undefined;
    return e ? `${sxe(e.season, e.episode)}${ids.length > 1 ? `–E${String((cache.prepare("SELECT episode FROM episodes WHERE id = ?").get(ids[ids.length - 1]) as { episode: number } | undefined)?.episode ?? "").padStart(2, "0")}` : ""}` : "";
  };
  const showOf = (tvdbId: number) => {
    const s = seriesInfo(tvdbId);
    return { title: s?.title ?? String(tvdbId), cover: s ? coverFor({ tvdb_id: s.tvdb_id, poster: s.poster }) : null, color: colorFor(tvdbId) };
  };
  const downloading = active.map((g) => ({ id: g.id, tvdbId: g.tvdb_id, movieId: g.movie_id, ...showOf(g.tvdb_id), label: epLabel(JSON.parse(g.episode_ids) as number[]), release: g.release, protocol: g.protocol, client: g.client, state: g.state, progress: g.progress ?? 0 }));

  // Just arrived: what was imported in the last 7 days, newest first, one card per show+episode.
  const done = db.prepare("SELECT id, tvdb_id, movie_id, episode_ids, updated_at FROM grabs WHERE dry_run = 0 AND state = 'done' AND movie_id IS NULL AND updated_at > ? ORDER BY updated_at DESC LIMIT 60").all(now - 7 * DAY) as { id: number; tvdb_id: number; movie_id: number | null; episode_ids: string; updated_at: number }[];
  const seen = new Set<string>();
  const justArrived: { tvdbId: number; title: string; cover: string | null; color: string | null; label: string; at: number }[] = [];
  for (const g of done) {
    const ids = JSON.parse(g.episode_ids) as number[];
    const key = `${g.tvdb_id}:${ids.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    justArrived.push({ tvdbId: g.tvdb_id, ...showOf(g.tvdb_id), label: epLabel(ids), at: g.updated_at });
    if (justArrived.length >= 12) break;
  }
  const importsThisWeek = (db.prepare("SELECT COUNT(*) AS n FROM grabs WHERE dry_run = 0 AND state = 'done' AND updated_at > ?").get(now - 7 * DAY) as { n: number }).n;

  if (!bingeMemo || now - bingeMemo.at > 15 * 60_000) bingeMemo = { at: now, v: readyToBingeNow(now) };

  const airingShows = airingShowCount(now);
  return {
    airingShows,
    airingToday,
    needs: {
      missing: { n: recentMissing.length, sample: recentMissing.slice(0, 1).map((e) => `${e.series} ${sxe(e.season, e.episode)}`)[0] ?? null },
      failed: { n: attention.length, sample: attention[0] ? `${showOf(attention[0].tvdb_id).title}${attention[0].error ? ` · ${attention[0].error}` : ""}` : null },
      noLang: { n: lang.files, series: lang.series, lang: profileFor(null).subLangs[0] ?? "en" },
    },
    downloading,
    justArrived,
    importsThisWeek,
    readyToBinge: bingeMemo.v,
    thisWeek,
  };
}
