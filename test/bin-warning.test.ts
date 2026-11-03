/**
 * Blind review L7: a recycling bin AnimeArr refuses (e.g. inside a library folder, which used to be accepted) is
 * reported where the user sees it (the status warnings), and Replace season stops up front with that reason instead
 * of trying every episode.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-binwarn-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";

const { setAccount, patchSettings } = await import("../server/system/settings.js");
await setAccount("captain", "pw-test-1");
const { cache, db } = await import("../server/system/db.js");
const { app } = await import("../server/index.js");
const { importAndVerify } = await import("../server/grabs/pipeline.js");
type Deps = import("../server/grabs/pipelineState.js").PipelineDeps;
type Row = import("../server/grabs/pipelineState.js").GrabRow;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-binwarn-f-"));
const LIB = path.join(tmp, "lib");

before(() => {
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, title, year, series_type, path, root_folder, monitored, synced_at) VALUES (77, 283963, 'Absolute Duo', 2015, 'anime', '/media/Anime/Absolute Duo', '/media/Anime', 1, 0)",
    )
    .run();
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/Anime"],
    localPathMappings: [{ from: "/media/Anime", to: LIB }],
    importer: { ...s.importer, engine: "animearr", allowReal: true, realBudget: -1 },
    media: { ...s.media, recycleBin: "/media/Anime/.recycle" }, // inside the library: refused
  }));
});

async function session() {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { "x-animearr": "1" },
    payload: { username: "captain", password: "pw-test-1" },
  });
  return [login.headers["set-cookie"]]
    .flat()
    .filter(Boolean)
    .map((c) => String(c).split(";")[0])
    .join("; ");
}

test("a refused recycling bin shows as a status warning, with the reason", async () => {
  const cookie = await session();
  const r = await app.inject({ method: "GET", url: "/api/status", headers: { cookie } });
  const warnings = (JSON.parse(r.body) as { warnings: string[] }).warnings;
  assert.ok(
    warnings.some((w) => /recycling bin .*library folder/i.test(w)),
    JSON.stringify(warnings),
  );
});

test("Replace season stops up front with the bin's reason; nothing is tried", async () => {
  const id = Number(
    db
      .prepare(
        "INSERT INTO grabs (at, updated_at, tvdb_id, series_id, episode_ids, release, guid, indexer_id, protocol, client, client_ref, state, dry_run, origin, why, candidates, purpose) VALUES (1, 1, 283963, 77, '[]', 'R', 'g', 9, 'torrent', 'qbittorrent', 'h', 'importing', 0, 'manual', 'test', '[]', 'replace')",
      )
      .run().lastInsertRowid,
  );
  let previews = 0;
  const deps = {
    sonarr: { preview: async () => (previews++, []) },
    localPath: (p: string) => p,
    probe: async () => ({}),
    sleep: async () => undefined,
  } as unknown as Deps;
  await importAndVerify(db.prepare("SELECT * FROM grabs WHERE id = ?").get(id) as unknown as Row, "/data/x", deps);
  const g = db.prepare("SELECT state, error FROM grabs WHERE id = ?").get(id) as { state: string; error: string };
  assert.equal(g.state, "needs-attention");
  assert.match(g.error, /usable recycling bin.*library folder/i);
  assert.equal(previews, 0, "nothing in the download was even listed");
});
