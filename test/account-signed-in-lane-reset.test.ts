/**
 * Follow-up to the signed-in lane reset: the password-change route, with no device cookie, called loginSucceeded with
 * device=null, so the shared "signed-in" lane was never cleared after a correct current password. Now it is, and a wrong
 * guess (a stolen session) still backs off.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-acctlane-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";
delete process.env.TRUST_PROXY;

const { setAccount } = await import("../server/system/settings.js");
await setAccount("captain", "pw-test-1");
const { app } = await import("../server/index.js");
const { resetOwnerGuessBudget } = await import("../server/system/auth.js");

const addr = "198.51.100.89";
resetOwnerGuessBudget();
const signedIn = await app.inject({
  method: "POST",
  url: "/api/auth/login",
  remoteAddress: addr,
  headers: { "x-animearr": "1" },
  payload: { username: "captain", password: "pw-test-1" },
});
assert.equal(signedIn.statusCode, 200);
// Session cookie only (no device cookie): the shared "signed-in" entry.
const cookie = String([signedIn.headers["set-cookie"]].flat()[0]).split(";")[0];

// A username-only change: no new password, so the password stays pw-test-1.
const change = (currentPassword: string) =>
  app.inject({
    method: "PUT",
    url: "/api/auth/account",
    remoteAddress: addr,
    headers: { cookie, "x-animearr": "1" },
    payload: { currentPassword, username: "captain" },
  });

test("a correct current password on the account route resets the signed-in lane's back-off", async () => {
  for (let i = 0; i < 4; i++) assert.equal((await change(`bad${i}`)).statusCode, 403);
  assert.equal((await change("pw-test-1")).statusCode, 200); // the 5th try: still free
  // Without the reset these four would be tries 6 to 9 and hit back-off.
  for (let i = 0; i < 4; i++) assert.equal((await change(`again${i}`)).statusCode, 403, `wrong try ${i} after the reset`);
});

test("control: a stolen session guessing the current password still backs off", async () => {
  const codes: number[] = [];
  for (let i = 0; i < 8; i++) codes.push((await change(`g${i}`)).statusCode);
  assert.ok(codes.includes(429), "past the free tries the lane backs off");
});
