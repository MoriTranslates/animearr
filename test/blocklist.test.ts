/** The blocklist page's API: list (filter by show, pages), remove one, remove many, remove a show's entries. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-test-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/db.js");
const { registerBlocklistApi } = await import("../server/blocklist.js");
const { isBlocked } = await import("../server/pipeline.js");

const app = Fastify();
registerBlocklistApi(app);
const call = async (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
const ids: Record<string, number> = {};

before(() => {
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, synced_at) VALUES (1, 11, 'Alpha Show', '/m/a', 0, 0)").run();
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, synced_at) VALUES (2, 22, 'Beta Show', '/m/b', 0, 0)").run();
  const ins = db.prepare("INSERT INTO blocklist (guid, release, tvdb_id, movie_id, reason, at, protocol, indexer) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const [k, rel, tvdb, movie, reason, at, proto, ix] of [
    ["a1", "Alpha.S01E01.v1", 11, null, "contained Episode 01.mkv.lnk", 1000, "usenet", "Nzb.su"],
    ["a2", "Alpha.S01E02.v1", 11, null, "no download progress for 6 hours (strike 3 of 3)", 2000, "torrent", "Nyaa"],
    ["b1", "Beta.S01E01.v1", 22, null, "removed from the queue by you", 3000, "torrent", null],
    ["m1", "Some.Movie.2020", null, 7, "download failed", 4000, "usenet", "Nzb.su"],
  ] as const) ids[k] = Number(ins.run(k, rel, tvdb, movie, reason, at, proto, ix).lastInsertRowid);
});

test("list: newest first with show/episode title, reason, date, protocol and indexer; the filter list counts per show", async () => {
  const r = await call("GET", "/api/blocklist");
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 4);
  assert.deepEqual(r.body.items.map((x: { release: string }) => x.release), ["Some.Movie.2020", "Beta.S01E01.v1", "Alpha.S01E02.v1", "Alpha.S01E01.v1"]);
  assert.deepEqual(r.body.items[2], { id: ids.a2, release: "Alpha.S01E02.v1", tvdbId: 11, movieId: null, title: "Alpha Show", reason: "no download progress for 6 hours (strike 3 of 3)", at: 2000, protocol: "torrent", indexer: "Nyaa" });
  assert.equal(r.body.items[3].reason, "contained Episode 01.mkv.lnk");
  assert.deepEqual(r.body.shows.find((s: { tvdbId: number }) => s.tvdbId === 11), { tvdbId: 11, movieId: null, title: "Alpha Show", count: 2 });
});

test("list: filter by show, and page with before/limit", async () => {
  const alpha = await call("GET", "/api/blocklist?tvdbId=11");
  assert.deepEqual(alpha.body.items.map((x: { release: string }) => x.release), ["Alpha.S01E02.v1", "Alpha.S01E01.v1"]);
  assert.equal(alpha.body.total, 2);
  const page1 = await call("GET", "/api/blocklist?limit=2");
  assert.equal(page1.body.items.length, 2);
  assert.equal(page1.body.total, 4);
  const page2 = await call("GET", `/api/blocklist?limit=2&before=${page1.body.items[1].id}`);
  assert.deepEqual(page2.body.items.map((x: { release: string }) => x.release), ["Alpha.S01E02.v1", "Alpha.S01E01.v1"]);
  assert.equal((await call("GET", "/api/blocklist?movieId=7")).body.items.length, 1);
  assert.equal((await call("GET", "/api/blocklist?tvdbId=abc")).status, 400);
});

test("remove one: the release can be picked again, and Activity says so", async () => {
  assert.equal(isBlocked({ guid: "b1", title: "Beta.S01E01.v1" }), true);
  const r = await call("DELETE", `/api/blocklist/${ids.b1}`);
  assert.deepEqual(r.body, { removed: 1 });
  assert.equal(isBlocked({ guid: "b1", title: "Beta.S01E01.v1" }), false);
  const log = db.prepare("SELECT kind, why, title FROM decisions ORDER BY id DESC LIMIT 1").get() as { kind: string; why: string; title: string };
  assert.equal(log.kind, "info");
  assert.match(log.why, /You removed Beta\.S01E01\.v1 from the blocklist/);
  assert.equal((await call("DELETE", `/api/blocklist/${ids.b1}`)).status, 404, "already gone");
});

test("remove many: by ids (unknown and repeated ids ignored), one Activity entry", async () => {
  const r = await call("POST", "/api/blocklist/remove", { ids: [ids.a1, ids.a1, ids.a2, 99999, "x"] });
  assert.deepEqual(r.body, { removed: 2 });
  assert.equal((await call("GET", "/api/blocklist?tvdbId=11")).body.total, 0);
  const log = db.prepare("SELECT why FROM decisions ORDER BY id DESC LIMIT 1").get() as { why: string };
  assert.match(log.why, /You removed 2 releases from the blocklist/);
});

test("remove all of one show's entries needs an explicit show; a bare request is refused", async () => {
  db.prepare("INSERT INTO blocklist (guid, release, tvdb_id, reason, at) VALUES ('c1', 'Gamma.1', 33, 'x', 5000), ('c2', 'Gamma.2', 33, 'x', 5001), ('d1', 'Delta.1', 44, 'x', 5002)").run();
  assert.equal((await call("POST", "/api/blocklist/remove", {})).status, 400);
  assert.equal((await call("POST", "/api/blocklist/remove", { all: true })).status, 400, "never an open-ended wipe");
  const r = await call("POST", "/api/blocklist/remove", { all: true, tvdbId: 33 });
  assert.deepEqual(r.body, { removed: 2 });
  assert.equal((await call("GET", "/api/blocklist?tvdbId=44")).body.total, 1, "other shows untouched");
});
