/**
 * Blind review round 4, M1, for restoring one of the automatic backups: when the swap fails after the live database
 * was closed, the old database stays in place, the message says so, and the app restarts instead of running on a
 * closed database. Own file: the database is closed here, so nothing can run after this test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-restore-named-stopped-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";
delete process.env.TRUST_PROXY;

const { setAccount } = await import("../server/system/settings.js");
await setAccount("captain", "pw-test-1");
const { app } = await import("../server/index.js");
const { USER_DB, backupNow, db } = await import("../server/system/db.js");

const exits: number[] = [];
process.exit = ((code?: number) => void exits.push(code ?? 0)) as typeof process.exit;

test("restore: a failure after the close keeps the old database, says so and restarts", async () => {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { "x-animearr": "1" },
    payload: { username: "captain", password: "pw-test-1" },
  });
  const cookie = String([login.headers["set-cookie"]].flat()[0]).split(";")[0];
  db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('m1', 'in-backup')").run();
  const name = backupNow("manual", "m1");
  assert.ok(name);
  db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('m1', 'live')").run();
  const restore = () =>
    app.inject({
      method: "POST",
      url: "/api/system/restore",
      headers: { cookie, "x-animearr": "1" },
      payload: { name, password: "pw-test-1" },
    });
  const realRename = fs.renameSync;
  fs.renameSync = ((a: fs.PathLike, b: fs.PathLike) => {
    if (String(b) === USER_DB) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
    realRename(a, b);
  }) as typeof fs.renameSync;
  let first;
  try {
    first = await restore();
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(first.statusCode, 500, first.body);
  assert.match(first.body, /EPERM/);
  assert.match(first.body, /undone: your previous database and its key are in place/);
  assert.match(first.body, /retry the restore/);
  assert.match(first.body, /restarting/);
  assert.doesNotMatch(first.body, /nothing was changed/, "the database was closed, so 'nothing changed' would mislead");
  const d = new DatabaseSync(USER_DB, { readOnly: true });
  assert.equal((d.prepare("SELECT value FROM kv WHERE key = 'm1'").get() as { value: string }).value, "live", "old database in place");
  d.close();
  assert.equal(fs.existsSync(`${USER_DB}.restore-tmp`), false, "no temporary file left");
  await new Promise((r) => setTimeout(r, 700));
  assert.deepEqual(exits, [1], "the app restarts so it reopens the database");
  const second = await restore();
  assert.equal(second.statusCode, 503, second.body);
  assert.doesNotMatch(second.body, /database is not open/);
});
