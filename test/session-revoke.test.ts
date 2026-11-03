/**
 * Server-side session revocation (review L1): a session token used after logout is refused, and a password change
 * ends the other sessions. Logging out signs out every browser (one session generation per account, like a password
 * change), since tokens are signed and not stored. Tokens issued before this change keep working until a logout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-sessions-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";

const { setAccount, getSettings } = await import("../server/system/settings.js");
await setAccount("captain", "pw-test-1");
const { app } = await import("../server/index.js");
const { COOKIE } = await import("../server/system/auth.js");

async function login(password = "pw-test-1") {
  const r = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { "x-animearr": "1" },
    payload: { username: "captain", password },
  });
  assert.equal(r.statusCode, 200, r.body);
  return String([r.headers["set-cookie"]].flat()[0]).split(";")[0];
}
const get = (cookie: string) => app.inject({ method: "GET", url: "/api/settings", headers: { cookie } }).then((r) => r.statusCode);

// First, while no logout has happened yet (generation 0).
test("a token issued before this change (no generation in it) still works until the next logout", async () => {
  const payload = `${Buffer.from("captain").toString("base64url")}.${Date.now() + 86_400_000}`;
  const sig = crypto.createHmac("sha256", getSettings().secret).update(`session:${payload}`).digest("base64url");
  const old = `${COOKIE}=${payload}.${sig}`;
  assert.equal(await get(old), 200);
  await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: old, "x-animearr": "1" } });
  assert.equal(await get(old), 401);
});

test("a session token used after logout is refused, on every browser", async () => {
  const phone = await login();
  const pc = await login();
  assert.equal(await get(phone), 200);
  const out = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: phone, "x-animearr": "1" } });
  assert.equal(out.statusCode, 200, out.body);
  assert.equal(await get(phone), 401, "the logged-out token is dead even if a copy was kept");
  assert.equal(await get(pc), 401, "logout signs out every session");
  assert.equal(await get(await login()), 200, "a new login works");
});

test("a password change ends the other sessions; the browser that changed it stays in", async () => {
  const a = await login();
  const b = await login();
  const r = await app.inject({
    method: "PUT",
    url: "/api/auth/account",
    headers: { cookie: a, "x-animearr": "1" },
    payload: { currentPassword: "pw-test-1", password: "pw-test-2-long" },
  });
  assert.equal(r.statusCode, 200, r.body);
  const a2 = String([r.headers["set-cookie"]].flat()[0]).split(";")[0];
  assert.equal(await get(b), 401);
  assert.equal(await get(a), 401);
  assert.equal(await get(a2), 200);
  await setAccount("captain", "pw-test-1");
});

test("the API key can't log the owner out", async () => {
  const s = await login();
  const r = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { "x-api-key": getSettings().apiKey } });
  assert.equal(r.statusCode, 403, "logout isn't an API-key route");
  assert.equal(await get(s), 200);
});

test("review A11: with the database flagged corrupt, logout still logs this browser out and says what it couldn't do", async () => {
  const s = await login();
  const { dbState } = await import("../server/system/db.js");
  dbState.corrupt = true;
  try {
    const r = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: s, "x-animearr": "1" } });
    assert.equal(r.statusCode, 200, r.body);
    const cleared = [r.headers["set-cookie"]].flat().map(String);
    assert.ok(
      cleared.some((c) => c.startsWith(`${COOKIE}=;`)),
      "the session cookie is cleared",
    );
    const body = r.json() as { ok: boolean; otherSessionsEnded: boolean; warning?: string };
    assert.equal(body.otherSessionsEnded, false);
    assert.match(String(body.warning), /other browsers|database/i);
  } finally {
    dbState.corrupt = false;
  }
});

test("review A9: a backup restore doesn't bring back sessions that were logged out", async () => {
  const { db, CONFIG_DIR } = await import("../server/system/db.js");
  const { forgetSettingsCache, keepSessionsEndedAcrossRestore } = await import("../server/system/settings.js");
  const row = () => (db.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as { value: string }).value;
  // What a restore does to settings: the backup's row (older generation, its secret) comes back, then a restart.
  const restore = (value: string) => {
    db.prepare("UPDATE settings SET value = ? WHERE key = 'settings'").run(value);
    forgetSettingsCache();
  };
  const logout = (cookie: string) => app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie, "x-animearr": "1" } });

  // The hole: a token logged out after the backup was taken is valid again once the backup is back.
  const stolen = await login();
  const backup = row();
  await logout(stolen);
  assert.equal(await get(stolen), 401);
  restore(backup);
  assert.equal(await get(stolen), 200, "this is what a restore did without the floor");

  // The restore routes write a floor first: the restored generation is raised past it.
  const stolen2 = await login();
  const backup2 = row();
  await logout(stolen2);
  keepSessionsEndedAcrossRestore();
  restore(backup2);
  assert.equal(await get(stolen2), 401, "still logged out after the restore");
  assert.equal(await get(stolen), 401, "and so is every older session");
  assert.equal(fs.existsSync(path.join(CONFIG_DIR, "session-floor")), false, "the floor is used up once saved");
  assert.equal(await get(await login()), 200, "a new login works");
});

test("the restore routes write the floor before restoring", async () => {
  const { CONFIG_DIR } = await import("../server/system/db.js");
  const r = await app.inject({
    method: "POST",
    url: "/api/system/restore",
    headers: { cookie: await login(), "x-animearr": "1" },
    payload: { name: "no-such-backup.db", password: "pw-test-1" },
  });
  assert.notEqual(r.statusCode, 200);
  // A failed restore leaves the floor (a partly applied restore must not bring sessions back): the next load uses it.
  const floorFile = path.join(CONFIG_DIR, "session-floor");
  assert.equal(fs.existsSync(floorFile), true);
  fs.rmSync(floorFile, { force: true });
});
