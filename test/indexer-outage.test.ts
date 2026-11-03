/**
 * Indexers down (review 2026-11-02, M4): "couldn't search" stays apart from "searched and found nothing". A search
 * reports whether every, some or no indexer answered; the managed searches, ⚡ and Re-grab don't count an outage as a
 * completed attempt, don't push the next try back by the full interval, close nothing and say what happened.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-ix-outage-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/system/db.js");
const { patchSettings } = await import("../server/system/settings.js");
const { clearQueryCache } = await import("../server/search/searchQueue.js");
const { deepSearch } = await import("../server/search/search.js");
const { searchOutage } = await import("../server/search/indexers.js");
const { decideEpisode } = await import("../server/library/managed.js");
const { autoSearchEpisodes } = await import("../server/search/autosearch.js");
const { regrabEpisodes } = await import("../server/library/episodes.js");
type Deps = import("../server/search/autosearch.js").AutoDeps;
type EDeps = import("../server/library/episodes.js").EpisodeDeps;

const MIN = 60_000;
const TVDB = 700700;

// ---------------------------------------------------------------- three direct indexers, each switchable

type Mode = "ok" | "timeout" | "500" | "auth" | "badQuery";
const modes: Record<string, Mode> = { o1: "ok", o2: "ok", o3: "ok" };
const set = (o1: Mode, o2: Mode, o3: Mode) => {
  Object.assign(modes, { o1, o2, o3 });
  clearQueryCache();
  db.prepare("DELETE FROM indexer_breaker").run(); // each test starts with every indexer trusted
};
const ix = (id: string) =>
  ({
    id,
    kind: "newznab",
    protocol: "usenet",
    name: id.toUpperCase(),
    url: `https://${id}.example`,
    apiPath: "/api",
    apiKey: "",
    categories: [5070],
    priority: 25,
    enabled: true,
    seedRatio: null,
    seedTimeMin: null,
    tags: [],
  }) as never;

const realFetch = globalThis.fetch;
before(() => {
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, title, path, monitored, synced_at) VALUES (70, ?, 'Outage Show', '/media/AnimeArr/Outage Show', 1, 0)",
    )
    .run(TVDB);
  for (let ep = 1; ep <= 9; ep++)
    cache
      .prepare(
        "INSERT INTO episodes (id, series_id, season, episode, title, monitored, has_file, air_utc, runtime) VALUES (?, 70, 1, ?, ?, 1, 0, ?, 24)",
      )
      .run(7000 + ep, ep, `Title ${ep}`, Date.now() - 2 * 86_400_000);
  db.prepare("INSERT INTO managed (tvdb_id, series_id, title, dry_run, since) VALUES (?, 70, 'Outage Show', 0, 0)").run(TVDB);
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/AnimeArr"],
    managed: { ...s.managed, dryRun: false, maxAttempts: 3, backoffMin: [60, 360, 1440] },
    backlog: { ...s.backlog, retryDays: 7 },
    prowlarr: { ...s.prowlarr, url: "", apiKey: "" },
    indexers: [ix("o1"), ix("o2"), ix("o3")],
    search: { maxQueries: 6, indexerTimeoutSec: 20 },
  }));
  // Every indexer that answers has nothing for this show: a complete search finds nothing.
  globalThis.fetch = (async (u: string | URL) => {
    const id = new URL(String(u)).hostname.split(".")[0];
    const m = modes[id];
    if (m === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (m === "500") return new Response("boom", { status: 500 });
    if (m === "auth") return new Response("bad key", { status: 401 });
    if (m === "badQuery") return new Response("bad request", { status: 400 }); // it refuses this query, every time
    return new Response("<rss><channel></channel></rss>", { headers: { "content-type": "application/xml" } });
  }) as typeof fetch;
});
after(() => void (globalThis.fetch = realFetch));

// ---------------------------------------------------------------- what a search reports

test("a search says whether every, some or no indexer answered (timeouts, 500s and auth errors alike)", async () => {
  set("ok", "ok", "ok");
  assert.equal((await deepSearch(TVDB, [7001], { budget: 8 })).outage.kind, "none");

  set("ok", "500", "ok");
  const one = await deepSearch(TVDB, [7001], { budget: 8 });
  assert.equal(one.outage.kind, "partial");
  assert.match(one.outage.why, /O2/);
  assert.equal(one.outage.counts, false);

  set("timeout", "auth", "ok");
  const two = await deepSearch(TVDB, [7001], { budget: 8 });
  assert.equal(two.outage.kind, "partial");
  assert.match(two.outage.why, /O1/);
  assert.match(two.outage.why, /O2/);

  set("timeout", "500", "auth");
  const all = await deepSearch(TVDB, [7001], { budget: 8 });
  assert.equal(all.outage.kind, "all");
  assert.equal(all.outage.counts, false);
});

// ---------------------------------------------------------------- managed searches

const state = (id: number) =>
  db.prepare("SELECT state, attempts, next_at, last_why FROM search_state WHERE episode_id = ?").get(id) as {
    state: string;
    attempts: number;
    next_at: number;
    last_why: string;
  };
const row = (id: number, kind: "new" | "backlog", attempts: number) => {
  db.prepare(
    "INSERT OR REPLACE INTO search_state (episode_id, tvdb_id, air_utc, next_at, attempts, state, kind) VALUES (?, ?, 0, 0, ?, ?, ?)",
  ).run(id, TVDB, attempts, kind === "backlog" ? "backlog" : "retry", kind);
  return db.prepare("SELECT * FROM search_state WHERE episode_id = ?").get(id) as never;
};

for (const [label, m] of [
  ["every indexer down", ["timeout", "500", "auth"]],
  ["two of three indexers down", ["timeout", "auth", "ok"]],
] as const)
  test(`managed search, ${label}: not an attempt, no give-up, tried again soon, and said so`, async () => {
    set(...m);
    const now = Date.now();
    await decideEpisode(row(7002, "new", 2), now); // one more counted attempt would give up (maxAttempts 3)
    const s = state(7002);
    assert.equal(s.attempts, 2);
    assert.notEqual(s.state, "gave-up");
    assert.ok(s.next_at <= now + 60 * MIN, `next try within the hour (${(s.next_at - now) / MIN} min)`);
    assert.match(s.last_why, /didn't answer/);
  });

test("missing-episode search, some indexers down: tried again soon, not in retryDays", async () => {
  set("ok", "500", "ok");
  const now = Date.now();
  await decideEpisode(row(7003, "backlog", 0), now);
  const s = state(7003);
  assert.equal(s.state, "backlog");
  assert.equal(s.attempts, 0);
  assert.ok(s.next_at <= now + 60 * MIN);
});

test("every indexer answered and found nothing: that is a real attempt", async () => {
  set("ok", "ok", "ok");
  const now = Date.now();
  await decideEpisode(row(7004, "new", 2), now);
  assert.equal(state(7004).attempts, 3);
  assert.equal(state(7004).state, "gave-up");
});

test("an indexer that was off for grabbing before the search (a standing gap) doesn't keep the search from counting", async () => {
  set("ok", "500", "ok");
  const { indexerNumId } = await import("../server/search/indexers.js");
  db.prepare("INSERT INTO indexer_breaker (indexer_id, name, state, off_since, updated_at) VALUES (?, 'O2', 'off', ?, ?)").run(
    indexerNumId("o2"),
    Date.now() - 3_600_000,
    Date.now(),
  );
  const r = await deepSearch(TVDB, [7008], { budget: 8 });
  assert.equal(r.outage.kind, "partial", "still reported");
  assert.equal(r.outage.counts, true);
});

// ---------------------------------------------------------------- ⚡ and Re-grab (search faked)

const outage = (kind: "partial" | "all") => ({ kind, why: "O1, O2 didn't answer (timed out)", counts: false });
const fakeSearch = (kind: "none" | "partial" | "all") =>
  (async () => ({
    results: [],
    targets: [],
    errors: [],
    stoppedEarly: null,
    outage: kind === "none" ? { kind, why: "", counts: true } : outage(kind),
  })) as unknown as Deps["search"];

for (const kind of ["partial", "all"] as const)
  test(`⚡ with ${kind === "all" ? "every" : "some"} indexer(s) down reports that it couldn't search, not "needs a look"`, async () => {
    const r = await autoSearchEpisodes(TVDB, [7005], { search: fakeSearch(kind), grab: (async () => assert.fail("no grab")) as never });
    assert.equal(r.results[0].outcome, "failed");
    assert.match(r.results[0].why, /didn't answer/);
  });

test("⚡ after a complete search that found nothing still asks for a look", async () => {
  const r = await autoSearchEpisodes(TVDB, [7006], { search: fakeSearch("none"), grab: (async () => assert.fail("no grab")) as never });
  assert.equal(r.results[0].outcome, "needs-look");
});

test("Re-grab during an outage says it couldn't search instead of 'nothing else acceptable found'", async () => {
  const deps = {
    episode: async (id: number) => ({
      id,
      seriesId: 70,
      seasonNumber: 1,
      episodeNumber: 7,
      monitored: true,
      hasFile: false,
      episodeFileId: 0,
    }),
    episodeFile: async () => assert.fail("no file"),
    deleteFile: async () => undefined,
    refresh: async () => undefined,
    search: fakeSearch("partial"),
    grab: async () => assert.fail("no grab"),
  } as unknown as EDeps;
  const r = await regrabEpisodes(TVDB, [7007], deps);
  assert.match(r[0].outcome, /didn't answer/);
});

// ---------------------------------------------------------------- a query an indexer always refuses isn't an outage (M3)

test("a deterministic 4xx (the indexer refuses that query) doesn't keep a search from counting; outages still do", () => {
  const t = Date.now();
  // One query refused (Prowlarr's form and a direct indexer's), the other eleven answered.
  for (const why of ["Show [Special]: Prowlarr GET /search failed (HTTP 400)", "Show & Co: O1: HTTP 404", "Show: O1: HTTP 422"])
    assert.equal(searchOutage(12, [why], [], t).counts, true, why);
  // One indexer refusing a query others answered: reported, still counts.
  const refused = searchOutage(12, [], [{ indexerId: 9, name: "O2", why: "HTTP 400" }], t);
  assert.equal(refused.counts, true);
  assert.match(refused.why, /O2/);
  // Every query refused: the search ran and the indexers answered "no" — a real (failed) attempt, not "all down".
  const allRefused = searchOutage(3, ["a: HTTP 400", "b: HTTP 400", "c: HTTP 400"], [], t);
  assert.notEqual(allRefused.kind, "all");
  assert.equal(allRefused.counts, true);
  // Outages stay outages: timeouts, 5xx, auth errors, rate limits, network failures.
  for (const why of [
    "q: O1 timed out",
    "q: O1: HTTP 500",
    "q: Prowlarr GET /search failed (HTTP 503)",
    "q: refused (HTTP 401: check the API key)",
    "q: O1: HTTP 403",
    "q: O1: HTTP 429",
    "q: O1: HTTP 408",
    "q: o1.example refused the connection",
  ]) {
    assert.equal(searchOutage(12, [why], [], t).counts, false, why);
    assert.equal(searchOutage(12, [], [{ indexerId: 9, name: "O1", why: why.slice(3) }], t).counts, false, why);
  }
});

test("managed search where one indexer refuses the queries (HTTP 400): a real attempt, given up on like any other", async () => {
  set("ok", "badQuery", "ok");
  const now = Date.now();
  await decideEpisode(row(7009, "new", 2), now);
  assert.equal(state(7009).attempts, 3);
  assert.equal(state(7009).state, "gave-up");
});
