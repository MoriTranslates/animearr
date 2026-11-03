/**
 * Backup download / upload. A downloaded backup is one .tar.gz holding manifest.json, animearr.db (a consistent
 * VACUUM INTO copy, never the live file) and secret.key (the key that unlocks every saved password: the file is
 * as sensitive as the config folder). Uploading one validates it, keeps a safety copy of the current state, swaps it
 * in and leaves the restart to the caller (same as restoring one of the nightly backups).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import {
  BACKUP_DIR,
  backupNow,
  CONFIG_DIR,
  db,
  dbState,
  listBackups,
  pruneBackups,
  quickCheck,
  restoreStopped,
  USER_DB,
  userSchemaVersion,
} from "./db.js";
import { KEY_FILE, open } from "./secretbox.js";
import { VERSION } from "./version.js";

export const BACKUP_FORMAT = "animearr-backup";
export const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
const DB_NAME = "animearr.db";
const KEY_NAME = "secret.key";

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: 1;
  appVersion: string;
  schema: number;
  createdAt: string;
  files: Record<string, { size: number; sha256: string }>;
}
export interface ParsedBackup {
  manifest: BackupManifest;
  db: Buffer;
  key: Buffer;
}

const refuse = (msg: string) => Object.assign(new Error(msg), { statusCode: 400 });
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
const keyHex = (k: Buffer) => k.toString("utf8").trim();
const validKey = (k: Buffer) => /^[0-9a-f]{64}$/i.test(keyHex(k));
const settingsRow = (d: DatabaseSync) =>
  (d.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as { value: string } | undefined)?.value;
/** True when `key` opens the sealed settings row (the only data secret.key protects). */
function unlocks(row: string, key: Buffer) {
  try {
    JSON.parse(open(row, Buffer.from(keyHex(key), "hex")));
    return true;
  } catch {
    // A failed decrypt (or JSON parse) is the answer itself: this key doesn't fit. Nothing is lost by dropping it.
    return false;
  }
}

// ---------------------------------------------------------------- a minimal tar (regular files only)

export function tarPack(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    const h = Buffer.alloc(512);
    h.write(f.name, 0, 100, "utf8");
    h.write("0000644\0", 100); // mode
    h.write("0000000\0", 108); // uid
    h.write("0000000\0", 116); // gid
    h.write(`${f.data.length.toString(8).padStart(11, "0")}\0`, 124);
    h.write(
      `${Math.floor(Date.now() / 1000)
        .toString(8)
        .padStart(11, "0")}\0`,
      136,
    );
    h.write("        ", 148); // checksum placeholder (spaces)
    h.write("0", 156); // regular file
    h.write("ustar\0" + "00", 257);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    parts.push(h, f.data, Buffer.alloc((512 - (f.data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** Reads the regular files of a tar (names are only ever used as map keys, never as paths). */
export function tarUnpack(tar: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (let off = 0; off + 512 <= tar.length;) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = parseInt(h.subarray(124, 135).toString("ascii").replace(/\0.*$/, "").trim() || "0", 8);
    const want = parseInt(h.subarray(148, 154).toString("ascii"), 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (!Number.isFinite(size) || size < 0 || sum !== want) throw refuse("That file is damaged (bad archive)");
    const start = off + 512;
    if (start + size > tar.length) throw refuse("That file is damaged (cut short)");
    if (h[156] === 0x30 || h[156] === 0) out.set(name, Buffer.from(tar.subarray(start, start + size)));
    off = start + Math.ceil(size / 512) * 512;
    if (out.size > 16) throw refuse("That file has too many parts to be an AnimeArr backup");
  }
  return out;
}

// ---------------------------------------------------------------- download

/** A fresh backup as bytes: the database via VACUUM INTO (consistent while the app runs), the key, a manifest. */
export async function createBackup(): Promise<{ name: string; data: Buffer }> {
  if (dbState.corrupt)
    throw Object.assign(new Error("The database failed its integrity check, so it can't be exported. Restore a backup first."), {
      statusCode: 409,
    });
  const tmp = path.join(BACKUP_DIR, `.export-${crypto.randomBytes(4).toString("hex")}.tmp`);
  let dbBytes: Buffer;
  try {
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    dbBytes = await fs.promises.readFile(tmp);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const key = Buffer.from(fs.readFileSync(KEY_FILE, "utf8").trim());
  const schema = userSchemaVersion();
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    formatVersion: 1,
    appVersion: VERSION,
    schema,
    createdAt: new Date().toISOString(),
    files: { [DB_NAME]: { size: dbBytes.length, sha256: sha(dbBytes) }, [KEY_NAME]: { size: key.length, sha256: sha(key) } },
  };
  const tar = tarPack([
    { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2)) },
    { name: DB_NAME, data: dbBytes },
    { name: KEY_NAME, data: key },
  ]);
  return { name: `animearr-backup-${manifest.createdAt.replace(/[:.]/g, "-").slice(0, 19)}.tar.gz`, data: await gzip(tar) }; // off the event loop: a big library's backup takes a moment
}

// ---------------------------------------------------------------- upload: validate

/** Checks an uploaded file is a whole, readable AnimeArr backup this version can take. Throws a plain-words 400. */
export async function parseBackup(data: Buffer, schemaNow = userSchemaVersion()): Promise<ParsedBackup> {
  let files: Map<string, Buffer>;
  try {
    files = tarUnpack(await gunzip(data, { maxOutputLength: MAX_BACKUP_BYTES * 2 }));
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode) throw e;
    throw refuse("That isn't an AnimeArr backup file (use one from Settings → System → Download backup)");
  }
  let m: BackupManifest;
  try {
    m = JSON.parse(files.get("manifest.json")?.toString("utf8") ?? "") as BackupManifest;
  } catch {
    throw refuse("That isn't an AnimeArr backup file (no manifest inside)");
  }
  if (m?.format !== BACKUP_FORMAT || m.formatVersion !== 1)
    throw refuse("That isn't an AnimeArr backup file, or it comes from a newer backup format");
  if (!Number.isInteger(m.schema) || m.schema < 1) throw refuse("That backup's manifest is damaged");
  if (m.schema > schemaNow)
    throw refuse(
      `That backup is from a newer AnimeArr (database version ${m.schema}, this one understands up to ${schemaNow}). Update AnimeArr first, then restore it.`,
    );
  const dbBytes = files.get(DB_NAME);
  const key = files.get(KEY_NAME);
  if (!dbBytes || !key) throw refuse("That backup is missing its database or its secret key");
  for (const [name, b] of [
    [DB_NAME, dbBytes],
    [KEY_NAME, key],
  ] as const) {
    const f = m.files?.[name];
    if (!f || f.size !== b.length || f.sha256 !== sha(b)) throw refuse(`That backup is damaged (${name} doesn't match its checksum)`);
  }
  if (!validKey(key)) throw refuse("That backup's secret key isn't valid");
  // The database itself: opens, passes its integrity check, has the schema the manifest says, and its settings open with the key.
  const tmp = path.join(BACKUP_DIR, `.check-${crypto.randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, dbBytes);
  try {
    const d = new DatabaseSync(tmp, { readOnly: true });
    try {
      const r = quickCheck(d);
      if (r !== "ok") throw refuse(`That backup's database is damaged (${r})`);
      const v = (d.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (v !== m.schema) throw refuse("That backup's database doesn't match its manifest");
      const row = settingsRow(d);
      if (row !== undefined && !unlocks(row, key)) throw refuse("That backup's secret key doesn't unlock its settings");
    } finally {
      d.close();
    }
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode) throw e;
    throw refuse("That backup's database can't be read");
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return { manifest: m, db: dbBytes, key };
}

// ---------------------------------------------------------------- upload: apply

export interface ApplyPaths {
  db: string;
  key: string;
}
export interface ApplyHooks {
  /** Saves the current state first; throwing aborts before anything is touched. May return the copy's name for messages. */
  safety: () => string | void;
  /**
   * Removes the copy `safety` made, called only when the attempt fails before the swap began (nothing live touched, so
   * that copy duplicates what is still in place). Returns what it couldn't remove. Never called once the swap began.
   */
  discardSafety?: () => string[];
  /** Runs once the copies are written and checked, before the live database is closed; throwing changes nothing. */
  beforeSwap: () => void;
  /** Releases the live database before its file is replaced. */
  closeDb: () => void;
  /** Names the backup in messages (default "that backup"). */
  what?: string;
  /** How to retry once the app is back, for a restore that stopped after the close (default: the upload's wording). */
  retry?: string;
}

/**
 * Safety copy + swap. The caller restarts the process afterwards. A failure before `closeDb` changes nothing (plain
 * error, a retry is fine). A failure after it is a restoreStopped (blind review round 4, M1): the swap is rolled back so
 * the folder holds a matching database and key, and the message says which; the caller must restart, never retry.
 * The key goes first: it is a few bytes kept in memory, so undoing it needs no second copy of the database, while the
 * database rename is the last step and either lands (restore done) or leaves the old database whole.
 */
export function applyBackup(b: Pick<ParsedBackup, "db" | "key">, paths: ApplyPaths, hooks: ApplyHooks) {
  const what = hooks.what ?? "that backup";
  const safetyName = hooks.safety();
  const tmpDb = `${paths.db}.restore-tmp`;
  const tmpKey = `${paths.key}.restore-tmp`;
  let oldKey: Buffer;
  try {
    oldKey = fs.readFileSync(paths.key);
    fs.writeFileSync(tmpDb, b.db);
    fs.writeFileSync(tmpKey, b.key.toString("utf8").trim(), { mode: 0o600 });
    // Checked where it landed (a full disk can leave a short file without an error on some filesystems).
    const d = new DatabaseSync(tmpDb, { readOnly: true });
    const r = quickCheck(d);
    d.close();
    if (r !== "ok") throw new Error(`the copy failed its check (${r})`);
    hooks.beforeSwap();
  } catch (e) {
    const left = hooks.discardSafety?.() ?? []; // before the swap: the live files are untouched (blind review round 9, H2)
    for (const f of [tmpDb, tmpKey]) fs.rmSync(f, { force: true });
    throw Object.assign(
      new Error(
        `Couldn't restore ${what}: ${(e as Error).message}; nothing was changed${
          left.length ? `. Leftover safety copy files that are safe to delete: ${left.join(", ")}` : ""
        }`,
        { cause: e },
      ),
      { statusCode: 500 },
    );
  }
  let keySwapped = false;
  try {
    hooks.closeDb();
    // The rename replaces the live file in one step; deleting it first would only open a window with no database.
    for (const f of [`${paths.db}-wal`, `${paths.db}-shm`]) fs.rmSync(f, { force: true });
    fs.renameSync(tmpKey, paths.key);
    keySwapped = true;
    fs.renameSync(tmpDb, paths.db);
  } catch (e) {
    throw rollBackSwap(e, {
      paths,
      tmpDb,
      tmpKey,
      oldKey,
      keySwapped,
      safetyName,
      what,
      retry: hooks.retry ?? "The uploaded file is not kept; choose it again to retry once AnimeArr is back.",
    });
  }
}

/** After a failure past closeDb: puts the old key back if it was replaced, and says exactly what the folder holds. */
function rollBackSwap(
  e: unknown,
  s: {
    paths: ApplyPaths;
    tmpDb: string;
    tmpKey: string;
    oldKey: Buffer;
    keySwapped: boolean;
    safetyName: string | void;
    what: string;
    retry: string;
  },
) {
  const why = (e as Error).message;
  const leftovers: string[] = [];
  for (const f of [s.tmpDb, s.tmpKey])
    try {
      fs.rmSync(f, { force: true });
    } catch (re) {
      leftovers.push(`${path.basename(f)} (${(re as Error).message})`);
    }
  const extra = `${leftovers.length ? ` Leftover temporary files that are safe to delete: ${leftovers.join(", ")}.` : ""}${
    s.safetyName ? ` A safety copy of what was here before is in the backups folder: ${s.safetyName}.` : ""
  }`;
  const restarting =
    "AnimeArr is restarting to reopen it; reload the page in a few seconds (start it again yourself if it isn't running in Docker) and log in again.";
  let keyBack = !s.keySwapped;
  let keyErr = "";
  if (s.keySwapped) {
    // Put the old key back: a temp file renamed over it, or, if that rename is what keeps failing, written in place.
    const back = `${s.paths.key}.rollback-tmp`;
    try {
      fs.writeFileSync(back, s.oldKey, { mode: 0o600 });
      fs.renameSync(back, s.paths.key);
      keyBack = true;
    } catch (re1) {
      try {
        fs.rmSync(back, { force: true });
        fs.writeFileSync(s.paths.key, s.oldKey, { mode: 0o600 });
        keyBack = fs.readFileSync(s.paths.key).equals(s.oldKey);
        if (!keyBack) keyErr = "it read back different";
      } catch (re2) {
        keyErr = `${(re1 as Error).message}; then ${(re2 as Error).message}`;
      }
    }
  }
  if (keyBack)
    return restoreStopped(
      `Couldn't restore ${s.what}: ${why}. The restore stopped after the database was closed and was undone: your previous database and its key are in place, nothing from the backup was applied. ${restarting} ${s.retry}${extra}`,
      e,
    );
  return restoreStopped(
    `Couldn't restore ${s.what}: ${why}. The restore stopped halfway: the backup's secret.key is in place but your previous database is still there, and the previous key couldn't be put back (${keyErr}). AnimeArr will not start like this. Before starting it again, copy the safety copy's .secret.key file named below from the backups folder over secret.key in the config folder (your database was not replaced, so that key matches it).${extra} AnimeArr is stopping now.`,
    e,
  );
}

/** The safety copy couldn't be made; nothing live was touched. A plain retry fails the same way until its cause is fixed. */
export const safetyCopyFailed = (e: unknown) => (e as { safetyCopyFailed?: unknown } | null)?.safetyCopyFailed === true;

/** Copies `from` into the backups folder as `name`, never over an existing file, and checks the copy's size. */
function copyIntoBackups(from: string, name: string, made: string[]) {
  const to = path.join(BACKUP_DIR, name);
  if (fs.existsSync(to)) throw new Error(`${name} already exists`);
  made.push(name); // from here a partial copy is ours to remove
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  if (fs.statSync(to).size !== fs.statSync(from).size) throw new Error(`the copy of ${path.basename(from)} came out short`);
}

const MB = 1024 * 1024;
const MIN_MARGIN_BYTES = 64 * MB;

/** Free bytes in `dir`'s filesystem, or null when that can't be measured (statfs unsupported or giving nonsense). */
function freeBytes(dir: string): number | null {
  let s: fs.StatsFs;
  try {
    s = fs.statfsSync(dir);
  } catch (e) {
    console.warn(`Couldn't measure free space in ${dir} (${(e as Error).message}); restoring without that check.`);
    return null;
  }
  const bavail = Number(s.bavail);
  const bsize = Number(s.bsize);
  if (!Number.isFinite(bavail) || bavail < 0 || !Number.isFinite(bsize) || bsize <= 0) {
    console.warn(
      `Free space in ${dir} reads as nonsense (bavail ${String(s.bavail)}, bsize ${String(s.bsize)}); restoring without that check.`,
    );
    return null;
  }
  // Some FUSE / network mounts report zeros without erroring: blocks=0, or bavail=0 while bfree>0. That is "unknown", not "full".
  // A genuinely full disk has blocks>0 and both bavail and bfree at 0. Fields that are absent (NaN) don't trigger this.
  const blocks = Number(s.blocks);
  const bfree = Number(s.bfree);
  if (blocks === 0 || (bavail === 0 && bfree > 0)) {
    console.warn(
      `Free space in ${dir} reads as zero without being full (blocks ${String(s.blocks)}, bavail ${String(s.bavail)}, bfree ${String(s.bfree)}); restoring without that check.`,
    );
    return null;
  }
  return bavail * bsize;
}

/** The filesystem `dir` is on, so folders sharing one disk are checked against their combined need. */
function deviceOf(dir: string): string {
  try {
    return `dev:${fs.statSync(dir).dev}`;
  } catch {
    // Unknown device: the folder is checked on its own need only. A missing folder fails the write that follows anyway.
    return `dir:${dir}`;
  }
}

/**
 * Refuses, before anything is written or changed, when a folder the restore writes to lacks room (blind review round 9,
 * M1): BACKUP_DIR takes the safety copy (database, wal, key), CONFIG_DIR takes the restore's temp database and key
 * (`incoming` bytes, when known). Folders on one filesystem are checked against their combined need, plus a margin of
 * 64 MB or 10% of the database, whichever is larger. A folder whose free space can't be measured is skipped (M2):
 * "couldn't check" is not "no room", and a write to a disk that really is full fails safely on its own.
 * Never deletes anything, and there is no cap on how many copies may exist (H1).
 */
function checkSafetyRoom(incoming: number) {
  const size = (f: string) => (fs.existsSync(f) ? fs.statSync(f).size : 0);
  const dbBytes = size(USER_DB) + size(`${USER_DB}-wal`);
  const keyBytes = size(KEY_FILE);
  const targets = [
    { dir: BACKUP_DIR, need: dbBytes + keyBytes },
    { dir: CONFIG_DIR, need: incoming + keyBytes },
  ];
  const margin = Math.max(MIN_MARGIN_BYTES, Math.ceil(dbBytes / 10));
  const devs = targets.map((t) => deviceOf(t.dir));
  for (const [i, t] of targets.entries()) {
    const need = margin + targets.reduce((sum, o, j) => sum + (devs[j] === devs[i] ? o.need : 0), 0);
    const free = freeBytes(t.dir);
    if (free !== null && free < need)
      throw new Error(
        `not enough free disk space in ${t.dir}: about ${Math.ceil(need / MB)} MB is needed for the safety copy and the restore but only ${Math.floor(free / MB)} MB is free`,
      );
  }
}

/**
 * Removes the safety copy a restore attempt just made, for a failure BEFORE the swap began (blind review round 9, H2):
 * the live database and key were never touched, so that copy only duplicates them and nothing is lost. Only the names
 * this attempt wrote are touched, never any other copy. Returns what couldn't be removed, for the error message.
 */
function discardSafetyCopy(made: readonly string[]): string[] {
  const left: string[] = [];
  for (const f of made)
    try {
      fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
    } catch (e) {
      left.push(`${f} (${(e as Error).message})`);
    }
  return left;
}

/** The safety hooks for one restore attempt: make the copy, and discard exactly that copy if the attempt fails pre-swap. */
function safetyHooks(label: string, incoming: number): Pick<ApplyHooks, "safety" | "discardSafety"> {
  let made: string[] = [];
  return {
    safety: () => {
      made = writeSafetyCopy(label, incoming);
      return made.join(", ");
    },
    discardSafety: () => {
      const left = discardSafetyCopy(made);
      made = [];
      return left;
    },
  };
}

/**
 * The safety copy before a restore: the database plus the current key, which that copy can't be opened without. Both
 * are saved under one name (`<name>.db` and `<name>.secret.key`) so restoring the copy later finds its key (blind review
 * round 5, M2). A healthy database is copied with VACUUM INTO. One flagged corrupt can't be, and that is exactly when a
 * restore is needed (round 5, M1): its raw files are copied byte for byte as animearr-damaged-*, kept out of the restore
 * list (they would fail its check) and never pruned. If the copy can't be made, what it wrote is removed and a
 * safetyCopyFailed error is thrown; nothing live has been touched. Returns the file names, for messages. `incoming` is
 * the size of the database about to be restored, when known, for the free-space check.
 */
export function safetyBackup(label: string, incoming = 0): string {
  return writeSafetyCopy(label, incoming).join(", ");
}

/** safetyBackup, returning the names of the files it wrote. */
function writeSafetyCopy(label: string, incoming: number): string[] {
  const made: string[] = [];
  let keyName: string;
  try {
    checkSafetyRoom(incoming);
    let base: string;
    if (!dbState.corrupt) {
      const dbName = backupNow("prerestore", label, false); // pruned only after a restore succeeds (pruneSafetyCopies)
      if (!dbName) throw new Error("the database was flagged damaged while it was being copied"); // backupNow's only null
      made.push(dbName);
      base = dbName.replace(/\.db$/, "");
    } else {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      base = `animearr-damaged-${stamp}${label ? `-${label}` : ""}`;
      // The -shm index is rebuilt from these two, so it isn't kept. A missing database file (it couldn't be opened at
      // all) has nothing to keep.
      for (const [from, ext] of [
        [USER_DB, ".db"],
        [`${USER_DB}-wal`, ".db-wal"],
      ])
        if (fs.existsSync(from)) copyIntoBackups(from, `${base}${ext}`, made);
    }
    keyName = `${base}.secret.key`;
    copyIntoBackups(KEY_FILE, keyName, made);
    if (!fs.readFileSync(path.join(BACKUP_DIR, keyName)).equals(fs.readFileSync(KEY_FILE)))
      throw new Error(`${keyName} read back different from secret.key`);
  } catch (e) {
    const leftovers: string[] = [];
    for (const f of made)
      try {
        fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
      } catch (re) {
        leftovers.push(`${f} (${(re as Error).message})`);
      }
    throw Object.assign(
      new Error(
        `Couldn't save a safety copy of the ${dbState.corrupt ? "damaged" : "current"} database and its key (${(e as Error).message}), so nothing was changed${
          leftovers.length ? `. Leftover partial copies that are safe to delete: ${leftovers.join(", ")}` : ""
        }`,
        { cause: e },
      ),
      { statusCode: 500, safetyCopyFailed: true as const },
    );
  }
  // Nothing is pruned here: this runs before the restore, which may still fail (see pruneSafetyCopies).
  return made;
}

/**
 * Prunes the safety copies beyond the newest three, and their saved keys, but never `keep` (the backup just restored)
 * or its key. Called only once a restore has succeeded (blind review round 7, M1): pruned before, a restore of the
 * oldest copy that then failed had already deleted that copy and its only key, so the retry got "Unknown backup".
 * Pruning is housekeeping, not a safety step: the restore has already succeeded and nothing depends on the deletes, so
 * an error is logged and never fails or aborts it (L1). The cost is a few extra copies, pruned after the next restore.
 */
export function pruneSafetyCopies(keep?: string) {
  try {
    pruneBackups("prerestore", keep);
    pruneSafetyKeys(keep);
  } catch (e) {
    console.warn(`Pruning old safety copies failed (${(e as Error).message}); they are kept until the next restore.`);
  }
}

/**
 * Prunes saved safety keys beyond the newest three, but never one a backup still on disk may need (blind review round
 * 6, M): a nightly, manual or premigration backup sealed with an older key can only be restored while that key exists.
 * An older key goes only when it is a byte copy of one of the newest three, or when every listed backup was read and
 * none is opened by it. If any backup can't be read, or a key can't be, it is kept: "couldn't check" never means "not
 * needed". Keys are tiny, so keeping extra ones costs nothing.
 */
function pruneSafetyKeys(keep?: string) {
  const keepKey = keep?.replace(/\.db$/, ".secret.key");
  const read = (f: string) => {
    try {
      return fs.readFileSync(path.join(BACKUP_DIR, f));
    } catch {
      // Unreadable: it can't be judged, so the caller keeps it. Nothing is deleted on this path.
      return null;
    }
  };
  const keys = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => /^animearr-prerestore-.*\.secret\.key$/.test(f))
    .sort()
    .reverse();
  if (keys.length <= 3) return;
  const newest = keys.slice(0, 3).map(read);
  let sealed: string[] | null = [];
  for (const b of listBackups()) {
    try {
      const d = new DatabaseSync(path.join(BACKUP_DIR, b.name), { readOnly: true });
      try {
        const row = settingsRow(d);
        if (row !== undefined) sealed.push(row);
      } finally {
        d.close();
      }
    } catch {
      // Which key this backup needs is unknown, so only byte copies of the newest keys may go (sealed = null).
      sealed = null;
      break;
    }
  }
  for (const f of keys.slice(3)) {
    if (f === keepKey) continue;
    const k = read(f);
    if (!k) continue;
    const copyOfNewest = newest.some((x) => x !== null && x.equals(k));
    if (copyOfNewest || (sealed !== null && !sealed.some((r) => unlocks(r, k)))) fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
  }
}

/** Saved keys to try for a backup, in order: the one saved under its own name, the live key, then every other one. */
function keyCandidates(name: string, liveKey: Buffer): Buffer[] {
  const own = name.replace(/\.db$/, ".secret.key");
  const read = (f: string) => {
    try {
      return fs.readFileSync(path.join(BACKUP_DIR, f));
    } catch {
      // A saved key that can't be read just isn't a candidate; if no candidate fits, the refusal says what to do.
      return null;
    }
  };
  const others = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith(".secret.key") && f !== own)
    .sort()
    .reverse();
  return [read(own), liveKey, ...others.map(read)].filter((k): k is Buffer => k !== null && validKey(k));
}

/**
 * Restores one of the backups in the backups folder by name. The process must restart afterwards (the caller exits).
 * A database is useless without the secret.key that sealed its settings: swapping in one the live key can't open made
 * the app crash-loop on its next start (blind review round 5, M2). So the key is chosen while everything is still open:
 * the key saved under the backup's own name (safety copies have one), else the live key, else any other saved key,
 * whichever provably opens the backup's settings. If none does, the restore is refused and nothing is touched. The
 * database and that key then go in together through applyBackup, the same key-first swap with rollback an uploaded
 * backup uses. `beforeSwap` is required (blind review round 3, L1): the routes pass the session floor.
 */
export function restoreBackup(name: string, beforeSwap: () => void) {
  const b = listBackups().find((x) => x.name === name);
  if (!b) throw new Error("Unknown backup");
  const src = path.join(BACKUP_DIR, b.name);
  const liveKey = fs.readFileSync(KEY_FILE);
  let key: Buffer | undefined;
  let bytes: Buffer;
  const check = new DatabaseSync(src, { readOnly: true });
  try {
    const r = quickCheck(check);
    if (r !== "ok") throw new Error(`That backup is damaged too (${r})`);
    const row = settingsRow(check);
    // No settings row: nothing in it is sealed, so the live key opens it as well as any.
    key = row === undefined ? liveKey : keyCandidates(b.name, liveKey).find((k) => unlocks(row, k));
    bytes = fs.readFileSync(src); // read while it is open and checked
  } finally {
    check.close();
  }
  if (!key)
    throw Object.assign(
      new Error(
        `Nothing was changed: ${name} can't be restored with the secret.key in use. Its saved passwords are locked with another key, and no key in the backups folder opens them, so restoring it would leave AnimeArr unable to start. If you still have the secret.key from when it was made, put it in the backups folder as ${name.replace(/\.db$/, ".secret.key")}, then restore it again.`,
      ),
      { statusCode: 409 },
    );
  applyBackup(
    { db: bytes, key },
    { db: USER_DB, key: KEY_FILE },
    {
      ...safetyHooks("", bytes.length),
      beforeSwap,
      closeDb: () => db.close(),
      what: name,
      retry: "Then retry the restore.",
    },
  );
  pruneSafetyCopies(name); // the swap has committed
}

/**
 * Restores an uploaded backup into the live config folder. `beforeSwap` runs once the copies are written and checked,
 * right before the live files are replaced; if it throws, the copies are removed and nothing is changed. `beforeSwap` is
 * required (blind review round 3, L1): the routes pass the session floor, and a do-nothing default would let a caller
 * drop that protection silently. A failure once the database is closed is a restoreStopped (see applyBackup).
 */
export function restoreUploaded(b: ParsedBackup, beforeSwap: () => void) {
  applyBackup(b, { db: USER_DB, key: KEY_FILE }, { ...safetyHooks("upload", b.db.length), beforeSwap, closeDb: () => db.close() });
  pruneSafetyCopies(); // the swap has committed
}

// ---------------------------------------------------------------- staging between "upload" and "confirm with password"

let staged: { token: string; backup: ParsedBackup; at: number } | null = null;
export function stageBackup(b: ParsedBackup) {
  staged = { token: crypto.randomBytes(16).toString("hex"), backup: b, at: Date.now() };
  return staged.token;
}
/**
 * The staged upload for this token, left staged: it is dropped only once the restore succeeded (dropStaged), so a
 * restore that fails (say, a full disk while the session floor is written) can be retried without uploading the file
 * again (blind review round 3, L5).
 */
export function peekStaged(token: string): ParsedBackup {
  if (!staged || staged.token !== token || Date.now() - staged.at > 10 * 60_000) throw refuse("That upload expired, choose the file again");
  return staged.backup;
}
export function dropStaged(token: string) {
  if (staged?.token === token) staged = null;
}
