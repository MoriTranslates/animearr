/** The bell flags setup problems (playtest: "Needs action (0)" while the client couldn't be reached). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-setuphealth-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { setupProblems, withSetupProblems, resetSetupProblems } = await import("../server/setupHealth.js");

test("a failing download client and a failed metadata download need action; fine ones don't", async () => {
  resetSetupProblems();
  const overview = async () =>
    ({
      clients: [
        { key: "qbittorrent", name: "qBittorrent", configured: true, ok: false, error: "AnimeArr couldn't reach qBittorrent at example.invalid:8080.", enabled: true },
        { key: "sabnzbd", name: "SABnzbd", configured: false, ok: null, error: null },
        { key: "c1", name: "NZBGet", configured: true, ok: true, error: null },
      ],
      mediaServers: [{ configured: false, ok: null, error: null }],
    }) as never;
  const jobs = () => [
    { name: "anidb", state: "error", detail: "AniDB titles download failed (HTTP 403)", finishedAt: 1 },
    { name: "rss", state: "error", detail: "whatever", finishedAt: 1 },
    { name: "catalog", state: "done", detail: "ok", finishedAt: 1 },
  ];
  const p = await setupProblems(1_000_000, { overview, jobs });
  assert.deepEqual(p.map((x) => x.title), ["qBittorrent isn't working", "AniDB titles download failed"]);
  assert.ok(p.every((x) => x.id < 0 && x.action));
  assert.equal(p[0].fixes[0].action, "testConnection");
  assert.match(p[1].body, /AniDB refused/);
  const b = withSetupProblems({ unread: 0, needs: 1, items: [{ id: 5 }] }, p);
  assert.equal(b.needs, 3);
  assert.equal(b.items.length, 3);
});
