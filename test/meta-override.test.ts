/** "Episode info source": a per-season TMDB override that only the episode plots and thumbnails read (mocked TMDB). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-test-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { patchSettings } = await import("../server/settings.js");
const { db } = await import("../server/db.js");
const { enrichEpisodes, tmdbTarget, realMetaDeps } = await import("../server/episodemeta.js");
const { metaOverrides, registerMetaOverrideApi, setMetaOverride } = await import("../server/metaoverride.js");

const rows = [
  { tvdb_season: "1", tvdb_offset: 0, episodes: 13, tmdb_tv: 100, tmdb_season: 1, tmdb_offset: 0 },
  { tvdb_season: "2", tvdb_offset: 0, episodes: 13, tmdb_tv: 42713, tmdb_season: 2, tmdb_offset: 0 },
];

test("the override replaces the catalog mapping for its season only, with the offset applied", () => {
  const o = new Map([[2, { tmdbTv: 72041, tmdbSeason: 1, tmdbOffset: 3, setAt: 0 }]]);
  assert.deepEqual(tmdbTarget(rows, 2, 4, null, o), { tv: 72041, season: 1, episode: 7 });
  assert.deepEqual(tmdbTarget(rows, 1, 4, null, o), { tv: 100, season: 1, episode: 4 }, "season 1 keeps the catalog mapping");
  assert.deepEqual(tmdbTarget(rows, 2, 4, null), { tv: 42713, season: 2, episode: 4 }, "no override: as before");
  assert.deepEqual(tmdbTarget(rows, 2, 4, null, new Map([[2, { tmdbTv: 5, tmdbSeason: 0, tmdbOffset: -1, setAt: 0 }]])), { tv: 5, season: 0, episode: 3 }, "negative offset");
});

test("enrichEpisodes asks TMDB for the override's show and season, then goes back to the catalog once reset", async () => {
  patchSettings((s) => ({ ...s, metadata: { ...s.metadata, tmdbKey: "test-tmdb-key" } }));
  db.prepare("INSERT INTO entries (anilist_id, tvdb_id, tvdb_season, tvdb_offset, episodes, tmdb_tv, tmdb_season, tmdb_offset, fetched_at) VALUES (1, 78777, '2', 0, 13, 42713, 2, 0, 0)").run();
  const asked: string[] = [];
  const fetchMock = (async (url: string) => {
    const m = /\/tv\/(\d+)\/season\/(\d+)/.exec(url);
    asked.push(`${m?.[1]}:${m?.[2]}`);
    if (m?.[1] === "42713") return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ episodes: [{ episode_number: 2, overview: "Chronicles two", still_path: "/c2.jpg" }] }));
  }) as unknown as typeof fetch;
  const deps = { ...realMetaDeps, fetch: fetchMock, sleep: async () => {}, sonarrEpisodes: async () => [] };
  const mk = () => [{ episodes: [{ season: 2, episode: 1 } as never] }];
  setMetaOverride(78777, 2, { tmdbTv: 72041, tmdbSeason: 1, tmdbOffset: 1 });
  let files = mk();
  await enrichEpisodes(78777, null, files, { plot: true, still: true }, deps);
  assert.deepEqual(asked, ["72041:1"]);
  assert.equal((files[0].episodes[0] as { plot?: string }).plot, "Chronicles two");
  const { clearMetaOverride } = await import("../server/metaoverride.js");
  clearMetaOverride(78777, 2);
  files = mk();
  await enrichEpisodes(78777, null, files, { plot: true, still: true }, deps);
  assert.deepEqual(asked, ["72041:1", "42713:2"], "reset: the catalog mapping again");
  assert.equal((files[0].episodes[0] as { plot?: string }).plot, undefined);
  assert.equal(metaOverrides(78777).size, 0);
});

test("routes: validate ids and body, save, read back, reset; the TMDB helper needs a key", async () => {
  let key = "";
  const app = Fastify();
  const fetchMock = (async (url: string) => {
    if (url.includes("/search/tv")) return new Response(JSON.stringify({ results: [{ id: 72041, name: "Chronicles", first_air_date: "1998-04-01" }] }));
    if (/\/tv\/72041\?/.test(url)) return new Response(JSON.stringify({ seasons: [{ season_number: 1, episode_count: 27 }] }));
    return new Response(JSON.stringify({ episodes: [{ episode_number: 1, name: "The Knight" }] }));
  }) as unknown as typeof fetch;
  registerMetaOverrideApi(app, { fetch: fetchMock, key: () => key, writable: () => {} });
  const call = async (method: "GET" | "PUT" | "DELETE", url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };
  const u = "/api/series/555/meta-override/2";
  assert.equal((await call("GET", u)).body.override, null);
  assert.equal((await call("GET", "/api/series/abc/meta-override/2")).status, 400);
  assert.equal((await call("GET", "/api/series/555/meta-override/-1")).status, 400);
  assert.equal((await call("PUT", u, { tmdbSeason: 1 })).status, 400, "no show id");
  assert.equal((await call("PUT", u, { tmdbTv: 1.5, tmdbSeason: 1 })).status, 400);
  assert.equal((await call("PUT", u, { tmdbTv: 9, tmdbSeason: 1, tmdbOffset: "x" })).status, 400);
  const put = await call("PUT", u, { tmdbTv: 72041, tmdbSeason: 1 });
  assert.equal(put.status, 200);
  assert.deepEqual({ ...put.body.override, setAt: 0 }, { tmdbTv: 72041, tmdbSeason: 1, tmdbOffset: 0, setAt: 0 }, "offset defaults to 0");
  assert.equal((await call("GET", "/api/series/555/meta-override/1")).body.override, null, "other seasons untouched");
  assert.equal((await call("DELETE", u)).body.override, null);
  assert.equal((await call("GET", u)).body.override, null);
  assert.equal((await call("GET", "/api/tmdb/search?q=lodoss")).status, 409, "no TMDB key");
  key = "test-tmdb-key";
  assert.equal((await call("GET", "/api/tmdb/search?q=")).status, 400);
  const hits = (await call("GET", "/api/tmdb/search?q=lodoss")).body;
  assert.deepEqual(hits[0], { id: 72041, name: "Chronicles", year: 1998, seasons: [{ season: 1, episodes: 27 }] });
  const tv = (await call("GET", "/api/tmdb/tv/72041?season=1")).body;
  assert.equal(tv.titles[0].name, "The Knight");
  await app.close();
});

test("only metadata reads the override table", () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server");
  const readers: string[] = [];
  const walk = (d: string) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (f.isDirectory()) walk(path.join(d, f.name));
      else if (f.name.endsWith(".ts") && /meta_overrides|metaoverride\.js/.test(fs.readFileSync(path.join(d, f.name), "utf8"))) readers.push(f.name);
    }
  };
  walk(dir);
  assert.deepEqual(readers.sort(), ["db.ts", "episodemeta.ts", "index.ts", "metaoverride.ts"]);
});
