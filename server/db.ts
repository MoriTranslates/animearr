import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

/**
 * Two SQLite files:
 * - animearr.db: USER DATA (settings, aliases, numbering rules, managed shows, decisions, learning). Backed up nightly
 *   and before every migration; never deleted automatically.
 * - cache.db: REBUILDABLE (Sonarr/Radarr sync, metadata fetch state, job status). If it is damaged it is dropped and
 *   rebuilt by the next sync, so a broken cache never costs user data.
 *
 * Both use WAL with synchronous=FULL, a busy timeout and foreign keys. Exactly one AnimeArr process may own a config
 * folder (a lock file enforces it).
 */

if (process.env.UMASK && /^[0-7]{3,4}$/.test(process.env.UMASK)) process.umask(parseInt(process.env.UMASK, 8));
const isProd = process.env.NODE_ENV === "production";
export const CONFIG_DIR = path.resolve(process.env.ANIMEARR_CONFIG ?? (isProd ? "/config" : ".devconfig"));
export const BACKUP_DIR = path.join(CONFIG_DIR, "backups");
export const CACHE_DIR = path.join(CONFIG_DIR, "cache");
const USER_DB = path.join(CONFIG_DIR, "animearr.db");
const CACHE_DB = path.join(CONFIG_DIR, "cache.db");
const LOCK = path.join(CONFIG_DIR, "animearr.lock");

export const startupWarnings: string[] = [];

try {
  for (const d of [CONFIG_DIR, BACKUP_DIR, CACHE_DIR]) fs.mkdirSync(d, { recursive: true });
  fs.accessSync(CONFIG_DIR, fs.constants.W_OK);
} catch {
  const who = typeof process.getuid === "function" ? `${process.getuid()}:${process.getgid?.()}` : "the container user";
  console.error(`AnimeArr can't write to ${CONFIG_DIR}. Give it to the user the container runs as (${who}), e.g. on Unraid: chown -R 99:100 /mnt/cache/appdata/animearr`);
  process.exit(1);
}

// ---------------------------------------------------------------- single writer

function pidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
function takeLock() {
  try {
    const fd = fs.openSync(LOCK, "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch {
    const other = Number(fs.readFileSync(LOCK, "utf8").trim());
    if (other && other !== process.pid && pidAlive(other)) {
      console.error(`Another AnimeArr (process ${other}) is already using ${CONFIG_DIR}. Only one may run per config folder, or the database can be damaged.`);
      process.exit(1);
    }
    fs.writeFileSync(LOCK, String(process.pid)); // stale lock left by a crash
  }
  const release = () => {
    try {
      if (fs.readFileSync(LOCK, "utf8").trim() === String(process.pid)) fs.rmSync(LOCK);
    } catch {
      /* ignore */
    }
  };
  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0));
}
if (!process.env.ANIMEARR_NO_LOCK) takeLock();

// ---------------------------------------------------------------- network/FUSE path check

/** SQLite on NFS/SMB/FUSE (e.g. Unraid's /mnt/user, which is shfs) can be corrupted by broken locking. */
function networkFs(dir: string): string | null {
  if (process.platform === "win32") return /^\\\\/.test(dir) ? "a network share (UNC path)" : null;
  try {
    const mounts = fs.readFileSync("/proc/mounts", "utf8").split("\n").map((l) => l.split(" ")).filter((p) => p.length > 2);
    let best: string[] | null = null;
    for (const m of mounts) {
      const mp = m[1].replace(/\\040/g, " ");
      if ((dir === mp || dir.startsWith(mp.endsWith("/") ? mp : `${mp}/`)) && (!best || mp.length > best[1].length)) best = m;
    }
    if (best && /^(nfs4?|cifs|smb3?|fuse\..*|fuse|9p|sshfs|shfs|virtiofs)$/.test(best[2])) return `${best[2]} (${best[1]})`;
  } catch {
    /* not Linux */
  }
  return null;
}
const nf = networkFs(CONFIG_DIR);
if (nf) {
  const msg = `The config folder ${CONFIG_DIR} is on ${nf}. SQLite databases can be damaged on network or FUSE filesystems. Move /config to a local disk (on Unraid use /mnt/cache/appdata/animearr, not /mnt/user/appdata).`;
  console.warn(`WARNING: ${msg}`);
  startupWarnings.push(msg);
}

// ---------------------------------------------------------------- open + check

function pragmas(d: DatabaseSync) {
  d.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
}

function quickCheck(d: DatabaseSync): string {
  try {
    const rows = d.prepare("PRAGMA quick_check").all() as { quick_check: string }[];
    return rows.map((r) => r.quick_check).join("; ");
  } catch (e) {
    return (e as Error).message;
  }
}

/** Set when animearr.db failed its startup check: the app runs read-only and offers a restore. */
export const dbState = { corrupt: false, detail: "" };

function openUser(): DatabaseSync {
  const exists = fs.existsSync(USER_DB);
  let d: DatabaseSync;
  try {
    d = new DatabaseSync(USER_DB);
  } catch (e) {
    dbState.corrupt = true;
    dbState.detail = (e as Error).message;
    return new DatabaseSync(":memory:", { readOnly: false });
  }
  if (exists) {
    const r = quickCheck(d);
    if (r !== "ok") {
      d.close();
      dbState.corrupt = true;
      dbState.detail = r;
      console.error(`animearr.db failed its integrity check (${r}). AnimeArr will not write to it. Restore a backup in Settings → System → Backups, or from ${BACKUP_DIR}.`);
      try {
        return new DatabaseSync(USER_DB, { readOnly: true });
      } catch {
        return new DatabaseSync(":memory:");
      }
    }
  }
  pragmas(d);
  return d;
}

function openCache(): DatabaseSync {
  const tryOpen = () => {
    const d = new DatabaseSync(CACHE_DB);
    const r = quickCheck(d);
    if (r !== "ok") {
      d.close();
      throw new Error(r);
    }
    return d;
  };
  let d: DatabaseSync;
  try {
    d = tryOpen();
  } catch (e) {
    console.warn(`cache.db was damaged (${(e as Error).message}); rebuilding it. No user data is lost.`);
    for (const f of [CACHE_DB, `${CACHE_DB}-wal`, `${CACHE_DB}-shm`]) fs.rmSync(f, { force: true });
    d = new DatabaseSync(CACHE_DB);
  }
  pragmas(d);
  return d;
}

export const db = openUser();
export const cache = openCache();

// ---------------------------------------------------------------- backups

export type BackupKind = "nightly" | "premigration" | "manual" | "prerestore";
const KEEP: Record<BackupKind, number> = { nightly: 7, premigration: 5, manual: 10, prerestore: 3 };

export function listBackups() {
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => /^animearr-(nightly|premigration|manual|prerestore)-.*\.db$/.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      return { name: f, kind: f.split("-")[1] as BackupKind, size: st.size, at: st.mtimeMs };
    })
    .sort((a, b) => b.at - a.at);
}

/** Consistent copy via VACUUM INTO (safe while the app runs). Prunes old copies of the same kind. */
export function backupNow(kind: BackupKind, label = ""): string | null {
  if (dbState.corrupt) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const name = `animearr-${kind}-${stamp}${label ? `-${label.replace(/[^\w.]/g, "")}` : ""}.db`;
  const file = path.join(BACKUP_DIR, name);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  for (const old of listBackups().filter((b) => b.kind === kind).slice(KEEP[kind])) fs.rmSync(path.join(BACKUP_DIR, old.name), { force: true });
  return name;
}

/** Replaces animearr.db with a backup. The process must restart afterwards (the caller exits). */
export function restoreBackup(name: string) {
  const b = listBackups().find((x) => x.name === name);
  if (!b) throw new Error("Unknown backup");
  const src = path.join(BACKUP_DIR, b.name);
  const check = new DatabaseSync(src, { readOnly: true });
  const r = quickCheck(check);
  check.close();
  if (r !== "ok") throw new Error(`That backup is damaged too (${r})`);
  try {
    backupNow("prerestore");
  } catch {
    /* best effort */
  }
  db.close();
  for (const f of [USER_DB, `${USER_DB}-wal`, `${USER_DB}-shm`]) fs.rmSync(f, { force: true });
  fs.copyFileSync(src, USER_DB);
}

// ---------------------------------------------------------------- migrations (transactional; backup first)

/** USER DATA schema. Never edit a released step; append. */
const USER_MIGRATIONS: string[] = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   -- User and learned aliases. key = compact normalised title. season = the TVDB season the alias implies (or null).
   CREATE TABLE aliases (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, title TEXT NOT NULL, tvdb_id INTEGER NOT NULL, season INTEGER,
     source TEXT NOT NULL CHECK (source IN ('user', 'learned')), created_at INTEGER NOT NULL, UNIQUE (key, tvdb_id, season));
   CREATE INDEX aliases_key ON aliases (key);
   -- Per-show numbering rules (optionally per release group). mode: auto | absolute | season | offset
   CREATE TABLE rules (id INTEGER PRIMARY KEY AUTOINCREMENT, tvdb_id INTEGER NOT NULL, grp TEXT, mode TEXT NOT NULL CHECK (mode IN ('auto', 'absolute', 'season', 'offset')),
     season INTEGER, offset INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
   CREATE INDEX rules_tvdb ON rules (tvdb_id);
   -- Shows AnimeArr decides and grabs for. dry_run is per show (on by default); the global switch is in settings.
   CREATE TABLE managed (tvdb_id INTEGER PRIMARY KEY, series_id INTEGER NOT NULL, title TEXT NOT NULL, dry_run INTEGER NOT NULL DEFAULT 1,
     since INTEGER NOT NULL, unmonitored_in_sonarr INTEGER NOT NULL DEFAULT 0);
   -- Facts the user confirmed (e.g. "Season 6 has burned-in English"). Used by audits and Deep Search flags.
   CREATE TABLE facts (id INTEGER PRIMARY KEY AUTOINCREMENT, tvdb_id INTEGER NOT NULL, season INTEGER, kind TEXT NOT NULL CHECK (kind IN ('burned_in', 'no_release')),
     lang TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL, UNIQUE (tvdb_id, season, kind, lang));
   -- Activity log: every decision with a human-readable "why". undo: JSON describing how to reverse it, when possible.
   CREATE TABLE decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, tvdb_id INTEGER, title TEXT NOT NULL DEFAULT '',
     episode_ids TEXT NOT NULL DEFAULT '[]', release TEXT, why TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}', undo TEXT, undone_at INTEGER);
   CREATE INDEX decisions_at ON decisions (at);
   CREATE INDEX decisions_tvdb ON decisions (tvdb_id, at);
   -- Grab pipeline state (one row per release sent, or that would have been sent in dry-run).
   CREATE TABLE grabs (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, updated_at INTEGER NOT NULL, tvdb_id INTEGER, series_id INTEGER,
     episode_ids TEXT NOT NULL, release TEXT NOT NULL, guid TEXT NOT NULL, indexer_id INTEGER, protocol TEXT NOT NULL, client TEXT, client_ref TEXT,
     state TEXT NOT NULL, dry_run INTEGER NOT NULL, origin TEXT NOT NULL DEFAULT 'manual', why TEXT NOT NULL DEFAULT '', error TEXT, candidates TEXT NOT NULL DEFAULT '[]');
   CREATE INDEX grabs_state ON grabs (state);
   CREATE TABLE blocklist (id INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT, release TEXT NOT NULL, tvdb_id INTEGER, reason TEXT NOT NULL, at INTEGER NOT NULL);
   CREATE INDEX blocklist_release ON blocklist (release);
   -- Learned subtitle/audio languages per (release group, source/service). origin: library (backfill from existing files) | verify
   CREATE TABLE group_langs (grp TEXT NOT NULL, source TEXT NOT NULL, origin TEXT NOT NULL CHECK (origin IN ('library', 'verify')),
     total INTEGER NOT NULL, subs TEXT NOT NULL DEFAULT '{}', audio TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL, PRIMARY KEY (grp, source, origin));
   -- Managed-show search schedule per episode.
   CREATE TABLE search_state (episode_id INTEGER PRIMARY KEY, tvdb_id INTEGER NOT NULL, air_utc INTEGER, next_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
     last_at INTEGER, state TEXT NOT NULL DEFAULT 'waiting', last_why TEXT NOT NULL DEFAULT '');`,
  // 2: retry/timeout bookkeeping on grabs; link a scheduled episode to its grab
  `ALTER TABLE grabs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE grabs ADD COLUMN progress REAL;
   ALTER TABLE grabs ADD COLUMN progress_at INTEGER;
   ALTER TABLE search_state ADD COLUMN grab_id INTEGER;`,
  // 3: per-show language profile / watch-mode override
  `CREATE TABLE series_prefs (tvdb_id INTEGER PRIMARY KEY, profile_id TEXT, watch_mode TEXT, updated_at INTEGER NOT NULL);`,
  // 4: after-import checks (one row per Sonarr import history entry, so each file is checked once)
  `CREATE TABLE checked_imports (history_id INTEGER PRIMARY KEY, tvdb_id INTEGER, episode_id INTEGER, release TEXT, ok INTEGER NOT NULL, action TEXT NOT NULL DEFAULT '', why TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL,
     download_id TEXT, title TEXT, label TEXT, imported_at INTEGER);
   CREATE INDEX checked_imports_at ON checked_imports (at);
   CREATE INDEX checked_imports_dl ON checked_imports (download_id);
   CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // 5: missing-episode (backlog) search: which search rows are backlog ones
  `ALTER TABLE search_state ADD COLUMN kind TEXT NOT NULL DEFAULT 'new';
   CREATE INDEX search_state_kind ON search_state (kind, state, next_at);
   CREATE INDEX search_state_tvdb ON search_state (tvdb_id, air_utc);
   CREATE TABLE backlog_searches (at INTEGER NOT NULL);
   CREATE INDEX backlog_searches_at ON backlog_searches (at);`,
  // 6: movie grabs (Radarr movie id; tvdb_id/series_id stay null for those)
  `ALTER TABLE grabs ADD COLUMN movie_id INTEGER;
   ALTER TABLE grabs ADD COLUMN replace_file INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE blocklist ADD COLUMN movie_id INTEGER;
   CREATE INDEX grabs_movie ON grabs (movie_id);`,
  // 7: dual-audio upgrades (one row per episode waiting for, or upgraded to, a dual-audio release)
  `CREATE TABLE upgrade_state (episode_id INTEGER PRIMARY KEY, tvdb_id INTEGER NOT NULL, state TEXT NOT NULL, last_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
     why TEXT NOT NULL DEFAULT '', grab_id INTEGER, release TEXT, file_id INTEGER, updated_at INTEGER NOT NULL);
   CREATE TABLE upgrade_searches (at INTEGER NOT NULL);
   ALTER TABLE grabs ADD COLUMN purpose TEXT;`,
  // 8: movies: automatic search on release / missing-movie search, per-movie watch mode, dual upgrades
  `CREATE TABLE movie_search (movie_id INTEGER PRIMARY KEY, state TEXT NOT NULL, next_at INTEGER NOT NULL, last_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
     last_why TEXT NOT NULL DEFAULT '', grab_id INTEGER, release_at INTEGER);
   CREATE INDEX movie_search_due ON movie_search (state, next_at);
   CREATE TABLE movie_searches (at INTEGER NOT NULL);
   CREATE TABLE movie_prefs (movie_id INTEGER PRIMARY KEY, profile_id TEXT, watch_mode TEXT, updated_at INTEGER NOT NULL);
   CREATE TABLE movie_upgrade (movie_id INTEGER PRIMARY KEY, state TEXT NOT NULL, last_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, why TEXT NOT NULL DEFAULT '',
     release TEXT, file_path TEXT, updated_at INTEGER NOT NULL);
   CREATE TABLE indexer_failures (indexer_id INTEGER NOT NULL, at INTEGER NOT NULL, why TEXT NOT NULL DEFAULT '');
   CREATE INDEX indexer_failures_at ON indexer_failures (indexer_id, at);
   CREATE TABLE franchise_links (tvdb_id INTEGER NOT NULL, movie_id INTEGER NOT NULL, action TEXT NOT NULL CHECK (action IN ('link', 'unlink')), at INTEGER NOT NULL, PRIMARY KEY (tvdb_id, movie_id));`,
  // 9: AnimeArr's own file records (scan + ffprobe of every library file)
  `CREATE TABLE media_files (path TEXT PRIMARY KEY, root TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL, probed_at INTEGER, duration REAL, container TEXT,
     video TEXT NOT NULL DEFAULT 'null', audio TEXT NOT NULL DEFAULT '[]', subs TEXT NOT NULL DEFAULT '[]', sidecars TEXT NOT NULL DEFAULT '[]', error TEXT, seen_at INTEGER NOT NULL);
   CREATE INDEX media_files_root ON media_files (root, seen_at);`,
  // 10: per-show monitoring scope; staged fill-in queue
  `CREATE TABLE series_scope (tvdb_id INTEGER PRIMARY KEY, seasons TEXT NOT NULL, recent_n INTEGER NOT NULL DEFAULT 1, episodes TEXT NOT NULL, specials INTEGER NOT NULL DEFAULT 0, since INTEGER NOT NULL);
   CREATE TABLE fill_queue (tvdb_id INTEGER PRIMARY KEY, position INTEGER NOT NULL, state TEXT NOT NULL, wave INTEGER, added_at INTEGER NOT NULL, activated_at INTEGER, done_at INTEGER,
     start_missing INTEGER, last_missing INTEGER, progress_at INTEGER, note TEXT NOT NULL DEFAULT '');`,
  // 11: AnimeArr's own metadata catalog (AniList-first entries, episodes, relations, franchises)
  `CREATE TABLE entries (anilist_id INTEGER PRIMARY KEY, anidb_id INTEGER, mal_id INTEGER, tvdb_id INTEGER, tvdb_season TEXT, tvdb_offset INTEGER NOT NULL DEFAULT 0,
     tmdb_tv INTEGER, tmdb_season INTEGER, tmdb_offset INTEGER NOT NULL DEFAULT 0, tmdb_movie INTEGER, kind TEXT, title_romaji TEXT, title_english TEXT, title_native TEXT,
     synonyms TEXT NOT NULL DEFAULT '[]', status TEXT, season_year INTEGER, start_date TEXT, end_date TEXT, episodes INTEGER, duration INTEGER, country TEXT, cover TEXT, banner TEXT,
     color TEXT, description TEXT, genres TEXT NOT NULL DEFAULT '[]', adult INTEGER NOT NULL DEFAULT 0, next_ep INTEGER, next_at INTEGER, franchise_id INTEGER, fetched_at INTEGER NOT NULL,
     tmdb_fetched_at INTEGER);
   CREATE INDEX entries_tvdb ON entries (tvdb_id);
   CREATE INDEX entries_anidb ON entries (anidb_id);
   CREATE INDEX entries_franchise ON entries (franchise_id);
   CREATE TABLE entry_episodes (anilist_id INTEGER NOT NULL, number INTEGER NOT NULL, title TEXT, air_utc INTEGER, source TEXT NOT NULL, PRIMARY KEY (anilist_id, number));
   CREATE TABLE entry_relations (from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, type TEXT NOT NULL, PRIMARY KEY (from_id, to_id));
   CREATE TABLE franchises (id INTEGER PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE catalog_pins (anilist_id INTEGER PRIMARY KEY, at INTEGER NOT NULL);
   CREATE TABLE catalog_missing (anilist_id INTEGER PRIMARY KEY, at INTEGER NOT NULL);`,
  // 12: per-show size preset override
  `ALTER TABLE series_prefs ADD COLUMN size_preset TEXT;`,
  // 13: native shows (added in AnimeArr, no Sonarr)
  `CREATE TABLE native_series (id INTEGER PRIMARY KEY AUTOINCREMENT, tvdb_id INTEGER NOT NULL UNIQUE, anilist_id INTEGER NOT NULL, synthetic INTEGER NOT NULL, title TEXT NOT NULL, year INTEGER,
     path TEXT NOT NULL, root_folder TEXT NOT NULL, added_at INTEGER NOT NULL);`,
  // 14: native movies
  `CREATE TABLE native_movies (id INTEGER PRIMARY KEY AUTOINCREMENT, anilist_id INTEGER NOT NULL UNIQUE, tmdb_id INTEGER, title TEXT NOT NULL, year INTEGER, path TEXT NOT NULL,
     root_folder TEXT NOT NULL, added_at INTEGER NOT NULL);`,
  // 15: which episodes a file AnimeArr imported holds (by library path)
  `CREATE TABLE file_links (path TEXT PRIMARY KEY, tvdb_id INTEGER, episode_ids TEXT NOT NULL, at INTEGER NOT NULL);`,
  // 16: release info of files AnimeArr took over from Sonarr (scene name, group, quality, revision)
  `CREATE TABLE file_meta (path TEXT PRIMARY KEY, scene_name TEXT, release_group TEXT, quality TEXT, revision TEXT);`,
  // 17: the in-app notification bell
  `CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0);`,
  // 18: user/auto matches the mappings don't have (AniList entry ↔ TVDB season / TMDB movie), and cutover confirmations
  `CREATE TABLE catalog_overrides (anilist_id INTEGER PRIMARY KEY, tvdb_id INTEGER, tvdb_season TEXT, tvdb_offset INTEGER NOT NULL DEFAULT 0, tmdb_movie INTEGER, source TEXT NOT NULL, at INTEGER NOT NULL);
   CREATE TABLE cutover_acks (tvdb_id INTEGER PRIMARY KEY, specials INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL);`,
  // 19: AniDB HTTP API cache (episodes with types/titles/lengths) and its request state (a ban survives restarts)
  `CREATE TABLE anidb_anime (aid INTEGER PRIMARY KEY, fetched_at INTEGER NOT NULL, ended INTEGER NOT NULL DEFAULT 0, type TEXT, episode_count INTEGER, missing INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE anidb_episodes (aid INTEGER NOT NULL, epno TEXT NOT NULL, type TEXT NOT NULL, number INTEGER NOT NULL, length INTEGER, airdate TEXT, title_en TEXT, title_xjat TEXT, title_ja TEXT, PRIMARY KEY (aid, epno));
   CREATE TABLE anidb_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // 20: AnimeArr owns "wanted" for movies (Radarr's monitored flag no longer counts)
  `CREATE TABLE movie_wanted (movie_id INTEGER PRIMARY KEY, wanted INTEGER NOT NULL, at INTEGER NOT NULL);`,
  // 21: the user's placement of an AniDB entry on TVDB numbering (entry + season + offset)
  `CREATE TABLE anidb_overrides (aid INTEGER PRIMARY KEY, tvdb_id INTEGER NOT NULL, season INTEGER NOT NULL, offset INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL);`,
  // 22: fixes: the notification's subject (for its buttons/links); a grab the user chose to keep despite the language check
  `ALTER TABLE notifications ADD COLUMN ctx TEXT;
   ALTER TABLE grabs ADD COLUMN keep INTEGER NOT NULL DEFAULT 0;`,
  // 23: AniDB request log (rolling budgets that survive restarts; which code path asked). The ban of 2026-10-26 gets
  // its 6 h margin and the probation after it.
  `CREATE TABLE anidb_requests (at INTEGER NOT NULL, aid INTEGER, origin TEXT);
   CREATE INDEX anidb_requests_at ON anidb_requests (at);
   UPDATE anidb_state SET value = CAST(value AS INTEGER) + 21600000 WHERE key = 'blockedUntil' AND CAST(value AS INTEGER) > 0 AND EXISTS (SELECT 1 FROM anidb_state WHERE key = 'lastError' AND value LIKE 'banned%');
   INSERT OR REPLACE INTO anidb_state (key, value) SELECT 'lastBanUntil', value FROM anidb_state WHERE key = 'blockedUntil' AND EXISTS (SELECT 1 FROM anidb_state WHERE key = 'lastError' AND value LIKE 'banned%');`,
  // 24: creditless OP/ED in the monitoring scope. Shows that already have their own scope keep what they search (0);
  // new scopes say it explicitly (the UI's default is on).
  `ALTER TABLE series_scope ADD COLUMN creditless INTEGER NOT NULL DEFAULT 0;`,
  // 25: the user's subtitle-track corrections ("this is English", "signs only"); survive rescans
  `CREATE TABLE track_overrides (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, track_index INTEGER NOT NULL, lang TEXT, forced INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL, UNIQUE(path, track_index));`,
  // 26: the per-indexer circuit breaker (3 failed downloads in a row: off for grabbing, re-tested 6 h / 12 h / daily)
  `CREATE TABLE indexer_breaker (indexer_id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', dl_streak INTEGER NOT NULL DEFAULT 0, search_streak INTEGER NOT NULL DEFAULT 0,
     state TEXT NOT NULL DEFAULT 'on', trip_kind TEXT, off_since INTEGER, next_check INTEGER, step INTEGER NOT NULL DEFAULT 0, last_error TEXT, last_kind TEXT, last_at INTEGER, updated_at INTEGER NOT NULL);`,
  // 27: shows the user dropped on purpose: never managed, grabbed, filled in or re-added
  `CREATE TABLE dropped (tvdb_id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL, why TEXT NOT NULL DEFAULT '');`,
  // 28: multi-part movies AnimeArr imported (pt1, pt2, …): Radarr doesn't track stacked parts, AnimeArr does
  `CREATE TABLE movie_parts (movie_id INTEGER PRIMARY KEY, file TEXT NOT NULL, at INTEGER NOT NULL);`,
  // 29: when each file went into AnimeArr's recycling bin (its retention counts from then, not from the file's date)
  `CREATE TABLE recycle_log (path TEXT PRIMARY KEY, at INTEGER NOT NULL, size INTEGER NOT NULL DEFAULT 0);`,
  // 30: smart batch grabs: what a batch grab downloads/imports and what it skips (JSON, see batch.ts)
  `ALTER TABLE grabs ADD COLUMN batch TEXT;`,
];

/** REBUILDABLE schema. Bumping CACHE_VERSION drops and recreates it (the next sync refills it). */
const CACHE_VERSION = 2;
const CACHE_SCHEMA = `
  CREATE TABLE meta (source TEXT PRIMARY KEY, fetched_at INTEGER, etag TEXT, last_modified TEXT, info TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE jobs (name TEXT PRIMARY KEY, state TEXT NOT NULL, detail TEXT, started_at INTEGER, finished_at INTEGER);
  CREATE TABLE series (id INTEGER PRIMARY KEY, tvdb_id INTEGER NOT NULL, tmdb_id INTEGER, imdb_id TEXT, title TEXT NOT NULL, sort_title TEXT, year INTEGER,
    status TEXT, series_type TEXT, path TEXT, root_folder TEXT, monitored INTEGER NOT NULL, quality_profile_id INTEGER, tags TEXT NOT NULL DEFAULT '[]',
    network TEXT, runtime INTEGER, original_language TEXT, seasons TEXT NOT NULL DEFAULT '[]', first_aired TEXT, next_airing TEXT, previous_airing TEXT,
    anidb_ids TEXT NOT NULL DEFAULT '[]', anidb_status TEXT NOT NULL DEFAULT 'unmatched', poster TEXT, added TEXT, sig TEXT, overview TEXT, genres TEXT NOT NULL DEFAULT '[]', synced_at INTEGER NOT NULL);
  CREATE INDEX series_tvdb ON series (tvdb_id);
  CREATE TABLE alt_titles (series_id INTEGER NOT NULL, title TEXT NOT NULL, key TEXT NOT NULL, season INTEGER, scene_season INTEGER);
  CREATE INDEX alt_titles_key ON alt_titles (key);
  CREATE TABLE episodes (id INTEGER PRIMARY KEY, series_id INTEGER NOT NULL, season INTEGER NOT NULL, episode INTEGER NOT NULL, absolute INTEGER,
    scene_season INTEGER, scene_episode INTEGER, scene_absolute INTEGER, title TEXT, air_date TEXT, air_utc INTEGER, runtime INTEGER,
    monitored INTEGER NOT NULL, has_file INTEGER NOT NULL, file_id INTEGER);
  CREATE INDEX episodes_series ON episodes (series_id, season, episode);
  CREATE TABLE files (id INTEGER PRIMARY KEY, series_id INTEGER NOT NULL, season INTEGER, path TEXT NOT NULL, size INTEGER, quality TEXT, source TEXT,
    release_group TEXT, scene_name TEXT, audio_langs TEXT NOT NULL DEFAULT '', sub_langs TEXT NOT NULL DEFAULT '', run_time TEXT, resolution TEXT, date_added TEXT);
  CREATE INDEX files_series ON files (series_id);
  CREATE TABLE movies (id INTEGER PRIMARY KEY, tmdb_id INTEGER, imdb_id TEXT, title TEXT NOT NULL, original_title TEXT, year INTEGER, path TEXT,
    root_folder TEXT, monitored INTEGER NOT NULL, has_file INTEGER NOT NULL, runtime INTEGER, quality_profile_id INTEGER, tags TEXT NOT NULL DEFAULT '[]',
    alt_titles TEXT NOT NULL DEFAULT '[]', file TEXT, is_anime INTEGER NOT NULL DEFAULT 0, poster TEXT, synced_at INTEGER NOT NULL,
    status TEXT, is_available INTEGER NOT NULL DEFAULT 0, in_cinemas INTEGER, digital_release INTEGER, physical_release INTEGER, genres TEXT NOT NULL DEFAULT '[]');
  -- AniList art per AniDB entry (via the Fribb mapping), for poster-forward lists.
  CREATE TABLE covers (anidb_id INTEGER PRIMARY KEY, anilist_id INTEGER, cover TEXT, banner TEXT, color TEXT, fetched_at INTEGER NOT NULL);
`;

function migrateUser() {
  if (dbState.corrupt) return;
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (current >= USER_MIGRATIONS.length) return;
  if (current > 0) backupNow("premigration", `v${current}`);
  for (let v = current; v < USER_MIGRATIONS.length; v++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(USER_MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

function migrateCache() {
  const v = (cache.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (v === CACHE_VERSION) {
    // Added columns that don't need a rebuild (movies added in AnimeArr live in this table too).
    const cols = (cache.prepare("PRAGMA table_info(movies)").all() as { name: string }[]).map((c) => c.name);
    if (cols.length && !cols.includes("genres")) cache.exec("ALTER TABLE movies ADD COLUMN genres TEXT NOT NULL DEFAULT '[]'");
    return;
  }
  const tables = (cache.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name);
  cache.exec("BEGIN IMMEDIATE");
  try {
    for (const t of tables) cache.exec(`DROP TABLE IF EXISTS "${t}"`);
    cache.exec(CACHE_SCHEMA);
    cache.exec(`PRAGMA user_version = ${CACHE_VERSION}`);
    cache.exec("COMMIT");
  } catch (e) {
    cache.exec("ROLLBACK");
    throw e;
  }
}

migrateUser();
migrateCache();
// Additive cache columns (no version bump, so the cache — covers included — isn't wiped).
{
  const cols = new Set((cache.prepare("PRAGMA table_info(movies)").all() as { name: string }[]).map((c) => c.name));
  for (const [c, type] of [["status", "TEXT"], ["is_available", "INTEGER NOT NULL DEFAULT 0"], ["in_cinemas", "INTEGER"], ["digital_release", "INTEGER"], ["physical_release", "INTEGER"]] as const)
    if (!cols.has(c)) cache.exec(`ALTER TABLE movies ADD COLUMN ${c} ${type}`);
  const scols = new Set((cache.prepare("PRAGMA table_info(series)").all() as { name: string }[]).map((c) => c.name));
  // Sonarr's "Season folder" flag per show (null until the next sync; the importer then infers it from the files).
  if (!scols.has("season_folder")) cache.exec("ALTER TABLE series ADD COLUMN season_folder INTEGER");
  // The file's quality revision from Sonarr (JSON {version, real, isRepack}; null until the show's next sync).
  const fcols = new Set((cache.prepare("PRAGMA table_info(files)").all() as { name: string }[]).map((c) => c.name));
  if (!fcols.has("revision")) cache.exec("ALTER TABLE files ADD COLUMN revision TEXT");
}

/** Runs fn in one write transaction on the given database. */
export function tx<T>(d: { exec(sql: string): void }, fn: () => T): T {
  d.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    d.exec("COMMIT");
    return r;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

/** Drops all rebuildable data (Settings → System → "Rebuild cache"). */
export function resetCache() {
  cache.exec("PRAGMA user_version = 0");
  migrateCache();
}

// ---------------------------------------------------------------- job status + fetch metadata (cache)

export function setJob(name: string, state: "running" | "done" | "error", detail = "") {
  const now = Date.now();
  cache
    .prepare(
      `INSERT INTO jobs (name, state, detail, started_at, finished_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET state = excluded.state, detail = excluded.detail,
         started_at = CASE WHEN excluded.state = 'running' THEN excluded.started_at ELSE jobs.started_at END,
         finished_at = excluded.finished_at`,
    )
    .run(name, state, detail, now, state === "running" ? null : now);
}

export function listJobs() {
  return cache.prepare("SELECT name, state, detail, started_at AS startedAt, finished_at AS finishedAt FROM jobs ORDER BY name").all();
}

export function getMeta(source: string) {
  return cache.prepare("SELECT source, fetched_at AS fetchedAt, etag, last_modified AS lastModified, info FROM meta WHERE source = ?").get(source) as
    | { source: string; fetchedAt: number | null; etag: string | null; lastModified: string | null; info: string }
    | undefined;
}
export function setMeta(source: string, m: { fetchedAt: number; etag?: string | null; lastModified?: string | null; info?: unknown }) {
  cache
    .prepare(
      `INSERT INTO meta (source, fetched_at, etag, last_modified, info) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET fetched_at = excluded.fetched_at, etag = excluded.etag, last_modified = excluded.last_modified, info = excluded.info`,
    )
    .run(source, m.fetchedAt, m.etag ?? null, m.lastModified ?? null, JSON.stringify(m.info ?? {}));
}
