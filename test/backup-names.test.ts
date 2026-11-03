/**
 * Blind review L17: two backups of the same kind in the same second (or millisecond) both succeed, under distinct names;
 * names from before (one-second stamps) are still listed, pruned and restorable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-bnames-"));
process.env.ANIMEARR_NO_LOCK = "1";
const { db, backupNow, listBackups, restoreBackup, BACKUP_DIR } = await import("../server/system/db.js");

const mark = (v: string) => db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('names-test', ?)").run(v);

test("backups of the same kind at the same instant all succeed, under distinct names", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 2, 12, 0, 0, 0) });
  const names = [backupNow("manual"), backupNow("manual"), backupNow("manual"), backupNow("prerestore", "upload")];
  t.mock.timers.reset();
  assert.ok(names.every(Boolean), JSON.stringify(names));
  assert.equal(new Set(names).size, names.length, "all distinct");
  for (const n of names) assert.ok(fs.existsSync(path.join(BACKUP_DIR, n!)), n!);
  const listed = listBackups();
  for (const n of names)
    assert.ok(
      listed.some((b) => b.name === n),
      `${n} is listed`,
    );
  assert.equal(listed.find((b) => b.name === names[0])!.kind, "manual");
  assert.equal(listed.find((b) => b.name === names[3])!.kind, "prerestore");
});

test("pruning still keeps the newest copies of each kind", () => {
  for (let i = 0; i < 12; i++) backupNow("manual");
  assert.equal(listBackups().filter((b) => b.kind === "manual").length, 10);
});

test("a key copy saved at the same instant as an earlier one never overwrites it", async (t) => {
  const { safetyBackup } = await import("../server/system/backupTransfer.js");
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 2, 13, 0, 0, 0) });
  // An earlier copy of a different key sits exactly at the name this instant gives.
  const earlier = path.join(BACKUP_DIR, "animearr-prerestore-2026-11-02T13-00-00-000.secret.key");
  const other = "ab".repeat(32);
  fs.writeFileSync(earlier, other);
  safetyBackup();
  t.mock.timers.reset();
  assert.equal(fs.readFileSync(earlier, "utf8"), other, "the earlier copy is untouched");
  const live = fs.readFileSync(path.join(process.env.ANIMEARR_CONFIG!, "secret.key"), "utf8").trim();
  const keys = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".secret.key"));
  assert.ok(
    keys.some((f) => fs.readFileSync(path.join(BACKUP_DIR, f), "utf8").trim() === live),
    `the live key was saved beside it: ${keys.join(", ")}`,
  );
});

// Last: the restore closes the live database.
test("a backup named the old way (one-second stamp) is still listed and restorable", () => {
  mark("old-style");
  const fresh = backupNow("nightly")!;
  const old = "animearr-nightly-2026-01-01T00-00-00.db";
  fs.renameSync(path.join(BACKUP_DIR, fresh), path.join(BACKUP_DIR, old));
  mark("now");
  const b = listBackups().find((x) => x.name === old);
  assert.ok(b, "listed");
  assert.equal(b!.kind, "nightly");
  restoreBackup(old);
});
