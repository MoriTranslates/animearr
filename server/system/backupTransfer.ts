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
import { BACKUP_DIR, backupNow, db, dbState, quickCheck, USER_DB, userSchemaVersion } from "./db.js";
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
  if (!/^[0-9a-f]{64}$/i.test(key.toString("utf8").trim())) throw refuse("That backup's secret key isn't valid");
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
      const row = d.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as { value: string } | undefined;
      if (row) {
        try {
          JSON.parse(open(row.value, Buffer.from(key.toString("utf8").trim(), "hex")));
        } catch {
          throw refuse("That backup's secret key doesn't unlock its settings");
        }
      }
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
  /** Saves the current state first; throwing aborts before anything is touched. */
  safety: () => void;
  /** Releases the live database before its file is replaced. */
  closeDb: () => void;
}

/** Safety copy + swap. The caller restarts the process afterwards. */
export function applyBackup(b: ParsedBackup, paths: ApplyPaths, hooks: ApplyHooks) {
  hooks.safety();
  const tmpDb = `${paths.db}.restore-tmp`;
  const tmpKey = `${paths.key}.restore-tmp`;
  try {
    fs.writeFileSync(tmpDb, b.db);
    fs.writeFileSync(tmpKey, b.key.toString("utf8").trim(), { mode: 0o600 });
    // Checked where it landed (a full disk can leave a short file without an error on some filesystems).
    const d = new DatabaseSync(tmpDb, { readOnly: true });
    const r = quickCheck(d);
    d.close();
    if (r !== "ok") throw new Error(`the copy failed its check (${r})`);
  } catch (e) {
    for (const f of [tmpDb, tmpKey]) fs.rmSync(f, { force: true });
    throw Object.assign(new Error(`Couldn't restore that backup: ${(e as Error).message}; nothing was changed`, { cause: e }), {
      statusCode: 500,
    });
  }
  hooks.closeDb();
  // The rename replaces the live file in one step; deleting it first would only open a window with no database.
  for (const f of [`${paths.db}-wal`, `${paths.db}-shm`]) fs.rmSync(f, { force: true });
  fs.renameSync(tmpDb, paths.db);
  fs.renameSync(tmpKey, paths.key);
}

/** The safety copy before a restore: the database (VACUUM INTO) plus the current key, which that copy can't be opened without. */
export function safetyBackup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  if (!backupNow("prerestore", "upload")) throw new Error("Couldn't save a safety copy of the current data, so nothing was changed");
  fs.copyFileSync(KEY_FILE, path.join(BACKUP_DIR, `animearr-prerestore-${stamp}.secret.key`));
  for (const old of fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => /^animearr-prerestore-.*\.secret\.key$/.test(f))
    .sort()
    .reverse()
    .slice(3))
    fs.rmSync(path.join(BACKUP_DIR, old), { force: true });
}

/**
 * Restores an uploaded backup into the live config folder. `beforeSwap` runs once the copies are written and checked,
 * right before the live files are replaced; if it throws, the copies are removed and nothing is changed.
 */
export function restoreUploaded(b: ParsedBackup, beforeSwap: () => void = () => undefined) {
  const closeDb = () => {
    try {
      beforeSwap();
    } catch (e) {
      for (const f of [`${USER_DB}.restore-tmp`, `${KEY_FILE}.restore-tmp`]) fs.rmSync(f, { force: true });
      throw Object.assign(new Error(`Couldn't restore that backup: ${(e as Error).message}; nothing was changed`, { cause: e }), {
        statusCode: 500,
      });
    }
    db.close();
  };
  applyBackup(b, { db: USER_DB, key: KEY_FILE }, { safety: safetyBackup, closeDb });
}

// ---------------------------------------------------------------- staging between "upload" and "confirm with password"

let staged: { token: string; backup: ParsedBackup; at: number } | null = null;
export function stageBackup(b: ParsedBackup) {
  staged = { token: crypto.randomBytes(16).toString("hex"), backup: b, at: Date.now() };
  return staged.token;
}
export function takeStaged(token: string): ParsedBackup {
  if (!staged || staged.token !== token || Date.now() - staged.at > 10 * 60_000) throw refuse("That upload expired, choose the file again");
  const b = staged.backup;
  staged = null;
  return b;
}
