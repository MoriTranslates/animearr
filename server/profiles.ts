/**
 * Language profiles (PROPOSAL §5.4): named profiles with a default, a per-show override (profile and/or watch mode),
 * and the "effective" profile used by ranking, verification and the audits. The original audio language comes from
 * the series (Japanese, Chinese for donghua, Korean...), so dub detection never mistakes original audio for a dub.
 */
import crypto from "node:crypto";
import { logDecision } from "./activity.js";
import { toLang } from "./core/langs.js";
import { cache, db, dbState } from "./db.js";
import { getSettings, patchSettings, SIZE_PRESETS, WATCH_MODES, type LanguageProfile, type SizePreset, type WatchMode } from "./settings.js";

export interface EffectiveProfile extends LanguageProfile {
  /** Original audio language(s) of the show (e.g. ["ja"], ["zh"] for donghua). */
  originalLangs: string[];
  /** Where the watch mode came from. */
  source: "default" | "profile" | "show";
  /** The profile's own watch mode (before a per-show override). */
  profileMode?: WatchMode;
}

export const listProfiles = () => getSettings().profiles;
export function defaultProfile(): LanguageProfile {
  const s = getSettings();
  return s.profiles.find((p) => p.id === s.defaultProfileId) ?? s.profiles[0];
}

const LANG = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/;
const cleanLangs = (v: unknown) => [...new Set((Array.isArray(v) ? v : String(v ?? "").split(",")).map((x) => String(x).trim().toLowerCase()).filter((x) => LANG.test(x)))].slice(0, 10);

/** Validates an untrusted profile from the UI. */
export function validateProfile(input: Partial<LanguageProfile>, base: LanguageProfile): LanguageProfile {
  const name = String(input.name ?? base.name).trim().slice(0, 60);
  if (!name) throw Object.assign(new Error("Give the profile a name"), { statusCode: 400 });
  const watchMode = WATCH_MODES.includes(input.watchMode as WatchMode) ? (input.watchMode as WatchMode) : base.watchMode;
  const subLangs = input.subLangs !== undefined ? cleanLangs(input.subLangs) : base.subLangs;
  const dubLangs = input.dubLangs !== undefined ? cleanLangs(input.dubLangs) : base.dubLangs;
  if (watchMode !== "dub" && !subLangs.length) throw Object.assign(new Error("Add at least one subtitle language (e.g. en)"), { statusCode: 400 });
  if (watchMode !== "sub" && !dubLangs.length) throw Object.assign(new Error("Add at least one dub language (e.g. en)"), { statusCode: 400 });
  const order = Array.isArray(input.protocolOrder) ? [...new Set(input.protocolOrder.filter((x) => x === "usenet" || x === "torrent"))] : base.protocolOrder;
  const resolution = [2160, 1080, 720, 480].includes(Number(input.resolution)) ? Number(input.resolution) : base.resolution;
  return {
    id: base.id,
    name,
    watchMode,
    subLangs,
    dubLangs,
    softOnly: typeof input.softOnly === "boolean" ? input.softOnly : base.softOnly,
    preferUncensored: typeof input.preferUncensored === "boolean" ? input.preferUncensored : base.preferUncensored,
    protocolOrder: order.length ? order : base.protocolOrder,
    noProtocolPreference: typeof input.noProtocolPreference === "boolean" ? input.noProtocolPreference : (base.noProtocolPreference ?? false),
    resolution,
    sizePreset: SIZE_PRESETS.includes(input.sizePreset as SizePreset) ? input.sizePreset : (base.sizePreset ?? "lean"),
    groupConsistency: input.groupConsistency === "off" || input.groupConsistency === "strong" || input.groupConsistency === "prefer" ? input.groupConsistency : (base.groupConsistency ?? "prefer"),
  };
}

const guard = () => {
  if (dbState.corrupt) throw Object.assign(new Error("The database failed its integrity check; restore a backup first"), { statusCode: 503 });
};

export function saveProfile(id: string | null, input: Partial<LanguageProfile>, makeDefault = false) {
  guard();
  const s = getSettings();
  const existing = id ? s.profiles.find((p) => p.id === id) : undefined;
  if (id && !existing) throw Object.assign(new Error("Unknown profile"), { statusCode: 404 });
  if (!existing && s.profiles.length >= 20) throw Object.assign(new Error("Up to 20 profiles"), { statusCode: 400 });
  const base = existing ?? { ...defaultProfile(), id: crypto.randomUUID().slice(0, 8), name: "" };
  const p = validateProfile(input, base);
  patchSettings((x) => ({ ...x, profiles: existing ? x.profiles.map((q) => (q.id === p.id ? p : q)) : [...x.profiles, p], defaultProfileId: makeDefault ? p.id : x.defaultProfileId }));
  logDecision("info", { why: `${existing ? "Changed" : "Added"} language profile "${p.name}" (${p.watchMode}, subtitles ${p.subLangs.join("/") || "—"}, dub ${p.dubLangs.join("/") || "—"})${makeDefault ? ", now the default" : ""}` });
  return p;
}

export function deleteProfile(id: string) {
  guard();
  const s = getSettings();
  if (id === s.defaultProfileId) throw Object.assign(new Error("That's the default profile; make another one the default first"), { statusCode: 409 });
  const p = s.profiles.find((x) => x.id === id);
  if (!p) throw Object.assign(new Error("Unknown profile"), { statusCode: 404 });
  patchSettings((x) => ({ ...x, profiles: x.profiles.filter((q) => q.id !== id) }));
  const moved = db.prepare("UPDATE series_prefs SET profile_id = NULL, updated_at = ? WHERE profile_id = ?").run(Date.now(), id).changes;
  logDecision("info", { why: `Deleted language profile "${p.name}"${moved ? `; ${moved} show(s) using it now follow the default` : ""}` });
}

export function seriesPrefs(tvdbId: number) {
  return (db.prepare("SELECT profile_id, watch_mode, size_preset FROM series_prefs WHERE tvdb_id = ?").get(tvdbId) as { profile_id: string | null; watch_mode: WatchMode | null; size_preset: SizePreset | null } | undefined) ?? { profile_id: null, watch_mode: null, size_preset: null };
}

/** Per-show override: a profile, and/or just a different watch mode or size preset. null = follow the default. */
export function setSeriesPrefs(tvdbId: number, profileId: string | null, watchMode: WatchMode | null, sizePreset?: SizePreset | null) {
  guard();
  if (profileId && !getSettings().profiles.some((p) => p.id === profileId)) throw Object.assign(new Error("Unknown profile"), { statusCode: 400 });
  if (watchMode && !WATCH_MODES.includes(watchMode)) throw Object.assign(new Error("Unknown watch mode"), { statusCode: 400 });
  if (sizePreset && !SIZE_PRESETS.includes(sizePreset)) throw Object.assign(new Error("Unknown size preset"), { statusCode: 400 });
  const size = sizePreset === undefined ? seriesPrefs(tvdbId).size_preset : sizePreset;
  db.prepare("INSERT INTO series_prefs (tvdb_id, profile_id, watch_mode, size_preset, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tvdb_id) DO UPDATE SET profile_id = excluded.profile_id, watch_mode = excluded.watch_mode, size_preset = excluded.size_preset, updated_at = excluded.updated_at").run(tvdbId, profileId, watchMode, size, Date.now());
  const title = (cache.prepare("SELECT title FROM series WHERE tvdb_id = ?").get(tvdbId) as { title: string } | undefined)?.title ?? String(tvdbId);
  const eff = profileFor(tvdbId);
  logDecision("info", { tvdbId, title, why: `${title} now uses "${eff.name}" with watch mode ${eff.watchMode}${eff.source === "show" ? " (set for this show)" : ""}` });
  return eff;
}

/** Original audio language(s) of a show, from Sonarr's original language (Japanese → ja, Chinese → zh ...). */
export function originalLangs(tvdbId: number | null): string[] {
  if (tvdbId === null) return ["ja"];
  const r = cache.prepare("SELECT original_language FROM series WHERE tvdb_id = ?").get(tvdbId) as { original_language: string | null } | undefined;
  if (!r?.original_language) return ["ja"]; // nothing synced yet: anime default
  const l = toLang(r.original_language);
  // Unknown or unmappable → no original-audio check rather than a wrong guess.
  return l && l !== "und" && /^[a-z]{2,3}$/.test(l) ? [l] : [];
}

/** The profile that applies to a show (or the default when no show is given). */
export function profileFor(tvdbId: number | null = null): EffectiveProfile {
  const base = defaultProfile();
  if (tvdbId === null) return { ...base, sizePreset: base.sizePreset ?? "lean", originalLangs: ["ja"], source: "default" };
  const prefs = seriesPrefs(tvdbId);
  const chosen = prefs.profile_id ? getSettings().profiles.find((p) => p.id === prefs.profile_id) : undefined;
  const prof = chosen ?? base;
  return { ...prof, profileMode: prof.watchMode, watchMode: prefs.watch_mode ?? prof.watchMode, sizePreset: prefs.size_preset ?? prof.sizePreset ?? "lean", originalLangs: originalLangs(tvdbId), source: prefs.watch_mode ? "show" : chosen ? "profile" : "default" };
}

// ---------------------------------------------------------------- movies

export function moviePrefs(movieId: number) {
  return (db.prepare("SELECT profile_id, watch_mode FROM movie_prefs WHERE movie_id = ?").get(movieId) as { profile_id: string | null; watch_mode: WatchMode | null } | undefined) ?? { profile_id: null, watch_mode: null };
}

/** Per-movie override, like a show's. null = follow the default. */
export function setMoviePrefs(movieId: number, profileId: string | null, watchMode: WatchMode | null) {
  guard();
  if (profileId && !getSettings().profiles.some((p) => p.id === profileId)) throw Object.assign(new Error("Unknown profile"), { statusCode: 400 });
  if (watchMode && !WATCH_MODES.includes(watchMode)) throw Object.assign(new Error("Unknown watch mode"), { statusCode: 400 });
  if (!profileId && !watchMode) db.prepare("DELETE FROM movie_prefs WHERE movie_id = ?").run(movieId);
  else db.prepare("INSERT INTO movie_prefs (movie_id, profile_id, watch_mode, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(movie_id) DO UPDATE SET profile_id = excluded.profile_id, watch_mode = excluded.watch_mode, updated_at = excluded.updated_at").run(movieId, profileId, watchMode, Date.now());
  return moviePrefs(movieId);
}

/** The profile that applies to a movie (anime movies are Japanese originals). */
export function profileForMovie(movieId: number): EffectiveProfile {
  const base = defaultProfile();
  const prefs = moviePrefs(movieId);
  const chosen = prefs.profile_id ? getSettings().profiles.find((p) => p.id === prefs.profile_id) : undefined;
  const prof = chosen ?? base;
  return { ...prof, profileMode: prof.watchMode, watchMode: prefs.watch_mode ?? prof.watchMode, sizePreset: prof.sizePreset ?? "lean", originalLangs: ["ja"], source: prefs.watch_mode ? "show" : chosen ? "profile" : "default" };
}
