/**
 * Blind review round 2, R4: the password-checked backup routes (restore, restore an upload, download with the password)
 * were throttled on the anonymous real-name entry for the caller's address. Behind a proxy everyone shares that
 * address, so a flood guessing the real user name kept it in back-off and a signed-in owner got 429 on restore exactly
 * when they might need it. They now use the signed-in lane the password change uses (the device, or one "signed-in"
 * entry), never the anonymous one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-restorelane-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";
delete process.env.TRUST_PROXY;

const { setAccount } = await import("../server/system/settings.js");
await setAccount("captain", "pw-test-1");
const { app } = await import("../server/index.js");
const { resetOwnerGuessBudget } = await import("../server/system/auth.js");

const proxy = "198.51.100.77"; // everyone behind one reverse proxy shares it

const login = (username: string, password: string) =>
  app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress: proxy,
    headers: { "x-animearr": "1" },
    payload: { username, password },
  });

const post = (url: string, cookie: string, payload: object) =>
  app.inject({ method: "POST", url, remoteAddress: proxy, headers: { cookie, "x-animearr": "1" }, payload });

// The owner signs in (session cookie only, no device cookie: the "signed-in" entry), then someone behind the same proxy
// floods the real user name, keeping the address's real-name entry in back-off for the rest of the file.
resetOwnerGuessBudget();
const signedIn = await login("captain", "pw-test-1");
assert.equal(signedIn.statusCode, 200);
const cookie = String([signedIn.headers["set-cookie"]].flat()[0]).split(";")[0];
const flood: number[] = [];
for (let i = 0; i < 12; i++) flood.push((await login("captain", `guess${i}`)).statusCode);
assert.ok(flood.includes(429), "the flood put the address's real-name entry in back-off");

test("review R4: a flood on the shared address doesn't stop a signed-in owner downloading a backup", async () => {
  assert.equal((await login("captain", "pw-test-1")).statusCode, 429, "an anonymous login from the address waits");
  const r = await post("/api/system/backup/download", cookie, { password: "pw-test-1" });
  assert.equal(r.statusCode, 200, r.body.slice(0, 200));
});

test("review R4: a flood on the shared address doesn't stop a signed-in owner restoring", async () => {
  // An unknown backup name: past the throttle and the password, refused by the restore itself (nothing restarts).
  const r = await post("/api/system/restore", cookie, { name: "no-such-backup.db", password: "pw-test-1" });
  assert.notEqual(r.statusCode, 429, r.body);
  assert.match(r.body, /Unknown backup/);
  // An expired upload token: the same for restoring an upload.
  const u = await post("/api/system/backup/restore-upload", cookie, { token: "nope", password: "pw-test-1" });
  assert.notEqual(u.statusCode, 429, u.body);
  assert.match(u.body, /expired/);
});

test("control: a stolen session guessing the password on restore still backs off", async () => {
  const codes: number[] = [];
  for (let i = 0; i < 8; i++)
    codes.push((await post("/api/system/restore", cookie, { name: "no-such-backup.db", password: `g${i}` })).statusCode);
  assert.equal(codes[0], 403, "a wrong password is refused");
  assert.ok(codes.includes(429), "past the free tries the signed-in entry backs off");
});
