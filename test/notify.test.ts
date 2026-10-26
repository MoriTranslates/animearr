/** Notifications: which activity entries notify, the bell, Discord/ntfy sending (mocked fetch only). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-test-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { patchSettings, updateSettings, getSettings } = await import("../server/settings.js");
const { eventOf, send, bell } = await import("../server/notify.js");
const { logDecision } = await import("../server/activity.js");

test("which activity entries notify", () => {
  assert.equal(eventOf("grab", "Sent X", {}), "grabbed");
  assert.equal(eventOf("import", "Asked Sonarr to import", { grabId: 1 }), null);
  assert.equal(eventOf("import", "Imported ✓ as S01E01", { grabId: 1, final: true }), "imported");
  assert.equal(eventOf("verify-fail", "bad", {}), "failed");
  assert.equal(eventOf("info", 'Grabs paused by the download-folder rule "Hard"', {}), "paused");
  assert.equal(eventOf("info", "Synced", {}), null);
});

test("the bell records them; Discord and ntfy get them when set; events can be switched off", async () => {
  logDecision("grab", { title: "Frieren", why: "Sent Frieren S01E05 to SABnzbd" });
  assert.equal(bell().unread, 1);
  updateSettings({ notify: { discordWebhook: "https://example.com/not-discord", ntfyUrl: "http://169.254.169.254/x" } });
  assert.equal(getSettings().notify.discordWebhook, "", "only Discord webhook URLs");
  assert.equal(getSettings().notify.ntfyUrl, "", "no link-local addresses");
  patchSettings((s) => ({ ...s, notify: { ...s.notify, discordWebhook: "https://discord.com/api/webhooks/1/abc", ntfyUrl: "https://ntfy.sh/animearr", ntfyToken: "tk" } }));
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response("", { status: 200 }))) as unknown as typeof globalThis.fetch;
  const out = await send("imported", "Frieren", "Imported S01E05", { fetch });
  assert.deepEqual(out.map((o) => o.channel), ["discord", "ntfy"]);
  assert.equal((calls[1].init.headers as Record<string, string>).Authorization, "Bearer tk");
  patchSettings((s) => ({ ...s, notify: { ...s.notify, events: { ...s.notify.events, imported: false } } }));
  assert.deepEqual(await send("imported", "x", "y", { fetch }), []);
});
