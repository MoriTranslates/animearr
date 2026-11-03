/**
 * Blind review round 6: pruning the safety copies' saved keys must never delete the only key a backup still on disk
 * needs (M), and a safety copy that fails must not have pruned an older one first (L).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-keyprune-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { setAccount } = await import("../server/system/settings.js");
await setAccount("captain", "pw-test-1"); // a sealed settings row, so backups need their key
const { BACKUP_DIR, backupNow, listBackups } = await import("../server/system/db.js");
const { KEY_FILE } = await import("../server/system/secretbox.js");
const { safetyBackup, restoreBackup, pruneSafetyCopies } = await import("../server/system/backupTransfer.js");

// Safety copies are named to the second, so each one needs a fresh second.
const nextSecond = () => new Promise((r) => setTimeout(r, 1100));
const keyFiles = () => fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".secret.key"));
const holds = (k: Buffer) => keyFiles().some((f) => fs.readFileSync(path.join(BACKUP_DIR, f)).equals(k));
const newKey = () => crypto.randomBytes(32).toString("hex");

test("M: three more safety copies never prune the only key a listed manual backup needs", async () => {
  const k0 = fs.readFileSync(KEY_FILE);
  const manual = backupNow("manual")!; // sealed with K0
  // As after an earlier upload restore: K0 survives only as that restore's safety key, the live key is now K1.
  fs.writeFileSync(path.join(BACKUP_DIR, "animearr-prerestore-2026-01-01T00-00-00-upload.secret.key"), k0);
  // And a stale key no backup needs, which pruning should still remove.
  const orphan = Buffer.from(newKey());
  fs.writeFileSync(path.join(BACKUP_DIR, "animearr-prerestore-2025-12-31T00-00-00.secret.key"), orphan);
  fs.writeFileSync(KEY_FILE, newKey());
  for (let i = 0; i < 3; i++) {
    await nextSecond();
    safetyBackup(""); // what each further named restore attempt does first
  }
  pruneSafetyCopies(); // what a restore that succeeded does last (round 7)
  assert.ok(holds(k0), "the key the manual backup needs is still in the backups folder");
  assert.ok(!holds(orphan), "a key no listed backup needs is still pruned");
  assert.ok(listBackups().some((b) => b.name === manual));
  await nextSecond();
  assert.throws(
    () =>
      restoreBackup(manual, () => {
        throw new Error("stop before close");
      }),
    /stop before close/,
    "the manual backup's key is found, so the restore gets as far as the swap (not a 409)",
  );
});

test("L: a safety copy that fails at the key step leaves the older copies and keys as they were", async () => {
  await nextSecond();
  const before = listBackups()
    .filter((b) => b.kind === "prerestore")
    .map((b) => b.name)
    .sort();
  const keysBefore = keyFiles().sort();
  assert.ok(before.length >= 3, "enough safety copies that one more would prune");
  const realCopy = fs.copyFileSync;
  fs.copyFileSync = ((a: fs.PathLike, b: fs.PathLike, m?: number) => {
    if (String(b).endsWith(".secret.key")) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    realCopy(a, b, m);
  }) as typeof fs.copyFileSync;
  try {
    assert.throws(() => safetyBackup(""), /nothing was changed/);
  } finally {
    fs.copyFileSync = realCopy;
  }
  const after = listBackups()
    .filter((b) => b.kind === "prerestore")
    .map((b) => b.name)
    .sort();
  assert.deepEqual(after, before, "no older safety copy was pruned by the copy that failed");
  assert.deepEqual(keyFiles().sort(), keysBefore, "no saved key was pruned either");
});
