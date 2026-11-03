/**
 * Blind review L5: the raw copy of a damaged database (kept before a restore replaces it) says what to do when it
 * can't be made, and copies left by repeated attempts don't pile up.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-damaged-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { BACKUP_DIR, backupNow, dbState, keepDamaged, restoreBackup } = await import("../server/system/db.js");
const { safetyBackup } = await import("../server/system/backupTransfer.js");

const damaged = () => fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith("animearr-damaged-"));
const realCopy = fs.copyFileSync;
afterEach(() => {
  (fs as { copyFileSync: unknown }).copyFileSync = realCopy;
  dbState.corrupt = false;
});

test("copies of a damaged database are kept to the newest three (with their WAL)", () => {
  for (let i = 1; i <= 4; i++) {
    const f = path.join(BACKUP_DIR, `animearr-damaged-2026-01-0${i}T00-00-00-000.db`);
    fs.writeFileSync(f, `old ${i}`);
    fs.writeFileSync(`${f}-wal`, "wal");
    fs.utimesSync(f, new Date(2026, 0, i), new Date(2026, 0, i));
  }
  const made = keepDamaged()!;
  const left = damaged();
  assert.ok(left.includes(made), "the new copy is kept");
  assert.deepEqual(
    left.filter((f) => f.endsWith(".db")).sort(),
    [made, "animearr-damaged-2026-01-03T00-00-00-000.db", "animearr-damaged-2026-01-04T00-00-00-000.db"].sort(),
  );
  for (const gone of ["2026-01-01", "2026-01-02"])
    assert.ok(!left.some((f) => f.includes(gone)), `the pruned copy ${gone} and its WAL went: ${left.join(", ")}`);
});

test("when the copy can't be made (disk full), the restore says what to do next, and changes nothing", () => {
  const name = backupNow("nightly")!;
  dbState.corrupt = true;
  (fs as { copyFileSync: unknown }).copyFileSync = (a: fs.PathLike, b: fs.PathLike, m?: number) => {
    if (String(b).includes("animearr-damaged-")) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    return realCopy(a, b, m);
  };
  assert.throws(() => restoreBackup(name), /ENOSPC.*nothing was restored.*free some space.*or move .*animearr\.db/is);
  assert.throws(() => safetyBackup(), /ENOSPC.*nothing was changed.*free some space.*or move .*animearr\.db/is);
});
