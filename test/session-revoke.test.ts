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

test("review R2: a restore refused before it changes anything writes no floor and logs nobody out", async () => {
  const { BACKUP_DIR, CONFIG_DIR } = await import("../server/system/db.js");
  const { forgetSettingsCache } = await import("../server/system/settings.js");
  const floorFile = path.join(CONFIG_DIR, "session-floor");
  const damaged = path.join(BACKUP_DIR, "animearr-manual-2026-11-03T00-00-00.db");
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.writeFileSync(damaged, "not a database");
  try {
    for (const name of ["no-such-backup.db", path.basename(damaged)]) {
      const cookie = await login();
      const r = await app.inject({
        method: "POST",
        url: "/api/system/restore",
        headers: { cookie, "x-animearr": "1" },
        payload: { name, password: "pw-test-1" },
      });
      assert.ok(r.statusCode >= 400, `${name}: refused (${r.statusCode})`);
      assert.equal(fs.existsSync(floorFile), false, `${name}: no floor written`);
      forgetSettingsCache(); // as after the next restart
      assert.equal(await get(cookie), 200, `${name}: still logged in after a restart`);
    }
  } finally {
    fs.rmSync(damaged, { force: true });
    fs.rmSync(floorFile, { force: true });
  }
});

test("review R2: the floor is written after the checks, and if writing it fails nothing is restored", async () => {
  const { backupNow, USER_DB } = await import("../server/system/db.js");
  const { restoreBackup } = await import("../server/system/backupTransfer.js");
  const name = backupNow("manual", "r2");
  assert.ok(name, "a valid backup to restore");
  const before = fs.readFileSync(USER_DB);
  let called = 0;
  assert.throws(
    () =>
      restoreBackup(name, () => {
        called++;
        throw new Error("disk full");
      }),
    /disk full.*nothing was changed/,
  );
  assert.equal(called, 1, "reached only after the backup passed its checks");
  assert.equal(fs.existsSync(`${USER_DB}.restore-tmp`), false, "the copy is cleaned up");
  assert.ok(fs.readFileSync(USER_DB).equals(before), "the live database is untouched");
  assert.equal(await get(await login()), 200, "and still open");

  // The uploaded-backup restore: same order, same outcome.
  const { createBackup, parseBackup, restoreUploaded } = await import("../server/system/backupTransfer.js");
  const { KEY_FILE } = await import("../server/system/secretbox.js");
  const parsed = await parseBackup((await createBackup()).data);
  const keyBefore = fs.readFileSync(KEY_FILE);
  let uploadCalled = 0;
  assert.throws(
    () =>
      restoreUploaded(parsed, () => {
        uploadCalled++;
        throw new Error("disk full");
      }),
    /disk full.*nothing was changed/,
  );
  assert.equal(uploadCalled, 1);
  for (const f of [`${USER_DB}.restore-tmp`, `${KEY_FILE}.restore-tmp`]) assert.equal(fs.existsSync(f), false, `${f} cleaned up`);
  assert.ok(fs.readFileSync(KEY_FILE).equals(keyBefore), "the key is untouched");
  assert.equal(await get(await login()), 200, "the database is still open");
});

test("review R8: a floor write that fails midway leaves the old floor intact and no temp file", async () => {
  const { CONFIG_DIR } = await import("../server/system/db.js");
  const { keepSessionsEndedAcrossRestore } = await import("../server/system/settings.js");
  const floorFile = path.join(CONFIG_DIR, "session-floor");
  fs.writeFileSync(floorFile, "7");
  const realRename = fs.renameSync;
  fs.renameSync = () => {
    throw new Error("power cut");
  };
  try {
    assert.throws(() => keepSessionsEndedAcrossRestore(), /power cut/);
  } finally {
    fs.renameSync = realRename;
  }
  try {
    assert.equal(fs.readFileSync(floorFile, "utf8"), "7", "the old floor is untouched");
    const leftovers = fs.readdirSync(CONFIG_DIR).filter((f) => f.startsWith("session-floor") && f !== "session-floor");
    assert.deepEqual(leftovers, [], "no temp file left behind");
  } finally {
    fs.rmSync(floorFile, { force: true });
  }
});

test("review R8: an empty or garbage floor file fails safe: old sessions stay ended", async () => {
  const { CONFIG_DIR } = await import("../server/system/db.js");
  const { forgetSettingsCache } = await import("../server/system/settings.js");
  const floorFile = path.join(CONFIG_DIR, "session-floor");
  try {
    for (const junk of ["", "garbage", "12abc", "-3", "1.5", String.fromCharCode(0, 0)]) {
      const old = await login();
      assert.equal(await get(old), 200);
      fs.writeFileSync(floorFile, junk);
      forgetSettingsCache(); // as after the next restart
      assert.equal(await get(old), 401, `floor ${JSON.stringify(junk)}: old session ended`);
      assert.equal(await get(await login()), 200, "a new login works");
    }
  } finally {
    fs.rmSync(floorFile, { force: true });
  }
});

test("blind review round 3 L2: restoring over a corrupt database whose generation can't be read ends every session", async () => {
  const { db, dbState, CONFIG_DIR } = await import("../server/system/db.js");
  const { forgetSettingsCache, keepSessionsEndedAcrossRestore } = await import("../server/system/settings.js");
  const floorFile = path.join(CONFIG_DIR, "session-floor");
  const row = () => (db.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as { value: string }).value;
  const setRow = (value: string) => db.prepare("UPDATE settings SET value = ? WHERE key = 'settings'").run(value);
  const logout = (cookie: string) => app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie, "x-animearr": "1" } });

  await logout(await login()); // the generation is past 0, as on any install that has logged out once
  const atBackup = await login();
  const backup = row();
  await logout(atBackup); // logged out after the backup was taken
  const later = await login();
  await logout(later); // and one more generation that only the (now corrupt) live database knew
  const current = await login(); // a session of the live generation itself
  // The live database fails its check and its settings row can't be read: the live generation is unknown.
  dbState.corrupt = true;
  setRow("enc:v1:AAAA");
  forgetSettingsCache();
  try {
    keepSessionsEndedAcrossRestore();
  } finally {
    dbState.corrupt = false;
  }
  try {
    setRow(backup); // the restore swaps the backup in, then the app restarts
    forgetSettingsCache();
    assert.equal(await get(atBackup), 401, "a session logged out after the backup stays ended");
    assert.equal(await get(later), 401, "so does one from a generation only the corrupt database knew");
    assert.equal(await get(current), 401, "and one of the live generation (whatever number it had)");
    assert.equal(fs.existsSync(floorFile), false, "the floor is used up once saved");
    assert.equal(await get(await login()), 200, "a new login works");
  } finally {
    fs.rmSync(floorFile, { force: true });
  }
});

test("blind review round 3 L2: a floor lower than the restored generation still ends the restored generation's sessions", async () => {
  const { CONFIG_DIR } = await import("../server/system/db.js");
  const { forgetSettingsCache } = await import("../server/system/settings.js");
  const floorFile = path.join(CONFIG_DIR, "session-floor");
  const old = await login();
  assert.equal(await get(old), 200);
  fs.writeFileSync(floorFile, "1"); // written from a generation that was too low (the corrupt-database case)
  try {
    forgetSettingsCache(); // as after the restart that follows a restore
    assert.equal(await get(old), 401, "the floor never lowers protection: the restored generation is raised past itself");
    assert.equal(await get(await login()), 200, "a new login works");
  } finally {
    fs.rmSync(floorFile, { force: true });
  }
});

test("blind review round 3 L1: both restores take the floor step as a required argument", async () => {
  const { restoreBackup, restoreUploaded } = await import("../server/system/backupTransfer.js");
  // A parameter with a default doesn't count in a function's length; a required one does.
  assert.equal(restoreBackup.length, 2, "restoreBackup(name, beforeSwap): beforeSwap has no do-nothing default");
  assert.equal(restoreUploaded.length, 2, "restoreUploaded(backup, beforeSwap): beforeSwap has no do-nothing default");
});

test("blind review round 3 L3: the floor's folder is flushed after the rename (where the platform can), before any swap", async () => {
  const { CONFIG_DIR } = await import("../server/system/db.js");
  const { keepSessionsEndedAcrossRestore } = await import("../server/system/settings.js");
  const floorFile = path.join(CONFIG_DIR, "session-floor");
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const real = { openSync: fs.openSync, fsyncSync: fs.fsyncSync, closeSync: fs.closeSync, renameSync: fs.renameSync };
  const run = (platform: string) => {
    const events: string[] = [];
    const DIR_FD = 987654;
    Object.defineProperty(process, "platform", { ...realPlatform, value: platform });
    fs.openSync = ((p: fs.PathLike, ...rest: unknown[]) => {
      if (path.resolve(String(p)) === path.resolve(CONFIG_DIR)) {
        events.push("open dir");
        return DIR_FD;
      }
      return (real.openSync as (...a: unknown[]) => number)(p, ...rest);
    }) as typeof fs.openSync;
    fs.fsyncSync = ((fd: number) => {
      if (fd === DIR_FD) return void events.push("fsync dir");
      real.fsyncSync(fd);
    }) as typeof fs.fsyncSync;
    fs.closeSync = ((fd: number) => {
      if (fd === DIR_FD) return void events.push("close dir");
      real.closeSync(fd);
    }) as typeof fs.closeSync;
    fs.renameSync = ((a: fs.PathLike, b: fs.PathLike) => {
      if (String(b) === floorFile) events.push("rename floor");
      real.renameSync(a, b);
    }) as typeof fs.renameSync;
    try {
      keepSessionsEndedAcrossRestore();
    } finally {
      Object.assign(fs, real);
      Object.defineProperty(process, "platform", realPlatform);
      fs.rmSync(floorFile, { force: true });
    }
    return events;
  };
  assert.deepEqual(run("linux"), ["rename floor", "open dir", "fsync dir", "close dir"], "Linux: the rename is flushed");
  assert.deepEqual(run("win32"), ["rename floor"], "Windows can't open a folder to flush it; skipped (see the comment)");
});
