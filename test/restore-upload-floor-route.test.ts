/**
 * Blind review round 3, L1 and L5, through the real route: an uploaded backup's restore writes the session floor
 * (generation + 1) before the swap, and if that floor write fails the staged upload is kept so the user can retry
 * without uploading the file again. Own file: a successful restore closes the database, so nothing can run after it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-restore-upload-floor-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";

const { setAccount, getSettings } = await import("../server/system/settings.js");
await setAccount("captain", "pw-test-1");
const { app } = await import("../server/index.js");
const { CONFIG_DIR } = await import("../server/system/db.js");
const { createBackup } = await import("../server/system/backupTransfer.js");

// A successful restore schedules process.exit so Docker restarts the app; here that would end the test run.
process.exit = (() => undefined) as typeof process.exit;

test("restore-upload: a failed floor write keeps the upload for a retry, and the retry writes the floor", async () => {
  const floorFile = path.join(CONFIG_DIR, "session-floor");
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

  // Disk full while the floor is written: nothing is restored, and the upload is still there.
  const realRename = fs.renameSync;
  fs.renameSync = ((a: fs.PathLike, b: fs.PathLike) => {
    if (String(b) === floorFile) throw new Error("ENOSPC: no space left on device");
    realRename(a, b);
  }) as typeof fs.renameSync;
  let failed;
  try {
    failed = await restore();
  } finally {
    fs.renameSync = realRename;
  }
  assert.ok(failed.statusCode >= 400, failed.body);
  assert.match(failed.body, /nothing was changed/);
  assert.match(failed.body, /upload(ed file)? is kept|without (choosing|uploading) the file again/i, "the user is told the upload is kept");
  assert.equal(fs.existsSync(floorFile), false, "no floor written");

  // The retry with the same token works, and the floor holds the current generation + 1. The safety copy's name has
  // one-second resolution, so a retry in the same second would collide with the first attempt's copy; a person retrying
  // takes longer than that.
  await new Promise((r) => setTimeout(r, 1100));
  const gen = Number(getSettings().auth.sessionGen) || 0;
  const ok = await restore();
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(fs.readFileSync(floorFile, "utf8").trim(), String(gen + 1), "the route wrote the floor before the swap");
});
