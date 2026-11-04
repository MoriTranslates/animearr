/**
 * Blind review L5 (files branch), adapted to the auth branch's restore design on merge: the raw copy of a damaged
 * database (kept before a restore replaces it) is never deleted automatically, however many attempts leave one, and when
 * it can't be made the restore is refused before anything changes, naming what failed.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-damaged-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { BACKUP_DIR, backupNow, dbState, USER_DB } = await import("../server/system/db.js");
const { restoreBackup, safetyBackup, safetyCopyFailed } = await import("../server/system/backupTransfer.js");

const noFloor = () => undefined;
const damaged = () => fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith("animearr-damaged-"));
const realCopy = fs.copyFileSync;
afterEach(() => {
  (fs as { copyFileSync: unknown }).copyFileSync = realCopy;
  dbState.corrupt = false;
});

test("copies of a damaged database are never pruned: older ones stay when a new one is made", () => {
  for (let i = 1; i <= 4; i++) {
    const f = path.join(BACKUP_DIR, `animearr-damaged-2026-01-0${i}T00-00-00-000.db`);
    fs.writeFileSync(f, `old ${i}`);
    fs.writeFileSync(`${f}-wal`, "wal");
    fs.utimesSync(f, new Date(2026, 0, i), new Date(2026, 0, i));
  }
  const before = damaged();
  dbState.corrupt = true;
  const made = safetyBackup("").split(", ");
  dbState.corrupt = false;
  const left = damaged();
  for (const f of before) assert.ok(left.includes(f), `${f} is kept`);
  for (const f of made) assert.ok(left.includes(f), `the new copy ${f} is there`);
  assert.ok(made.some((f) => f.endsWith(".db")) && made.some((f) => f.endsWith(".secret.key")), made.join(", "));
  const dbCopy = path.join(
    BACKUP_DIR,
    made.find((f) => f.endsWith(".db"))!,
  );
  assert.ok(fs.readFileSync(dbCopy).equals(fs.readFileSync(USER_DB)), "byte for byte");
});

test("when the copy can't be made (disk full), the restore is refused, says why, and changes nothing", () => {
  const name = backupNow("nightly")!;
  dbState.corrupt = true;
  const before = damaged();
  (fs as { copyFileSync: unknown }).copyFileSync = (a: fs.PathLike, b: fs.PathLike, m?: number) => {
    if (String(b).includes("animearr-damaged-")) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    return realCopy(a, b, m);
  };
  let caught: unknown;
  try {
    restoreBackup(name, noFloor);
  } catch (e) {
    caught = e;
  }
  assert.match(String((caught as Error)?.message), /safety copy of the damaged database.*ENOSPC.*nothing was changed/is);
  assert.equal(safetyCopyFailed(caught), true, "the route then says what to fix instead of 'try again'");
  assert.deepEqual(damaged(), before, "no half-written copy is left");
  assert.ok(!fs.existsSync(`${USER_DB}.restore-tmp`));
});
