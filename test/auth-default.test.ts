import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-auth-"));
process.env.ANIMEARR_NO_LOCK = "1";
const { ensureDefaultAccount, usingDefaultPassword, setAccount, getSettings, checkPassword } = await import("../server/settings.js");

test("fresh install gets admin / animearr, flagged as the default password until changed", async () => {
  assert.equal(await ensureDefaultAccount(), true);
  assert.equal(getSettings().auth.username, "admin");
  assert.equal(await checkPassword("animearr", getSettings().auth.passwordHash), true);
  assert.equal(await usingDefaultPassword(), true);
  assert.equal(await ensureDefaultAccount(), false, "never overwrites an existing account");
  await setAccount("admin", "something-else-123");
  assert.equal(await usingDefaultPassword(), false);
  assert.equal(getSettings().auth.bypassLocal, false, "no-password-on-LAN stays off unless the user ticks it");
});
