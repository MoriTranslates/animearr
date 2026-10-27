/**
 * "Fix detection": when a file has subtitles that the scan didn't recognise. Track-language overrides (kept by
 * AnimeArr, survive rescans; optionally written into the MKV header with mkvpropedit), sidecar renames, a one-file
 * rescan, and a "peek" of a few frames to spot burned-in subtitles. Every change is logged with an undo.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR, cache, db } from "./db.js";
import { underAllowedRoot } from "./settings.js";
import { localPath } from "./paths.js";
import { keyOf, probeFile, recordFor } from "./mediafiles.js";
import { logDecision } from "./activity.js";
import { learnFromVerify } from "./library.js";

export interface TrackOverride { id: number; path: string; trackIndex: number; lang: string | null; forced: boolean; at: number }

let memo: Map<string, TrackOverride[]> | null = null;
const load = () => {
  if (memo) return memo;
  memo = new Map();
  for (const r of db.prepare("SELECT id, path, track_index, lang, forced, at FROM track_overrides").all() as { id: number; path: string; track_index: number; lang: string | null; forced: number; at: number }[]) {
    const o = { id: r.id, path: r.path, trackIndex: r.track_index, lang: r.lang, forced: !!r.forced, at: r.at };
    memo.set(r.path, [...(memo.get(r.path) ?? []), o]);
  }
  return memo;
};
const invalidate = () => void (memo = null);

/** The user's corrections for a file's subtitle tracks (applied wherever the file's tracks are read). */
export function overridesFor(p: string) {
  return load().get(keyOf(p)) ?? [];
}

/** Applies overrides to a record's subtitle tracks (language, signs-only). */
export function applyOverrides<T extends { index: number; lang: string | null; partial: boolean; forced: boolean }>(p: string, subs: T[]): T[] {
  const os = overridesFor(p);
  if (!os.length) return subs;
  return subs.map((s) => {
    const o = os.find((x) => x.trackIndex === s.index);
    return o ? { ...s, lang: o.lang, partial: o.forced, forced: o.forced || s.forced, overridden: true } : s;
  });
}

const bad = (m: string, code = 400) => Object.assign(new Error(m), { statusCode: code });

/** Every track and sidecar of a file, the overrides, and sidecar files next to it that weren't recognised. */
export function fileDetail(p: string) {
  const rec = recordFor(p);
  const local = localPath(p);
  let strays: string[] = [];
  let sameEpisode: string | null = null;
  if (local) {
    try {
      const dir = path.dirname(local);
      const base = path.basename(local).replace(/\.[^.]+$/, "");
      const names = fs.readdirSync(dir);
      const known = new Set((rec?.sidecars ?? []).map((s) => s.file));
      strays = names.filter((n) => /\.(srt|ass|ssa|vtt|sub|idx|sup)$/i.test(n) && !known.has(n) && (n.startsWith(base) || names.filter((x) => /\.(mkv|mp4|avi|m4v)$/i.test(x)).length === 1));
      // The *arr's path is out of date (renamed): the file for the same episode under another name.
      if (!fs.existsSync(local)) {
        const tag = /S\d{2}E\d{2,3}/i.exec(base)?.[0];
        sameEpisode = tag ? (names.find((n) => n.toUpperCase().includes(tag.toUpperCase()) && /\.(mkv|mp4|avi|m4v)$/i.test(n)) ?? null) : null;
      }
    } catch {
      /* unreadable folder */
    }
  }
  return {
    path: p,
    scanned: !!rec,
    exists: local ? fs.existsSync(local) : null,
    sameEpisode,
    container: rec?.container ?? null,
    duration: rec?.duration ?? null,
    video: rec?.video ?? null,
    audio: rec?.audio ?? [],
    subs: rec?.subs ?? [],
    sidecars: rec?.sidecars ?? [],
    strays,
    overrides: overridesFor(p),
    mkv: /\.mkv$/i.test(p),
  };
}

/** Files that a scope reaches: this file, its season, or every file of the same release group in the show/library. */
function scopeFiles(p: string, scope: "file" | "season" | "group", ctx: { tvdbId?: number | null; season?: number | null; group?: string | null }) {
  if (scope === "file") return [keyOf(p)];
  if (scope === "season" && ctx.tvdbId) {
    const s = cache.prepare("SELECT id FROM series WHERE tvdb_id = ?").get(ctx.tvdbId) as { id: number } | undefined;
    if (!s) return [keyOf(p)];
    return (cache.prepare("SELECT path FROM files WHERE series_id = ? AND season = ?").all(s.id, ctx.season ?? 0) as { path: string }[]).map((r) => keyOf(r.path));
  }
  if (scope === "group" && ctx.group) return (cache.prepare("SELECT path FROM files WHERE lower(release_group) = lower(?)").all(ctx.group) as { path: string }[]).map((r) => keyOf(r.path));
  return [keyOf(p)];
}

/**
 * "This is English" / "This is signs-only": records the language of a subtitle track for the file (or the same
 * track in every file of the season / release group). The group scope also teaches the learned group languages.
 */
export async function setTrackLanguage(input: { path: string; trackIndex: number; lang: string | null; forced?: boolean; scope?: "file" | "season" | "group"; tvdbId?: number | null; season?: number | null; group?: string | null; title?: string; alsoTag?: boolean }) {
  const lang = input.lang ? String(input.lang).toLowerCase().slice(0, 8) : null;
  if (lang && !/^[a-z]{2,3}(-[a-z]{2,4})?$/.test(lang)) throw bad("Pick a language code like en");
  const scope = input.scope ?? "file";
  const files = scopeFiles(input.path, scope, input);
  const now = Date.now();
  const ins = db.prepare("INSERT INTO track_overrides (path, track_index, lang, forced, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path, track_index) DO UPDATE SET lang = excluded.lang, forced = excluded.forced, at = excluded.at RETURNING id");
  const ids: number[] = [];
  const subFiles: string[] = [];
  for (const f of files) {
    // Only files whose track at that index is a subtitle track (season/group: the same layout).
    const rec = recordFor(f);
    const isSub = !!rec?.subs.some((s) => s.index === input.trackIndex);
    if (f !== keyOf(input.path) && !isSub) continue;
    if (isSub) subFiles.push(f);
    ids.push((ins.get(f, input.trackIndex, lang, input.forced ? 1 : 0, now) as { id: number }).id);
  }
  invalidate();
  if (scope === "group" && input.group && lang && !input.forced) learnFromVerify(input.group, "*", [lang], []);
  const tagged: string[] = [];
  // Writing into the files: only where that track is a subtitle track, and never across a whole release group
  // (header edits aren't undone by the Activity undo).
  if (input.alsoTag && lang && scope !== "group") for (const f of subFiles) if (await writeTag(f, input.trackIndex, lang, !!input.forced).catch(() => false)) tagged.push(f);
  const what = input.forced ? `signs-only ${lang ?? ""}`.trim() : lang ? `${lang} subtitles` : "no language";
  logDecision("fact", {
    tvdbId: input.tvdbId ?? null,
    title: input.title,
    why: `You marked subtitle track ${input.trackIndex} as ${what} in ${ids.length} file${ids.length === 1 ? "" : "s"} (${scope === "file" ? path.posix.basename(input.path) : scope === "season" ? `season ${input.season}` : `release group ${input.group}`})${tagged.length ? `; the tag was also written into ${tagged.length} file${tagged.length === 1 ? "" : "s"}` : ""}`,
    undo: { action: "delete-overrides", args: { ids: ids.join(",") } },
  });
  return { files: ids.length, tagged: tagged.length };
}

export function deleteOverrides(ids: number[]) {
  for (const id of ids) db.prepare("DELETE FROM track_overrides WHERE id = ?").run(id);
  invalidate();
}

/** Writes the language (and forced flag) into the MKV header in place (mkvpropedit; no remux). MKV only. */
function writeTag(p: string, trackIndex: number, lang: string, forced: boolean): Promise<boolean> {
  const local = localPath(p);
  if (!local || !/\.mkv$/i.test(local) || !underAllowedRoot(p)) return Promise.resolve(false);
  const iso3: Record<string, string> = { en: "eng", ja: "jpn", es: "spa", fr: "fre", de: "ger", it: "ita", pt: "por", ru: "rus", zh: "chi", ko: "kor", ar: "ara" };
  return new Promise((resolve) => {
    const p2 = spawn("mkvpropedit", [local, "--edit", `track:${trackIndex + 1}`, "--set", `language=${iso3[lang] ?? lang}`, "--set", `flag-forced=${forced ? 1 : 0}`], { stdio: "ignore" });
    p2.on("error", () => resolve(false));
    p2.on("close", (code) => resolve(code === 0));
  });
}

/** "Use this as English": renames a sidecar to "<video>.<lang>.<ext>" next to the video (undoable). */
export function useSidecar(input: { video: string; file: string; lang: string; tvdbId?: number | null; title?: string }) {
  const local = localPath(input.video);
  if (!local || !underAllowedRoot(input.video)) throw bad("That file isn't in an allowed root folder");
  const dir = path.dirname(local);
  const name = path.basename(String(input.file));
  if (name !== input.file || !/\.(srt|ass|ssa|vtt|sub|sup)$/i.test(name)) throw bad("Pick a subtitle file next to the video");
  const lang = String(input.lang).toLowerCase();
  if (!/^[a-z]{2,3}$/.test(lang)) throw bad("Pick a language code like en");
  const to = `${path.basename(local).replace(/\.[^.]+$/, "")}.${lang}${path.extname(name).toLowerCase()}`;
  if (fs.existsSync(path.join(dir, to))) throw bad(`${to} already exists`, 409);
  fs.renameSync(path.join(dir, name), path.join(dir, to));
  logDecision("fact", { tvdbId: input.tvdbId ?? null, title: input.title, why: `Renamed the subtitle file ${name} to ${to} (used as ${lang})`, undo: { action: "rename-sidecar-back", args: { dir: keyOf(path.posix.dirname(input.video)), from: to, to: name } } });
  return { renamed: to };
}

export function renameSidecarBack(a: { dir: string; from: string; to: string }) {
  const local = localPath(`${a.dir}/${a.from}`);
  if (!local) throw bad("Can't reach that folder");
  const target = path.join(path.dirname(local), path.basename(a.to));
  if (fs.existsSync(target)) throw bad(`${a.to} exists again; leaving both`, 409);
  fs.renameSync(local, target);
}

/** Probes one file again now (stale scan). */
export async function rescanOne(p: string, probe: typeof probeFile = probeFile) {
  const local = localPath(p);
  if (!local || !fs.existsSync(local)) throw bad("AnimeArr can't reach that file (it may have been renamed or moved)", 404);
  const st = fs.statSync(local);
  const r = await probe(local);
  const root = keyOf(path.posix.dirname(path.posix.dirname(p)));
  const old = db.prepare("SELECT sidecars, root FROM media_files WHERE path = ?").get(keyOf(p)) as { sidecars: string; root: string } | undefined;
  db.prepare(
    `INSERT INTO media_files (path, root, size, mtime, probed_at, duration, container, video, audio, subs, sidecars, error, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, probed_at = excluded.probed_at, duration = excluded.duration, container = excluded.container, video = excluded.video, audio = excluded.audio, subs = excluded.subs, error = NULL, seen_at = excluded.seen_at`,
  ).run(keyOf(p), old?.root ?? root, st.size, Math.round(st.mtimeMs), Date.now(), r.duration ?? null, r.container ?? null, JSON.stringify(r.video ?? null), JSON.stringify(r.audio ?? []), JSON.stringify(r.subs ?? []), old?.sidecars ?? "[]", Date.now());
  return { ok: true };
}

/** Three frames from the middle of the file (25 %, 50 %, 75 %), small WebP, cached: to spot burned-in subtitles. */
export async function peekFrames(p: string, duration: number | null): Promise<string[]> {
  const local = localPath(p);
  if (!local || !fs.existsSync(local)) throw bad("AnimeArr can't reach that file", 404);
  const dur = duration ?? recordFor(p)?.duration ?? 1440;
  const dir = path.join(CACHE_DIR, "peek");
  fs.mkdirSync(dir, { recursive: true });
  const key = crypto.createHash("sha1").update(`${keyOf(p)}|${fs.statSync(local).size}`).digest("hex");
  const out: string[] = [];
  for (const [i, frac] of [0.25, 0.5, 0.75].entries()) {
    const file = path.join(dir, `${key}-${i}.webp`);
    if (!fs.existsSync(file)) await frame(local, Math.max(1, Math.round(dur * frac)), file);
    if (fs.existsSync(file)) out.push(`data:image/webp;base64,${fs.readFileSync(file).toString("base64")}`);
  }
  return out;
}

function frame(local: string, sec: number, file: string) {
  return new Promise<void>((resolve) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", String(sec), "-i", local, "-frames:v", "1", "-vf", "scale='min(640,iw)':-2", "-c:v", "libwebp", "-quality", "70", "-y", file], { stdio: "ignore" });
    const t = setTimeout(() => p.kill("SIGKILL"), 30_000);
    p.on("error", () => (clearTimeout(t), resolve()));
    p.on("close", () => (clearTimeout(t), resolve()));
  });
}
