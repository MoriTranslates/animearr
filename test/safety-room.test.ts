/**
 * Blind review round 9 (H1, H2, M1, M2): safety copies before a restore.
 * - No cap on how many copies may exist (a cap became a lockout with no way out from the UI).
 * - A restore that fails before the swap removes the copy it just made (it only duplicates the untouched live state),
 *   and never any other copy, so repeated failures can't pile copies up.
 * - The free-space check covers every folder written (backups and config), counts the incoming upload, and treats a
 *   statfs it can't read as "unknown", never as "no room".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-safetyroom-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { setAccount } = await import("../server/system/settings.js");
await setAccount("captain", "pw-test-1");
const { BACKUP_DIR, CONFIG_DIR, listBackups } = await import("../server/system/db.js");
const { createBackup, parseBackup, restoreUploaded, safetyBackup } = await import("../server/system/backupTransfer.js");

const upload = await parseBackup((await createBackup()).data);
const safetyFiles = () => fs.readdirSync(BACKUP_DIR).filter((f) => /^animearr-(prerestore|damaged)-/.test(f));
const MARK = "beforeSwap-reached-marker";
const failAtSwap = () => {
  throw new Error(MARK);
};

type Statfs = (p: unknown) => unknown;
function withStatfs(fake: Statfs, run: () => void) {
  const real = fs.statfsSync;
  (fs as { statfsSync: unknown }).statfsSync = fake;
  try {
    run();
  } finally {
    (fs as { statfsSync: unknown }).statfsSync = real;
  }
}
const lots = { bavail: 1e9, bsize: 4096 };
const tiny = { bavail: 1, bsize: 4096 };

test("M1: low free space in the config folder (where the restore's temp files go) refuses before anything is written", () => {
  const before = safetyFiles();
  withStatfs(
    (p) => (path.resolve(String(p)) === path.resolve(CONFIG_DIR) ? tiny : lots),
    () =>
      assert.throws(
        () => restoreUploaded(upload, failAtSwap),
        (e: Error) =>
          e.message.includes(`not enough free disk space in ${CONFIG_DIR}`) &&
          /about \d+ MB is needed/.test(e.message) &&
          /nothing was changed/.test(e.message),
      ),
  );
  assert.deepEqual(safetyFiles(), before, "no safety copy written");
});

test("M1: the incoming upload's size is counted, and low space in the backups folder is still refused", () => {
  const before = safetyFiles();
  const free200 = { bavail: (200 * 1024 * 1024) / 4096, bsize: 4096 };
  withStatfs(
    () => free200,
    () => {
      assert.throws(() => safetyBackup("", 300 * 1024 * 1024), /not enough free disk space in .*about \d+ MB is needed/);
      assert.deepEqual(safetyFiles(), before, "nothing written");
      for (const f of safetyBackup("", 0).split(", ")) fs.rmSync(path.join(BACKUP_DIR, f)); // fits without the upload
    },
  );
  withStatfs(
    (p) => (path.resolve(String(p)) === path.resolve(BACKUP_DIR) ? tiny : lots),
    () =>
      assert.throws(
        () => safetyBackup(""),
        (e: Error) => e.message.includes(`not enough free disk space in ${BACKUP_DIR}`),
      ),
  );
  assert.deepEqual(safetyFiles(), before, "nothing written");
});

test("M2: statfs giving NaN or a zero block size is unknown, not 'no room': the restore proceeds", () => {
  for (const odd of [
    { bavail: Number.NaN, bsize: 4096 },
    { bavail: 1e9, bsize: 0 },
    { bavail: "garbage", bsize: 4096 },
  ])
    withStatfs(
      () => odd,
      () => assert.throws(() => restoreUploaded(upload, failAtSwap), new RegExp(MARK), `reached the swap with ${JSON.stringify(odd)}`),
    );
});

test("M1 (round 10): blocks=0, or bavail=0 while bfree>0, is unmeasurable: the restore proceeds", () => {
  for (const odd of [
    { blocks: 0, bavail: 0, bfree: 0, bsize: 4096 },
    { blocks: 1e9, bavail: 0, bfree: 5e8, bsize: 4096 },
  ])
    withStatfs(
      () => odd,
      () => assert.throws(() => restoreUploaded(upload, failAtSwap), new RegExp(MARK), `reached the swap with ${JSON.stringify(odd)}`),
    );
});

test("M1 (round 10): a genuinely full disk (blocks>0, bavail and bfree both 0) still refuses", () => {
  const before = safetyFiles();
  withStatfs(
    () => ({ blocks: 1e9, bavail: 0, bfree: 0, bsize: 4096 }),
    () => assert.throws(() => restoreUploaded(upload, failAtSwap), /not enough free disk space/),
  );
  assert.deepEqual(safetyFiles(), before, "nothing written");
});

test("M2: statfs throwing (FUSE / network mounts) skips the check: the restore proceeds", () => {
  withStatfs(
    () => {
      throw Object.assign(new Error("ENOSYS: function not implemented, statfs"), { code: "ENOSYS" });
    },
    () => assert.throws(() => restoreUploaded(upload, failAtSwap), new RegExp(MARK)),
  );
});

test("H1: many existing safety copies never block a restore, and a failed attempt deletes none of them", () => {
  const seeded: string[] = [];
  for (let i = 0; i < 15; i++) {
    const n = `animearr-prerestore-2026-01-01T00-00-${String(i).padStart(2, "0")}.db`;
    fs.copyFileSync(path.join(CONFIG_DIR, "animearr.db"), path.join(BACKUP_DIR, n));
    fs.writeFileSync(path.join(BACKUP_DIR, n.replace(/\.db$/, ".secret.key")), "0".repeat(64));
    seeded.push(n, n.replace(/\.db$/, ".secret.key"));
  }
  const before = safetyFiles().sort();
  assert.throws(() => restoreUploaded(upload, failAtSwap), new RegExp(MARK), "not refused by a cap");
  assert.deepEqual(safetyFiles().sort(), before, "the older copies are all still there, and this attempt's copy is gone");
  for (const f of seeded) fs.rmSync(path.join(BACKUP_DIR, f));
});

test("H2: 12 attempts failing before the swap leave no extra copies, and the next restore still works", () => {
  const before = safetyFiles().sort();
  for (let i = 0; i < 12; i++)
    assert.throws(
      () => restoreUploaded(upload, failAtSwap),
      (e: Error) => e.message.includes(MARK) && /nothing was changed/.test(e.message),
    );
  assert.deepEqual(safetyFiles().sort(), before, "every failed attempt removed its own copy and key");
  assert.equal(listBackups().filter((b) => b.kind === "prerestore").length, 0);
  // Last in this file: a successful restore closes the live database.
  restoreUploaded(upload, () => undefined);
  const after = safetyFiles();
  assert.equal(after.filter((f) => f.endsWith(".db")).length, 1, "the successful restore keeps its own safety copy");
  assert.equal(after.filter((f) => f.endsWith(".secret.key")).length, 1, "and its key");
});
