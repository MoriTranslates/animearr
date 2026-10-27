import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-auth-"));
process.env.ANIMEARR_NO_LOCK = "1";
const { usingDefaultPassword, setAccount, getSettings, DEFAULT_LOGIN } = await import("../server/settings.js");

test("fresh install has NO account (created in the browser); an old default password is still flagged until changed", async () => {
  assert.equal(getSettings().auth.passwordHash, "", "no default login on a fresh install");
  await setAccount(DEFAULT_LOGIN.username, DEFAULT_LOGIN.password);
  assert.equal(await usingDefaultPassword(), true);
  await setAccount("admin", "something-else-123");
  assert.equal(await usingDefaultPassword(), false);
  assert.equal(getSettings().auth.bypassLocal, false, "no-password-on-LAN stays off unless the user ticks it");
});
