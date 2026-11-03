/**
 * Blind review round 8, M1: failed restores never prune, so a restore is refused (nothing changed, nothing deleted)
 * when the backups folder is full of safety copies or short of disk space.
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
const { BACKUP_DIR, listBackups } = await import("../server/system/db.js");
const { safetyBackup, MAX_SAFETY_COPIES } = await import("../server/system/backupTransfer.js");

const prerestore = () => fs.readdirSync(BACKUP_DIR).filter((f) => f.includes("prerestore"));

test("M1: low free disk space refuses the safety copy, says how much and where, and writes nothing", () => {
  const real = fs.statfsSync;
  (fs as { statfsSync: unknown }).statfsSync = () => ({ bavail: 1, bsize: 4096 });
  try {
    assert.throws(
      () => safetyBackup(""),
      (e: Error) =>
        /not enough free disk space/.test(e.message) &&
        /MB is needed/.test(e.message) &&
        e.message.includes(BACKUP_DIR) &&
        /nothing was changed/.test(e.message),
    );
  } finally {
    (fs as { statfsSync: unknown }).statfsSync = real;
  }
  assert.equal(prerestore().length, 0, "no partial copy left");
});

test("M1: at the cap of unpruned safety copies a restore is refused and nothing is deleted", () => {
  for (let i = 0; i < MAX_SAFETY_COPIES; i++) {
    const n = `animearr-prerestore-2026-01-01T00-00-${String(i).padStart(2, "0")}.db`;
    fs.copyFileSync(path.join(BACKUP_DIR, "../animearr.db"), path.join(BACKUP_DIR, n));
  }
  const before = fs.readdirSync(BACKUP_DIR).sort();
  assert.equal(listBackups().filter((b) => b.kind === "prerestore").length, MAX_SAFETY_COPIES);
  assert.throws(
    () => safetyBackup(""),
    (e: Error) =>
      /Delete old prerestore copies from the backups list, or complete a restore/.test(e.message) && /nothing was changed/.test(e.message),
  );
  assert.deepEqual(fs.readdirSync(BACKUP_DIR).sort(), before, "nothing added or deleted");
});
