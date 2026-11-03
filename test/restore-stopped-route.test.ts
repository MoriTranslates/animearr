/**
 * Blind review round 4, M1, through the real routes: a restore that fails AFTER the live database was closed must not
 * offer a retry (this process can't reopen the database), must leave a matching database and key, must say so, and
 * must restart the app. A second restore while the restart is pending is refused in plain words instead of failing
 * with "database is not open". Own file: the database is closed here, so nothing can run after these tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-restore-stopped-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";
delete process.env.TRUST_PROXY;

const { setAccount } = await import("../server/system/settings.js");
await setAccount("captain", "pw-test-1");
const { app } = await import("../server/index.js");
const { USER_DB, CONFIG_DIR, db } = await import("../server/system/db.js");
const { createBackup } = await import("../server/system/backupTransfer.js");
const { KEY_FILE } = await import("../server/system/secretbox.js");

// The route schedules process.exit so Docker restarts the app; here it is counted instead of ending the run.
const exits: number[] = [];
process.exit = ((code?: number) => void exits.push(code ?? 0)) as typeof process.exit;

db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('m1', 'before')").run();

test("restore-upload: a failure after the close is undone, says so, offers no retry and restarts", async () => {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { "x-animearr": "1" },
    payload: { username: "captain", password: "pw-test-1" },
  });
  const cookie = String([login.headers["set-cookie"]].flat()[0]).split(";")[0];
  const up = await app.inject({
    method: "POST",
    url: "/api/system/backup/upload",
    headers: { cookie, "x-animearr": "1", "content-type": "application/octet-stream" },
    payload: (await createBackup()).data,
  });
  assert.equal(up.statusCode, 200, up.body);
  const token = (up.json() as { token: string }).token;
  const restore = () =>
    app.inject({
      method: "POST",
      url: "/api/system/backup/restore-upload",
      headers: { cookie, "x-animearr": "1" },
      payload: { token, password: "pw-test-1" },
    });
  const oldKey = fs.readFileSync(KEY_FILE);
  // The database rename fails once the key was already swapped: the worst point (backup key, old database).
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
  assert.doesNotMatch(first.body, /try again without choosing the file again|uploaded file is kept/, "no retry after the close");
  assert.match(first.body, /undone: your previous database and its key are in place/);
  assert.match(first.body, /restarting/);
  assert.match(first.body, /animearr-prerestore-/, "the safety copy is named");
  assert.ok(fs.readFileSync(KEY_FILE).equals(oldKey), "the old key is back");
  const d = new DatabaseSync(USER_DB, { readOnly: true });
  assert.equal((d.prepare("SELECT value FROM kv WHERE key = 'm1'").get() as { value: string }).value, "before", "old database in place");
  d.close();
  assert.deepEqual(
    fs.readdirSync(CONFIG_DIR).filter((f) => f.includes("restore-tmp") || f.includes("rollback-tmp")),
    [],
    "no temporary files left",
  );
  await new Promise((r) => setTimeout(r, 700));
  assert.deepEqual(exits, [1], "the app restarts so it reopens the database");

  // A second click before the restart: refused plainly, not "database is not open ... try again".
  const second = await restore();
  assert.equal(second.statusCode, 503, second.body);
  assert.match(second.body, /restarting after a restore/);
  assert.doesNotMatch(second.body, /database is not open/);
  const named = await app.inject({
    method: "POST",
    url: "/api/system/restore",
    headers: { cookie, "x-animearr": "1" },
    payload: { name: "anything.db", password: "pw-test-1" },
  });
  assert.equal(named.statusCode, 503, named.body);
});
