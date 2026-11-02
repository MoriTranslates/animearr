/** Restoring one of the automatic backups: never without a safety copy, and the live file is swapped in one rename. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-nrestore-"));
process.env.ANIMEARR_NO_LOCK = "1";
const { db, backupNow, restoreBackup, listBackups, BACKUP_DIR, USER_DB } = await import("../server/system/db.js");

const mark = (v: string) => db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('restore-test', ?)").run(v);

test("when the safety copy of the current database fails, nothing is restored", () => {
  mark("before");
  const name = backupNow("nightly")!;
  mark("after");
  // The safety copy fails (a full disk): VACUUM INTO throws. (Name clashes can't block it any more: see backup-names.)
  const realExec = db.exec.bind(db);
  db.exec = (sql: string) => {
    if (/^VACUUM INTO/.test(sql)) throw new Error("database or disk is full");
    return realExec(sql);
  };
  try {
    assert.throws(() => restoreBackup(name), /Couldn't save a copy of the current database first.*disk is full.*nothing was restored/);
  } finally {
    db.exec = realExec;
  }
  assert.equal(
    (db.prepare("SELECT value FROM kv WHERE key = 'restore-test'").get() as { value: string }).value,
    "after",
    "the live database is untouched and still open",
  );
  assert.ok(!fs.existsSync(`${USER_DB}.restore-tmp`));
  for (const f of fs.readdirSync(BACKUP_DIR))
    if (f.startsWith("animearr-prerestore-") && fs.readFileSync(path.join(BACKUP_DIR, f), "utf8") === "in the way")
      fs.rmSync(path.join(BACKUP_DIR, f));
});

test("a restore keeps a safety copy, swaps the file by rename and leaves no temporary file", () => {
  const name = listBackups().find((b) => b.kind === "nightly")!.name;
  const realRm = fs.rmSync;
  const removed: string[] = [];
  (fs as { rmSync: typeof fs.rmSync }).rmSync = ((p: fs.PathLike, o?: fs.RmOptions) => {
    removed.push(path.resolve(String(p)));
    return realRm(p, o);
  }) as typeof fs.rmSync;
  try {
    restoreBackup(name);
  } finally {
    (fs as { rmSync: typeof fs.rmSync }).rmSync = realRm;
  }
  assert.ok(!removed.includes(path.resolve(USER_DB)), "the live database is never deleted before the swap");
  assert.ok(
    listBackups().some((b) => b.kind === "prerestore"),
    "the safety copy exists",
  );
  assert.ok(!fs.existsSync(`${USER_DB}.restore-tmp`));
  const d = new DatabaseSync(USER_DB, { readOnly: true });
  assert.equal(
    (d.prepare("SELECT value FROM kv WHERE key = 'restore-test'").get() as { value: string }).value,
    "before",
    "the backup's data is live",
  );
  d.close();
});
