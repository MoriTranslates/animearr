/**
 * Blind review round 7: the safety copies and their keys are pruned only after a restore has succeeded, never the
 * backup being restored (M1), and a pruning error never fails or aborts a restore (L1).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-pruneorder-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { setAccount } = await import("../server/system/settings.js");
await setAccount("captain", "pw-test-1"); // a sealed settings row, so a safety copy needs its own key
const { BACKUP_DIR, listBackups, USER_DB } = await import("../server/system/db.js");
const { safetyBackup, restoreBackup, pruneSafetyCopies } = await import("../server/system/backupTransfer.js");

// Safety copies are named to the second, so each one needs a fresh second.
const nextSecond = () => new Promise((r) => setTimeout(r, 1100));
const keyOf = (name: string) => path.join(BACKUP_DIR, name.replace(/\.db$/, ".secret.key"));
const oldestSafety = () =>
  listBackups()
    .filter((b) => b.kind === "prerestore")
    .sort((a, b) => a.at - b.at)[0].name;

test("M1: a failed restore of the oldest of three safety copies keeps it and its key, so a retry still finds it", async () => {
  // Five, not three: a failed attempt now removes its own copy (blind review round 9, H2), so the two failed attempts
  // below add none, and pruning still needs more than three others to have something to prune.
  for (let i = 0; i < 5; i++) {
    safetyBackup("");
    await nextSecond();
  }
  const oldest = oldestSafety();
  assert.throws(
    () =>
      restoreBackup(oldest, () => {
        throw new Error("session floor failed");
      }),
    /session floor failed.*nothing was changed/,
  );
  assert.ok(fs.existsSync(path.join(BACKUP_DIR, oldest)), "the copy being restored was not pruned");
  assert.ok(fs.existsSync(keyOf(oldest)), "nor its only key");
  await nextSecond();
  assert.throws(
    () =>
      restoreBackup(oldest, () => {
        throw new Error("still failing");
      }),
    /still failing/,
    "the retry reaches the swap step instead of 'Unknown backup'",
  );
  // The prune a successful restore runs never takes the restored copy or its key, and keeps three others.
  pruneSafetyCopies(oldest);
  assert.ok(fs.existsSync(path.join(BACKUP_DIR, oldest)) && fs.existsSync(keyOf(oldest)), "the restored copy and key survive");
  assert.equal(listBackups().filter((b) => b.kind === "prerestore" && b.name !== oldest).length, 3);
});

// Last: a successful restore closes the live database for the rest of this process.
test("L1: a pruning error after a successful restore is logged, never fails it, and the restored copy is kept", async () => {
  await nextSecond();
  const oldest = oldestSafety();
  const realRm = fs.rmSync;
  const realWarn = console.warn;
  const warned: string[] = [];
  (fs as { rmSync: typeof fs.rmSync }).rmSync = ((p: fs.PathLike, o?: fs.RmOptions) => {
    if (path.resolve(String(p)).startsWith(path.resolve(BACKUP_DIR))) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    return realRm(p, o);
  }) as typeof fs.rmSync;
  console.warn = (...a: unknown[]) => void warned.push(a.join(" "));
  try {
    restoreBackup(oldest, () => undefined);
  } finally {
    (fs as { rmSync: typeof fs.rmSync }).rmSync = realRm;
    console.warn = realWarn;
  }
  assert.ok(!fs.existsSync(`${USER_DB}.restore-tmp`), "the swap completed");
  assert.ok(
    warned.some((w) => /prun/i.test(w) && /EBUSY/.test(w)),
    "the pruning error is logged",
  );
  assert.ok(fs.existsSync(path.join(BACKUP_DIR, oldest)), "the restored copy is still there");
  assert.ok(fs.existsSync(keyOf(oldest)), "and so is its key");
});
