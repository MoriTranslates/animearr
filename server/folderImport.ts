/**
 * Import an existing anime folder without Sonarr: list a root's show folders, match each to a show (folder-name ID
 * hints first, then title/year against AnimeArr's alias index and AniList), and adopt the folder as it is.
 *
 * Read-only on the disk: folders are listed and files are probed, never moved, renamed or deleted. The matching is
 * one folder per call so the caller paces the AniList traffic (searches share the app's slow queue).
 */
import fs from "node:fs";
import path from "node:path";
import { mediaByIds } from "./anilist.js";
import { fribb } from "./covers.js";
import { identify } from "./core/identify.js";
import { compactKey, splitSeason } from "./core/normalize.js";
import { cache, db } from "./db.js";
import { addShow, NATIVE_BASE, rematerializeSeries, searchAdd, type AddResult } from "./native.js";
import { aliasIndex, animeListEntries } from "./metadata.js";
import { localPath } from "./paths.js";
import { VIDEO, scanFolder } from "./mediafiles.js";
import { hiddenInBrowser } from "./roots.js";
import { identifyContext } from "./search.js";
import { getSettings } from "./settings.js";

const err = (msg: string, statusCode = 400) => Object.assign(new Error(msg), { statusCode });
const slash = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

// ---------------------------------------------------------------- folder names

export interface FolderHints { tvdb?: number; anidb?: number; tmdb?: number }
export interface ParsedFolder { name: string; title: string; year: number | null; hints: FolderHints }

/** Release-style tags that carry no title: "(BD 1080p)", "(Dual Audio)", "(Uncensored)", "(TV)". */
const NOISE = /^(?:bd|bluray|blu-ray|web|webrip|dvd|hdtv|\d{3,4}p|dual[ -]audio|multi|uncensored|censored|complete|batch|tv|ova|ona|raw|sub|dub|remux|x26[45]|hevc|10bit)\b/i;

/**
 * "Frieren - Beyond Journey's End (2023) {tvdb-424536}" → title, year and ID hints. Hints are `{tvdb-N}`, `[tvdbid-N]`,
 * `{anidb-N}`, `[anidbid-N]`, `{tmdb-N}` (Plex/Jellyfin/Sonarr style, either bracket).
 */
export function parseFolderName(name: string): ParsedFolder {
  const hints: FolderHints = {};
  let s = name.normalize("NFC");
  s = s.replace(/[{[]\s*(tvdb|anidb|tmdb)(?:id)?\s*[-=:]\s*(\d+)\s*[}\]]/gi, (_m, k: string, n: string) => {
    hints[k.toLowerCase() as keyof FolderHints] ??= Number(n);
    return " ";
  });
  let year: number | null = null;
  s = s.replace(/[([]\s*((?:19|20)\d{2})\s*[)\]]/g, (_m, y: string) => {
    year ??= Number(y);
    return " ";
  });
  s = s.replace(/[[{][^\]}]*[\]}]/g, " "); // "[SubGroup]" and "[1080p BD]" style tags
  s = s.replace(/\(([^)]*)\)/g, (m, inner: string) => (NOISE.test(inner.trim()) ? " " : m));
  if (!/\s/.test(s.trim())) s = s.replace(/[._]+/g, " "); // "Sword.Art.Online" / "Sword_Art_Online"
  const title = s.replace(/\s+/g, " ").trim().replace(/[\s\-–—_.]+$/, "");
  return { name, title, year, hints };
}

// ---------------------------------------------------------------- scanning a root

export interface RootFolder { name: string; path: string; videos: number }
export interface RootScan { root: string; folders: RootFolder[]; skipped: { owned: number; hidden: number } }

const SYSTEM_FOLDERS = /^(@eaDir|#recycle|\$RECYCLE\.BIN|System Volume Information|lost\+found|\.Trash.*|Recycle ?Bin|@Recycle|\.@__thumb)$/i;

/** Video files under a folder (shallow walk, capped) so the review can say "12 files" or "empty". */
function countVideos(dir: string, depth = 3, cap = 500): number {
  let n = 0;
  let list: fs.Dirent[] = [];
  try {
    list = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of list) {
    if (n >= cap) break;
    if (e.isFile() && VIDEO.test(e.name)) n++;
    else if (e.isDirectory() && depth > 0 && !e.name.startsWith(".")) n += countVideos(path.join(dir, e.name), depth - 1, cap - n);
  }
  return n;
}

const allowedRoot = (root: string) => {
  const r = slash(String(root ?? ""));
  if (!r || !getSettings().allowedRoots.some((a) => slash(a) === r)) throw err("Pick one of the allowed root folders");
  return r;
};

/** Paths already owned by a show in AnimeArr's library (Sonarr's or native), lower-cased for comparison. */
function ownedPaths() {
  const rows = [...(cache.prepare("SELECT path FROM series").all() as { path: string }[]), ...(db.prepare("SELECT path FROM native_series").all() as { path: string }[])];
  return new Set(rows.map((r) => slash(r.path).toLowerCase()));
}

/** The top-level show folders of one allowed root, minus hidden/system folders and folders a show already owns. */
export function scanRoot(rootFolder: string): RootScan {
  const root = allowedRoot(rootFolder);
  const local = localPath(root);
  if (!local) throw err(`AnimeArr can't open ${root}`);
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(local, { withFileTypes: true });
  } catch (e) {
    throw err(`Can't open ${root} (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
  const owned = ownedPaths();
  const out: RootScan = { root, folders: [], skipped: { owned: 0, hidden: 0 } };
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    let dir = e.isDirectory();
    if (!dir && e.isSymbolicLink()) {
      try {
        dir = fs.statSync(path.join(local, e.name)).isDirectory(); // symlinked mounts are folders too
      } catch {
        /* dangling */
      }
    }
    if (!dir) continue;
    if (e.name.startsWith(".") || SYSTEM_FOLDERS.test(e.name) || hiddenInBrowser(root, e.name)) {
      out.skipped.hidden++;
      continue;
    }
    const p = `${root}/${e.name}`;
    if (owned.has(p.toLowerCase())) {
      out.skipped.owned++;
      continue;
    }
    out.folders.push({ name: e.name, path: p, videos: countVideos(path.join(local, e.name)) });
  }
  return out;
}

// ---------------------------------------------------------------- matching

export interface FolderCandidate extends Pick<AddResult, "anilistId" | "title" | "romaji" | "year" | "kind" | "episodes" | "cover" | "tvdbId"> {
  score: number;
  /** Plain reason this candidate fits. */
  reason: string;
  /** The show it would become is already in the library. */
  owned: boolean;
}
export type Confidence = "confident" | "likely" | "unsure" | "none";
export interface FolderMatch { folder: ParsedFolder; candidates: FolderCandidate[]; best: FolderCandidate | null; confidence: Confidence; reason: string; anilist: string }

export interface MatchDeps {
  search: (q: string) => Promise<{ results: AddResult[]; anilist: string }>;
  fribb: typeof fribb;
  media: typeof mediaByIds;
}
const defaultDeps = (): MatchDeps => ({ search: (q) => searchAdd(q), fribb, media: mediaByIds });

const showKey = (c: { tvdbId: number | null; anilistId: number }) => c.tvdbId ?? NATIVE_BASE + c.anilistId;
/** The show a candidate would become is already here (a Sonarr or native show with the same TVDB id / synthetic id). */
const isOwned = (c: { tvdbId: number | null; anilistId: number }) => !!cache.prepare("SELECT 1 FROM series WHERE tvdb_id = ?").get(showKey(c));

const head = (t: string) => compactKey(t.split(/\s*[:：]\s*|\s+[-–—]\s+/)[0]);

/** How well a folder's title fits one candidate (0..1) and why. Titles are compared in every spelling AniList has. */
export function scoreTitle(folderTitle: string, c: Pick<AddResult, "title" | "romaji" | "native">): { score: number; why: string } {
  const fk = compactKey(folderTitle);
  if (!fk) return { score: 0, why: "" };
  const fsplit = splitSeason(folderTitle);
  const fbase = fsplit.base.replace(/ /g, "");
  let best = { score: 0, why: "" };
  const take = (score: number, why: string) => {
    if (score > best.score) best = { score, why };
  };
  for (const t of [c.title, c.romaji, c.native]) {
    if (!t) continue;
    const tk = compactKey(t);
    if (!tk) continue;
    if (tk === fk) take(1, `the title matches "${t}"`);
    const tsplit = splitSeason(t);
    const tbase = tsplit.base.replace(/ /g, "");
    // "Konosuba 2nd Season" vs the franchise's entries: same base, the season marker is the folder's own.
    if (fsplit.season !== null && tbase === fbase) take(tsplit.season === fsplit.season ? 0.95 : 0.8, tsplit.season === fsplit.season ? `the title and season match "${t}"` : `"${t}" is the same show (the folder says season ${fsplit.season}; the whole show is added)`);
    // Subtitle after a colon/dash on either side: "Fate/Zero: Remix" vs "Fate/Zero".
    if (fk.length >= 4 && tk.length >= 4 && (tk.startsWith(fk) || fk.startsWith(tk))) take(0.6 + 0.3 * (Math.min(fk.length, tk.length) / Math.max(fk.length, tk.length)), `the title starts like "${t}"`);
    const hf = head(folderTitle);
    if (hf.length >= 4 && hf === head(t)) take(0.7, `the main title matches "${t}" (the subtitle differs)`);
  }
  return best;
}

const fromEntry = (e: Record<string, unknown>): AddResult => ({
  anilistId: e.anilist_id as number, title: (e.title_english ?? e.title_romaji ?? e.title_native ?? String(e.anilist_id)) as string, romaji: (e.title_romaji as string | null) ?? null, native: (e.title_native as string | null) ?? null,
  kind: (e.kind as string | null) ?? null, year: (e.season_year as number | null) ?? null, episodes: (e.episodes as number | null) ?? null, status: (e.status as string | null) ?? null, cover: (e.cover as string | null) ?? null,
  country: (e.country as string | null) ?? null, tvdbId: (e.tvdb_id as number | null) ?? null, tmdbMovie: null, inLibrary: null, matchedBy: "folder name ID", trailer: null,
});

/** Folder-name IDs → the AniList entry they name (catalog first, then one AniList lookup), or null. */
async function fromHints(h: FolderHints, deps: MatchDeps): Promise<{ result: AddResult; why: string } | null> {
  const f = await deps.fribb();
  const al = animeListEntries();
  let anilistId: number | undefined;
  let why = "";
  if (h.anidb) {
    anilistId = f.anidbToAnilist.get(h.anidb);
    why = `the folder name says AniDB ${h.anidb}`;
  }
  if (!anilistId && h.tvdb) {
    const e = db.prepare("SELECT * FROM entries WHERE tvdb_id = ? AND tvdb_season IS NOT NULL AND tvdb_season != '0' ORDER BY start_date IS NULL, start_date LIMIT 1").get(h.tvdb) as Record<string, unknown> | undefined;
    if (e) return { result: fromEntry(e), why: `the folder name says TVDB ${h.tvdb}` };
    const mapped = [...al.values()].filter((x) => x.tvdbId === h.tvdb && f.anidbToAnilist.has(x.aid));
    const first = mapped.find((x) => x.defaultSeason === 1) ?? mapped[0];
    if (first) anilistId = f.anidbToAnilist.get(first.aid);
    why = `the folder name says TVDB ${h.tvdb}`;
  }
  if (!anilistId && h.tmdb) {
    const hit = [...al.values()].find((x) => x.tmdbTv === h.tmdb && f.anidbToAnilist.has(x.aid));
    anilistId = hit ? f.anidbToAnilist.get(hit.aid) : [...f.anilistToTmdb].find(([, t]) => t === h.tmdb)?.[0];
    why = `the folder name says TMDB ${h.tmdb}`;
  }
  if (!anilistId) return null;
  const e = db.prepare("SELECT * FROM entries WHERE anilist_id = ?").get(anilistId) as Record<string, unknown> | undefined;
  if (e) return { result: fromEntry(e), why };
  const [m] = await deps.media([anilistId]);
  if (!m) return null;
  const aid = f.anilistToAnidb.get(m.id);
  return {
    result: { anilistId: m.id, title: m.title.english ?? m.title.romaji ?? m.title.native ?? String(m.id), romaji: m.title.romaji, native: m.title.native, kind: m.format, year: m.seasonYear ?? m.startDate?.year ?? null, episodes: m.episodes, status: m.status, cover: m.coverImage?.large ?? null, country: m.countryOfOrigin, tvdbId: aid ? (al.get(aid)?.tvdbId ?? null) : null, tmdbMovie: null, inLibrary: null, matchedBy: "folder name ID", trailer: null },
    why,
  };
}

const toCandidate = (r: AddResult, score: number, reason: string): FolderCandidate => ({ anilistId: r.anilistId, title: r.title, romaji: r.romaji, year: r.year, kind: r.kind, episodes: r.episodes, cover: r.cover, tvdbId: r.tvdbId, score: Math.round(score * 100) / 100, reason, owned: isOwned(r) || !!r.inLibrary });

/** Matches one folder to shows. Movies are left out (series only). */
export async function matchFolder(name: string, deps: MatchDeps = defaultDeps()): Promise<FolderMatch> {
  const folder = parseFolderName(name);
  const none = (reason: string, anilist = "ok"): FolderMatch => ({ folder, candidates: [], best: null, confidence: "none", reason, anilist });
  // 1. ID hints win.
  let hintNote = "";
  if (folder.hints.tvdb || folder.hints.anidb || folder.hints.tmdb) {
    const h = await fromHints(folder.hints, deps).catch(() => null);
    if (h && h.result.kind !== "MOVIE") {
      const c = toCandidate(h.result, 1, h.why);
      return { folder, candidates: [c], best: c, confidence: c.owned ? "unsure" : "confident", reason: `${h.why}: ${c.title}${c.owned ? " (already in the library)" : ""}`, anilist: "ok" };
    }
    hintNote = "The ID in the folder name isn't a show AnimeArr knows; matched by title instead. ";
  }
  // 2. Title (and year): the alias index (AniDB titles, offline) lends weight, AniList search finds the entries.
  if (folder.title.length < 2) return none("The folder name has no title to search for");
  const { results, anilist } = await deps.search(folder.title);
  const f = await deps.fribb();
  const known = aliasIndex().lookup(folder.title);
  const knownTvdb = new Set(known.filter((k) => k.score >= 80 && k.tvdbId).map((k) => k.tvdbId));
  const knownAnilist = new Set(known.filter((k) => k.score >= 80 && k.aid && f.anidbToAnilist.has(k.aid)).map((k) => f.anidbToAnilist.get(k.aid!)!));
  const scored = results
    .filter((r) => r.kind !== "MOVIE" && r.kind !== "MUSIC")
    .map((r) => {
      const t = scoreTitle(folder.title, r);
      let score = t.score;
      const why = [t.why];
      if (score > 0 && folder.year && r.year) {
        if (r.year === folder.year) {
          score = Math.min(1, score + 0.05);
          why.push(`year ${r.year}`);
        } else if (Math.abs(r.year - folder.year) > 1) {
          score -= 0.15;
          why.push(`but it aired in ${r.year}, the folder says ${folder.year}`);
        }
      }
      if (score > 0 && (knownAnilist.has(r.anilistId) || (r.tvdbId && knownTvdb.has(r.tvdbId)))) {
        score = Math.min(1, score + 0.05);
        why.push("a known AniDB title");
      }
      if (r.kind === "SPECIAL" || r.kind === "TV_SHORT") score -= 0.05;
      return toCandidate(r, Math.max(0, score), why.filter(Boolean).join("; "));
    })
    .filter((c) => c.score >= 0.4)
    .sort((a, b) => b.score - a.score || Number(a.kind !== "TV") - Number(b.kind !== "TV") || (a.year ?? 9999) - (b.year ?? 9999))
    .slice(0, 5);
  if (!scored.length) return none(`${hintNote}No show on AniList looks like "${folder.title}"${anilist === "busy" || anilist === "error" ? " (AniList was busy or unreachable; try again)" : ""}`, anilist);
  const best = scored.find((c) => !c.owned) ?? scored[0];
  // A different show close behind makes it ambiguous; other entries of the same TVDB show don't.
  const rival = scored.find((c) => c !== best && showKey(c) !== showKey(best));
  const confident = best.score >= 0.9 && !best.owned && (!rival || best.score - rival.score >= 0.1);
  const confidence: Confidence = confident ? "confident" : best.score >= 0.6 ? "likely" : "unsure";
  const reason = `${hintNote}${best.reason ? `${best.title}: ${best.reason}` : best.title}${rival && !confident && !best.owned ? `; ${rival.title} is nearly as close` : ""}${best.owned ? "; that show is already in the library" : ""}`;
  return { folder, candidates: scored, best, confidence, reason, anilist };
}

// ---------------------------------------------------------------- adopting

export interface AdoptResult { tvdbId: number; title: string; path: string; episodes: number; mapped: number; unmapped: { path: string; why: string }[] }

export interface AdoptDeps { add?: typeof addShow; scan?: typeof scanFolder }

/**
 * Adds the show with the existing folder as its path, records its files and maps them to episodes. Files that can't
 * be mapped are listed, not touched. Nothing on the disk is moved, renamed or deleted.
 */
export async function adoptFolder(input: { rootFolder: string; name: string; anilistId: number }, deps: AdoptDeps = {}): Promise<AdoptResult> {
  const root = allowedRoot(input.rootFolder);
  const name = String(input.name ?? "");
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") throw err("Not a folder name");
  const added = await (deps.add ?? addShow)({ anilistId: Number(input.anilistId), rootFolder: root, existingPath: `${root}/${name}` });
  await (deps.scan ?? scanFolder)(added.path).catch(() => undefined); // records and probes the files (read-only)
  const sid = (cache.prepare("SELECT id FROM series WHERE tvdb_id = ?").get(added.tvdbId) as { id: number } | undefined)?.id;
  if (sid === undefined) return { tvdbId: added.tvdbId, title: added.title, path: added.path, episodes: added.episodes, mapped: 0, unmapped: [] };
  rematerializeSeries(sid); // files named S01E05 / bare numbers are matched while building the show
  const mappedSet = () => new Set((cache.prepare("SELECT path FROM files WHERE series_id = ?").all(sid) as { path: string }[]).map((r) => r.path));
  const recs = () => db.prepare("SELECT path FROM media_files WHERE substr(path, 1, ?) = ? ORDER BY path").all(added.path.length + 1, `${added.path}/`) as { path: string }[];
  // The rest: the parser + resolver read the file name against this show's episodes.
  const have = mappedSet();
  const ctx = identifyContext();
  const minConf = getSettings().managed.minConfidence;
  const put = db.prepare("INSERT OR REPLACE INTO file_links (path, tvdb_id, episode_ids, at) VALUES (?, ?, ?, ?)");
  let linked = 0;
  for (const r of recs()) {
    if (have.has(r.path)) continue;
    const id = identify(path.posix.basename(r.path), ctx, { tvdbId: added.tvdbId });
    if (id.resolution?.ok && id.resolution.confidence >= minConf && !id.resolution.pack && id.resolution.episodes.length) {
      put.run(r.path, added.tvdbId, JSON.stringify(id.resolution.episodes.map((e) => e.id)), Date.now());
      linked++;
    }
  }
  if (linked) rematerializeSeries(sid);
  const done = mappedSet();
  const all = recs();
  const unmapped = all.filter((r) => !done.has(r.path)).map((r) => ({ path: r.path, why: "couldn't tell which episode this is" }));
  return { tvdbId: added.tvdbId, title: added.title, path: added.path, episodes: added.episodes, mapped: all.length - unmapped.length, unmapped };
}
