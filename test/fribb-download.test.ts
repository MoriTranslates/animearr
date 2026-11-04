/** The AniList mapping download (L20): a captive-portal 200 must never be saved over (or instead of) a real mapping. Mocks only. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-fribb-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { CACHE_DIR } = await import("../server/system/db.js");
const { fribb } = await import("../server/metadata/covers.js");

const FILE = path.join(CACHE_DIR, "anime-list-full.json");
const realFetch = globalThis.fetch;
function serve(body: string) {
  globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
}

test("a captive-portal 200 is not saved as the AniList mapping", async () => {
  fs.rmSync(FILE, { force: true });
  serve("<html><body>Please log in to the wifi</body></html>");
  try {
    await assert.rejects(() => fribb(), /AniList mapping/);
    assert.equal(fs.existsSync(FILE), false, "junk must not land in the cache");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a junk reply leaves the last good mapping in place, and a real one replaces it", async () => {
  fs.writeFileSync(FILE, JSON.stringify([{ anidb_id: 1, anilist_id: 10 }]));
  const old = new Date(Date.now() - 30 * 86_400_000);
  fs.utimesSync(FILE, old, old); // stale, so a download is tried
  serve("<html>portal</html>");
  try {
    assert.equal((await fribb()).anidbToAnilist.get(1), 10, "kept the old file");
    assert.match(fs.readFileSync(FILE, "utf8"), /anidb_id/);
    serve(JSON.stringify([{ anidb_id: 2, anilist_id: 20 }]));
    const m = await fribb();
    assert.equal(m.anidbToAnilist.get(2), 20, "a valid download is saved");
  } finally {
    globalThis.fetch = realFetch;
  }
});
