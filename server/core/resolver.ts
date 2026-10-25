/**
 * Numbering resolver (PROPOSAL §6.4): parsed release + alias candidate → Sonarr episodes (TVDB season/episode).
 *
 * Readings, in order of preference:
 * 1. Per-show numbering rule (optionally per release group): absolute / season N / season N with offset.
 * 2. The alias pins an AniDB entry mapped by Anime-Lists ("Hitori no Shita: The Outcast 6" → TVDB S6): per-entry episode + offset.
 * 3. A season token (S6E01, "S6 - 01", "6th Season"): fan season = TVDB season when Sonarr has it; otherwise the
 *    N-th mainline Anime-Lists entry with its offset (split cours). Sonarr's scene (XEM) numbering is used as evidence.
 * 4. A bare number ("- 78"): per-entry in the implied/newest season vs. absolute; if both fit, the air date closest to
 *    the release's publish date wins.
 * Every reading is checked against air dates when a publish date is known (a release can't predate its episode).
 */
import { anidbToTvdb, type AnimeListEntry } from "./animedata.js";
import type { Candidate } from "./aliases.js";
import type { ParsedRelease } from "./parser.js";

export interface LibEpisode {
  id: number;
  season: number;
  episode: number;
  absolute: number | null;
  sceneSeason: number | null;
  sceneEpisode: number | null;
  sceneAbsolute: number | null;
  airUtc: number | null;
  title?: string | null;
  hasFile?: boolean;
  monitored?: boolean;
  runtime?: number | null;
}

export interface NumberingRule {
  /** Release group this rule is limited to (case-insensitive), or null for every group. */
  group: string | null;
  mode: "auto" | "absolute" | "season" | "offset";
  season: number | null;
  offset: number;
}

export interface Resolution {
  ok: boolean;
  episodes: LibEpisode[];
  /** "S06E01", "S06E01-E12" for display. */
  label: string;
  confidence: number;
  method: string;
  why: string[];
  /** True when the release covers a whole season (pack); episodes then lists every episode of it. */
  pack: boolean;
}

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");

export function labelOf(eps: LibEpisode[]) {
  if (!eps.length) return "";
  const s = [...eps].sort((a, b) => a.season - b.season || a.episode - b.episode);
  const first = s[0];
  const last = s[s.length - 1];
  if (s.length === 1) return `S${pad(first.season)}E${pad(first.episode)}`;
  if (first.season === last.season) return `S${pad(first.season)}E${pad(first.episode)}-E${pad(last.episode)}`;
  return `S${pad(first.season)}E${pad(first.episode)}-S${pad(last.season)}E${pad(last.episode)}`;
}

function fail(why: string[], method = "none"): Resolution {
  return { ok: false, episodes: [], label: "", confidence: 0, method, why, pack: false };
}

interface Reading {
  eps: LibEpisode[];
  method: string;
  certainty: number;
  why: string;
}

export function resolveRelease(
  p: ParsedRelease,
  cand: Candidate,
  episodes: LibEpisode[],
  opts: { entries?: AnimeListEntry[]; rules?: NumberingRule[]; publishDate?: number | null; now?: number } = {},
): Resolution {
  const why: string[] = [...cand.why];
  const entries = opts.entries ?? [];
  const now = opts.now ?? Date.now();
  const find = (season: number, ep: number) => episodes.find((e) => e.season === season && e.episode === ep) ?? null;
  const bySeason = (season: number) => episodes.filter((e) => e.season === season).sort((a, b) => a.episode - b.episode);
  const seasons = [...new Set(episodes.filter((e) => e.season > 0).map((e) => e.season))].sort((a, b) => a - b);
  const aired = (e: LibEpisode) => e.airUtc !== null && e.airUtc <= now + DAY;

  if (p.special && p.special !== "movie" && !p.episodes.length && !p.absolute.length) return fail([...why, `special (${p.special}): pick the episode by hand`], "special");
  if (p.specialNumber !== null && !p.episodes.length) return fail([...why, `recap/special number ${p.specialNumber}: pick the episode by hand`], "special");

  // ---- whole-season pack with no episode numbers
  if (p.fullSeason && !p.episodes.length && !p.absolute.length) {
    const s = p.season ?? cand.impliedSeason;
    if (s === null) return fail([...why, "season pack without a season number"], "pack");
    const list = bySeason(s);
    if (!list.length) return fail([...why, `Sonarr has no season ${s}`], "pack");
    return { ok: true, episodes: list, label: `S${pad(s)} (whole season)`, confidence: Math.min(cand.score, 90), method: "pack", why: [...why, `season pack → all ${list.length} episodes of season ${s}`], pack: true };
  }

  const numbers = p.episodes.length ? p.episodes : p.absolute;
  if (!numbers.length) return fail([...why, "no episode number in the name"], "none");
  const readings: Reading[] = [];
  const mapAll = (season: number, offset = 0): LibEpisode[] | null => {
    const out: LibEpisode[] = [];
    for (const n of numbers) {
      const e = find(season, n + offset);
      if (!e) return null;
      out.push(e);
    }
    return out;
  };

  // ---- 1. per-show numbering rule
  const rule = (opts.rules ?? []).find((r) => r.group && p.group && r.group.toLowerCase() === p.group.toLowerCase()) ?? (opts.rules ?? []).find((r) => !r.group);
  if (rule && rule.mode !== "auto") {
    let eps: LibEpisode[] | null = null;
    if (rule.mode === "absolute") eps = numbers.map((n) => episodes.find((e) => e.absolute === n) ?? null).every(Boolean) ? numbers.map((n) => episodes.find((e) => e.absolute === n)!) : null;
    else if (rule.season !== null) eps = mapAll(rule.season, rule.mode === "offset" ? rule.offset : 0);
    const ruleWhy = `your numbering rule${rule.group ? ` for ${rule.group}` : ""}: ${rule.mode}${rule.season !== null ? ` season ${rule.season}` : ""}${rule.offset ? ` offset ${rule.offset}` : ""}`;
    if (eps) return finish([{ eps, method: `rule-${rule.mode}`, certainty: 1, why: ruleWhy }]);
    return fail([...why, `${ruleWhy} → no matching episode in Sonarr`], "rule");
  }

  // ---- 2. alias pins an AniDB entry (not the franchise's first entry, unless the name has no season either)
  const seasonToken = p.season ?? null;
  if (cand.entry && typeof cand.entry.season === "number" && (cand.entry.season > 1 || seasonToken === null || seasonToken === cand.entry.season)) {
    const entry = entries.find((x) => x.aid === cand.entry!.aid);
    const eps: LibEpisode[] = [];
    for (const n of numbers) {
      const t = entry ? anidbToTvdb(entry, n) : { season: cand.entry.season, episode: n + cand.entry.offset };
      const e = t && t.season >= 0 ? find(t.season, t.episode) : null;
      if (!e) break;
      eps.push(e);
    }
    if (eps.length === numbers.length) readings.push({ eps, method: "anidb-entry", certainty: seasonToken !== null && seasonToken !== cand.entry.season ? 0.75 : 0.97, why: `AniDB ${cand.entry.aid} is TVDB season ${cand.entry.season}${cand.entry.offset ? ` (episode offset ${cand.entry.offset})` : ""} per Anime-Lists` });
  }

  // ---- 3. season token (explicit or implied by the alias)
  const s = seasonToken ?? cand.impliedSeason;
  if (s !== null && !readings.length) {
    const direct = mapAll(s);
    // XEM/scene numbering evidence from Sonarr: scene season s, scene episode n.
    const scene = numbers.map((n) => episodes.find((e) => e.sceneSeason === s && e.sceneEpisode === n) ?? null);
    const sceneOk = scene.every(Boolean) ? (scene as LibEpisode[]) : null;
    // N-th mainline Anime-Lists entry (TV seasons ≥ 1 mapped to this series, in TVDB order).
    const mainline = entries.filter((e) => typeof e.defaultSeason === "number" && e.defaultSeason >= 1).sort((a, b) => (a.defaultSeason as number) - (b.defaultSeason as number) || a.offset - b.offset);
    const nth = mainline[s - 1];
    let viaEntry: LibEpisode[] | null = null;
    if (nth && (nth.defaultSeason !== s || nth.offset !== 0) && mainline.length >= s) {
      const eps = numbers.map((n) => {
        const t = anidbToTvdb(nth, n);
        return t ? find(t.season, t.episode) : null;
      });
      if (eps.every(Boolean)) viaEntry = eps as LibEpisode[];
    }
    const agreeWithScene = (eps: LibEpisode[] | null) => !!eps && !!sceneOk && eps.every((e, i) => e.id === sceneOk[i].id);
    if (direct) readings.push({ eps: direct, method: "season", certainty: agreeWithScene(direct) || !viaEntry ? 0.96 : 0.8, why: `season ${s} episode ${numbers.join(",")} = Sonarr S${pad(s)}${p.fanSeason ? " (fan numbering \"S" + s + " - NN\")" : ""}` });
    if (viaEntry) readings.push({ eps: viaEntry, method: "mainline-entry", certainty: agreeWithScene(viaEntry) ? 0.95 : 0.82, why: `season ${s} = AniDB ${nth.aid} "${nth.name}", which Anime-Lists places at TVDB season ${nth.defaultSeason} offset ${nth.offset}` });
    if (sceneOk && !direct && !viaEntry) readings.push({ eps: sceneOk, method: "scene", certainty: 0.88, why: `Sonarr's scene numbering maps S${s} ${numbers.join(",")} to ${labelOf(sceneOk)}` });
    if (!readings.length) return fail([...why, `Sonarr has no S${pad(s)}E${pad(numbers[0])}${seasons.length ? ` (seasons ${seasons.join(", ")})` : ""}`], "season");
  }

  // ---- 4. bare number: per-entry (newest/implied season) vs absolute
  if (s === null && !readings.length) {
    const abs = numbers.map((n) => episodes.find((e) => e.absolute === n) ?? null);
    if (abs.every(Boolean)) readings.push({ eps: abs as LibEpisode[], method: "absolute", certainty: 0.9, why: `absolute episode ${numbers.join(",")} = ${labelOf(abs as LibEpisode[])}` });
    const sceneAbs = numbers.map((n) => episodes.find((e) => e.sceneAbsolute === n && e.season > 0) ?? null);
    // Newest season that has aired episodes: a new release of an airing show is almost always its newest entry.
    const airedSeasons = seasons.filter((x) => bySeason(x).some(aired));
    const newest = airedSeasons[airedSeasons.length - 1] ?? seasons[seasons.length - 1];
    if (newest !== undefined && newest !== 1) {
      const perEntry = mapAll(newest);
      if (perEntry) readings.push({ eps: perEntry, method: "per-entry", certainty: 0.85, why: `episode ${numbers.join(",")} of the newest season ${newest}` });
    }
    if (sceneAbs.every(Boolean) && !readings.some((r) => r.eps.every((e, i) => e.id === sceneAbs[i]!.id)))
      readings.push({ eps: sceneAbs as LibEpisode[], method: "scene-absolute", certainty: 0.8, why: `Sonarr's scene numbering maps ${numbers.join(",")} to ${labelOf(sceneAbs as LibEpisode[])}` });
    if (!readings.length && seasons.length === 1) {
      const only = mapAll(seasons[0]);
      if (only) readings.push({ eps: only, method: "single-season", certainty: 0.9, why: `only season ${seasons[0]}` });
    }
    if (!readings.length) return fail([...why, `no Sonarr episode numbered ${numbers.join(",")} (absolute or in the newest season)`], "bare");
  }

  return finish(readings);

  function finish(rs: Reading[]): Resolution {
    // Air-date sanity: a release can't come out more than 2 days before its episode airs.
    const pub = opts.publishDate ?? null;
    let valid = rs;
    if (pub) {
      valid = rs.filter((r) => r.eps.every((e) => e.airUtc === null || e.airUtc <= pub + 2 * DAY));
      if (!valid.length) return fail([...why, `every reading airs after the release was published (${new Date(pub).toISOString().slice(0, 10)})`], rs[0].method);
    }
    // De-duplicate identical readings (keep the most certain, merge reasons).
    const uniq: Reading[] = [];
    for (const r of valid.sort((a, b) => b.certainty - a.certainty)) {
      const same = uniq.find((u) => u.eps.length === r.eps.length && u.eps.every((e, i) => e.id === r.eps[i].id));
      if (same) {
        same.certainty = Math.min(1, Math.max(same.certainty, r.certainty) + 0.03);
        same.why += `; also ${r.why}`;
      } else uniq.push({ ...r });
    }
    let best = uniq[0];
    let tieNote = "";
    if (uniq.length > 1) {
      if (pub) {
        const dist = (r: Reading) => Math.abs((r.eps[r.eps.length - 1].airUtc ?? 0) - pub);
        const sorted = [...uniq].sort((a, b) => dist(a) - dist(b));
        best = sorted[0];
        tieNote = `${uniq.length} readings fit; picked ${labelOf(best.eps)} because it aired closest to the release date (other: ${sorted.slice(1).map((r) => labelOf(r.eps)).join(", ")})`;
        best.certainty = Math.min(best.certainty, dist(sorted[1]) - dist(best) > 14 * DAY ? 0.9 : 0.7);
      } else {
        best.certainty = Math.min(best.certainty, 0.7);
        tieNote = `ambiguous: also could be ${uniq.slice(1).map((r) => labelOf(r.eps)).join(", ")}`;
      }
    }
    const confidence = Math.round(cand.score * best.certainty);
    return {
      ok: true,
      episodes: best.eps,
      label: labelOf(best.eps),
      confidence,
      method: best.method,
      why: [...why, best.why, ...(tieNote ? [tieNote] : [])],
      pack: best.eps.length > 1,
    };
  }
}
