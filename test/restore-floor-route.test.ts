/**
 * Blind review round 3, L1, through the real route: restoring one of the automatic backups writes the session floor
 * (generation + 1) before the swap, so a refactor that drops the floor step fails here. Own file: a successful restore
 * closes the database, so nothing can run after it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-restore-floor-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";

const { setAccount, getSettings } = await import("../server/system/settings.js");
await setAccount("captain", "pw-test-1");
const { app } = await import("../server/index.js");
const { CONFIG_DIR, backupNow } = await import("../server/system/db.js");

// A successful restore schedules process.exit so Docker restarts the app; here that would end the test run.
process.exit = (() => undefined) as typeof process.exit;

test("restore: a successful restore leaves session-floor holding the generation + 1", async () => {
  const floorFile = path.join(CONFIG_DIR, "session-floor");
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { "x-animearr": "1" },
    payload: { username: "captain", password: "pw-test-1" },
  });
  const cookie = String([login.headers["set-cookie"]].flat()[0]).split(";")[0];
  // One logout first, so the generation isn't 0 and "+ 1" can't pass by accident.
  await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie, "x-animearr": "1" } });
  const login2 = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { "x-animearr": "1" },
    payload: { username: "captain", password: "pw-test-1" },
  });
  const cookie2 = String([login2.headers["set-cookie"]].flat()[0]).split(";")[0];
  const name = backupNow("manual", "floor");
  assert.ok(name);
  const gen = Number(getSettings().auth.sessionGen) || 0;
  assert.ok(gen >= 1);
  const r = await app.inject({
    method: "POST",
    url: "/api/system/restore",
    headers: { cookie: cookie2, "x-animearr": "1" },
    payload: { name, password: "pw-test-1" },
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(fs.readFileSync(floorFile, "utf8").trim(), String(gen + 1));
});
