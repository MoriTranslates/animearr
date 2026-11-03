/**
 * Blind review H13/H14: restore must work when the database is damaged, and must never leave AnimeArr unable to start
 * because the restored database was sealed with a different secret.key. Each "start" is a fresh process
 * (test/restore-child.ts), the way AnimeArr loads its database, key and settings at startup.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-rsafe-self-"));
process.env.ANIMEARR_NO_LOCK = "1";
const { migrateUserDb, userMigrations, userSchemaVersion } = await import("../server/system/db.js");

const CHILD = path.join(import.meta.dirname, "restore-child.ts");
type Result = {
  ok?: boolean;
  error?: string;
  crashed?: string;
  corrupt?: boolean;
  marker?: string;
  passwordOk?: boolean;
  hasHash?: boolean;
  backup?: string;
};
/** One AnimeArr start in `dir`, running one action. */
function start(dir: string, action: string, arg = ""): Result {
  const r = spawnSync(process.execPath, ["--no-warnings", "--import", "tsx", CHILD, action, arg], {
    env: { ...process.env, ANIMEARR_CONFIG: dir, ANIMEARR_NO_LOCK: "1" },
    encoding: "utf8",
    timeout: 120_000,
  });
  const last = (r.stdout ?? "").trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(last) as Result;
  } catch {
    return { crashed: `exit ${r.status}: ${(r.stderr ?? "").slice(-800)}` };
  }
}
const newDir = (tag: string) => fs.mkdtempSync(path.join(os.tmpdir(), `animearr-rsafe-${tag}-`));
const keyOf = (dir: string) => fs.readFileSync(path.join(dir, "secret.key"), "utf8").trim();
const backupsIn = (dir: string) => fs.readdirSync(path.join(dir, "backups"));
/** A state with its own key, settings and password ("pw-<marker>"), and a nightly backup of it. */
function setup(dir: string, marker: string) {
  const r = start(dir, "setup", marker);
  assert.ok(r.backup, JSON.stringify(r));
  return r.backup!;
}
/** The data of `marker` from another install, uploaded into `dir` (so `dir` now runs on that install's key). */
function uploadFrom(dir: string, marker: string) {
  const other = newDir("other");
  setup(other, marker);
  const file = path.join(other, "export.tar.gz");
  assert.deepEqual(start(other, "export", file), { ok: true });
  assert.deepEqual(start(dir, "upload", file), { ok: true });
}
function corrupt(dir: string) {
  const f = path.join(dir, "animearr.db");
  const fd = fs.openSync(f, "r+");
  fs.writeSync(fd, Buffer.alloc(4096, 0x5a), 0, 4096, 0);
  fs.closeSync(fd);
  for (const x of ["-wal", "-shm"]) fs.rmSync(f + x, { force: true });
}

test("H13: a damaged database with unreadable settings: you can still log in (backup's password) and restore", () => {
  const dir = newDir("corrupt");
  const nightly = setup(dir, "one");
  corrupt(dir);
  const damaged = fs.readFileSync(path.join(dir, "animearr.db"));
  const s = start(dir, "status", "pw-one");
  assert.equal(s.corrupt, true, JSON.stringify(s));
  assert.equal(s.hasHash, true, "the account isn't lost: no 'create an account' that can't be saved");
  assert.equal(s.passwordOk, true, "the password from the backup works");
  assert.deepEqual(start(dir, "restore", nightly), { ok: true });
  const after = start(dir, "status", "pw-one");
  assert.equal(after.corrupt, false, JSON.stringify(after));
  assert.equal(after.marker, "http://one.lan");
  // The damaged file is kept, not overwritten without a copy.
  const kept = backupsIn(dir).filter((f) => /^animearr-damaged-.*\.db$/.test(f));
  assert.equal(kept.length, 1, backupsIn(dir).join(", "));
  assert.ok(fs.readFileSync(path.join(dir, "backups", kept[0])).equals(damaged));
});

test("H13: an uploaded backup can be restored while the database is damaged (the safety copy is a raw copy)", () => {
  const dir = newDir("corrupt-up");
  setup(dir, "one");
  corrupt(dir);
  uploadFrom(dir, "two");
  const after = start(dir, "status", "pw-two");
  assert.equal(after.corrupt, false, JSON.stringify(after));
  assert.equal(after.marker, "http://two.lan");
  assert.equal(backupsIn(dir).filter((f) => /^animearr-damaged-.*\.db$/.test(f)).length, 1, "the damaged database was kept");
});

test("H14: restoring an older backup after an upload restore brings its key back with it (the app starts)", () => {
  const dir = newDir("keyswap");
  const nightly = setup(dir, "one");
  const k1 = keyOf(dir);
  uploadFrom(dir, "two");
  assert.notEqual(keyOf(dir), k1, "the upload brought its own key");
  assert.equal(start(dir, "status", "pw-two").marker, "http://two.lan");
  assert.deepEqual(start(dir, "restore", nightly), { ok: true });
  const after = start(dir, "status", "pw-one");
  assert.equal(after.crashed, undefined, after.crashed);
  assert.equal(after.marker, "http://one.lan");
  assert.equal(after.passwordOk, true);
  assert.equal(keyOf(dir), k1, "the key that opens the restored data is live");
});

test("H14: without a key that opens the backup, the restore is refused before anything changes", () => {
  const dir = newDir("nokey");
  const nightly = setup(dir, "one");
  uploadFrom(dir, "two");
  for (const f of backupsIn(dir)) if (f.endsWith(".secret.key")) fs.rmSync(path.join(dir, "backups", f));
  // (The file's bytes change on any start: opening switches it to WAL. Its settings row and the folder are compared.)
  const settingsRow = () => {
    const d = new DatabaseSync(path.join(dir, "animearr.db"), { readOnly: true });
    const v = (d.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as { value: string }).value;
    d.close();
    return v;
  };
  const rowBefore = settingsRow();
  const filesBefore = [...fs.readdirSync(dir), ...backupsIn(dir)].filter((n) => !/-(wal|shm)$/.test(n)).sort();
  const keyBefore = keyOf(dir);
  const r = start(dir, "restore", nightly);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /different secret key.*nothing was changed/i);
  assert.equal(settingsRow(), rowBefore, "the live database is untouched");
  assert.deepEqual(
    [...fs.readdirSync(dir), ...backupsIn(dir)].filter((n) => !/-(wal|shm)$/.test(n)).sort(),
    filesBefore,
    "no temporary or safety files were made",
  );
  assert.equal(keyOf(dir), keyBefore, "the live key is untouched");
  assert.equal(start(dir, "status", "pw-two").marker, "http://two.lan", "and the app still starts");
});

test("crash between the database and key renames: the next start finishes the swap", () => {
  const dir = newDir("crash-after");
  const nightly = setup(dir, "one");
  const k1 = keyOf(dir);
  uploadFrom(dir, "two");
  // The restore of the nightly got as far as renaming the database, then the process died.
  for (const x of ["-wal", "-shm"]) fs.rmSync(path.join(dir, "animearr.db" + x), { force: true });
  fs.copyFileSync(path.join(dir, "backups", nightly), path.join(dir, "animearr.db"));
  fs.writeFileSync(path.join(dir, "secret.key.restore-tmp"), k1);
  const s = start(dir, "status", "pw-one");
  assert.equal(s.crashed, undefined, s.crashed);
  assert.equal(s.marker, "http://one.lan");
  assert.equal(keyOf(dir), k1);
  assert.equal(fs.existsSync(path.join(dir, "secret.key.restore-tmp")), false);
});

test("crash before the database rename: the live pair stays, the waiting key is dropped", () => {
  const dir = newDir("crash-before");
  setup(dir, "one");
  const k1 = keyOf(dir);
  uploadFrom(dir, "two");
  const k2 = keyOf(dir);
  fs.writeFileSync(path.join(dir, "secret.key.restore-tmp"), k1);
  const s = start(dir, "status", "pw-two");
  assert.equal(s.crashed, undefined, s.crashed);
  assert.equal(s.marker, "http://two.lan");
  assert.equal(keyOf(dir), k2);
  assert.equal(fs.existsSync(path.join(dir, "secret.key.restore-tmp")), false);
});

/** Seals like secretbox.ts (enc:v1: + iv | tag | ciphertext). */
function sealWith(hex: string, plain: string) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", Buffer.from(hex, "hex"), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return "enc:v1:" + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

test("a backup from an older AnimeArr restores and is brought up to date; one from a newer AnimeArr is refused", () => {
  const dir = newDir("oldver");
  setup(dir, "one");
  const old = "animearr-nightly-2020-01-01T00-00-00.db";
  const d = new DatabaseSync(path.join(dir, "backups", old));
  migrateUserDb(d, userMigrations().slice(0, 4));
  d.prepare("INSERT INTO settings (key, value) VALUES ('settings', ?)").run(
    sealWith(keyOf(dir), JSON.stringify({ externalUrl: "http://old.lan" })),
  );
  d.close();
  assert.deepEqual(start(dir, "restore", old), { ok: true });
  const s = start(dir, "status");
  assert.equal(s.corrupt, false, JSON.stringify(s));
  assert.equal(s.marker, "http://old.lan");
  const live = new DatabaseSync(path.join(dir, "animearr.db"), { readOnly: true });
  assert.equal((live.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, userSchemaVersion());
  live.close();
  // Newer than this build understands: refused, nothing changed.
  const newer = "animearr-nightly-2021-01-01T00-00-00.db";
  fs.copyFileSync(path.join(dir, "animearr.db"), path.join(dir, "backups", newer));
  const n = new DatabaseSync(path.join(dir, "backups", newer));
  n.exec(`PRAGMA user_version = ${userSchemaVersion() + 1}`);
  n.close();
  const before = fs.readFileSync(path.join(dir, "animearr.db"));
  const r = start(dir, "restore", newer);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /newer AnimeArr.*nothing was changed/i);
  assert.ok(fs.readFileSync(path.join(dir, "animearr.db")).equals(before));
});

test("L6: while a backup's settings stand in, the no-password home-network login is off, and it says which backup", () => {
  const dir = newDir("standin");
  const nightly = setup(dir, "one"); // that backup had the no-password home-network login on
  corrupt(dir);
  const s = start(dir, "status", "pw-one") as Result & { bypassLocal?: boolean; standIn?: { backup: string } | null };
  assert.equal(s.corrupt, true);
  assert.equal(s.passwordOk, true);
  assert.equal(s.bypassLocal, false, "the password is always asked while stand-in settings are used");
  assert.equal(s.standIn?.backup, nightly, "which backup stands in is known (for the warning)");
});
