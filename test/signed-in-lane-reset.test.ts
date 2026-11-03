/**
 * Blind review round 3, last Low: a correct password on the signed-in restore and backup-download routes never reset
 * that lane's back-off, and the lane's entry never expired (the login route clears and expires its own). Now a correct
 * password resets it, an idle entry is forgotten after the same 30 minutes, and a wrong guess still backs off.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-lanereset-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";
delete process.env.TRUST_PROXY;

const { setAccount } = await import("../server/system/settings.js");
await setAccount("captain", "pw-test-1");
const { app } = await import("../server/index.js");
const { resetOwnerGuessBudget } = await import("../server/system/auth.js");

const addr = "198.51.100.88";
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

// Past the throttle and the password, then refused by the restore itself (nothing restarts).
const restore = (password: string) =>
  app.inject({
    method: "POST",
    url: "/api/system/restore",
    remoteAddress: addr,
    headers: { cookie, "x-animearr": "1" },
    payload: { name: "no-such-backup.db", password },
  });

test("a correct password on restore resets the signed-in lane's back-off", async () => {
  for (let i = 0; i < 4; i++) assert.equal((await restore(`bad${i}`)).statusCode, 403);
  const ok = await restore("pw-test-1"); // the 5th try: still free
  assert.match(ok.body, /Unknown backup/);
  // Without the reset these four would be tries 6 to 9 and hit back-off.
  for (let i = 0; i < 4; i++) assert.equal((await restore(`again${i}`)).statusCode, 403, `wrong try ${i} after the reset`);
});

test("control: a stolen session guessing wrong still backs off", async () => {
  const codes: number[] = [];
  for (let i = 0; i < 8; i++) codes.push((await restore(`g${i}`)).statusCode);
  assert.ok(codes.includes(429), "past the free tries the lane backs off");
});

test("an idle signed-in entry is forgotten after 30 minutes", async () => {
  assert.equal((await restore("still-bad")).statusCode, 429, "still waiting");
  const real = Date.now();
  const spy = mock.method(Date, "now", () => real + 31 * 60_000);
  try {
    // A fresh entry after the window: its free tries are back, so several wrong guesses in a row stay 403, not 429.
    for (let i = 0; i < 3; i++) assert.equal((await restore(`late${i}`)).statusCode, 403, `try ${i} after the window`);
  } finally {
    spy.mock.restore();
  }
});
