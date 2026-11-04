/**
 * Blind review round 9, H2 (the other side): a restore that fails AFTER the swap began keeps its safety copy. The live
 * database was closed and files may have moved, so that copy is the record of what was there; only a failure before the
 * swap may remove it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-afterswap-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { setAccount } = await import("../server/system/settings.js");
await setAccount("captain", "pw-test-1");
const { BACKUP_DIR, restartNeeded } = await import("../server/system/db.js");
const { KEY_FILE } = await import("../server/system/secretbox.js");
const { createBackup, parseBackup, restoreUploaded } = await import("../server/system/backupTransfer.js");

test("H2: a failure after the swap began keeps this attempt's safety copy and its key", async () => {
  const upload = await parseBackup((await createBackup()).data);
  const real = fs.renameSync;
  (fs as { renameSync: unknown }).renameSync = (from: fs.PathLike, to: fs.PathLike) => {
    if (path.resolve(String(to)) === path.resolve(KEY_FILE)) throw Object.assign(new Error("EPERM: rename refused"), { code: "EPERM" });
    return real(from, to);
  };
  let caught: unknown;
  try {
    restoreUploaded(upload, () => undefined);
  } catch (e) {
    caught = e;
  } finally {
    (fs as { renameSync: unknown }).renameSync = real;
  }
  assert.equal(restartNeeded(caught), true, "failed after the database was closed");
  const copies = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith("animearr-prerestore-"));
  assert.equal(copies.filter((f) => f.endsWith(".db")).length, 1, "the safety copy is kept");
  assert.equal(copies.filter((f) => f.endsWith(".secret.key")).length, 1, "and its key");
  assert.match((caught as Error).message, new RegExp(copies.find((f) => f.endsWith(".db"))!.replace(/\./g, "\\.")));
});
