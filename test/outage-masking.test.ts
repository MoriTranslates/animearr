/**
 * Indexer outage vs refused query (blind review of fix/blind-c2-jobs, 2026-11-03). An indexer's error must never hide
 * a real outage, and a dead indexer must still trip its breaker. Repro C (one flaky indexer) still happens: it comes
 * from the "any failed query keeps the search from counting" rule (de8de87) and is kept here as a todo.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-outage-masking-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/system/db.js");
const { patchSettings } = await import("../server/system/settings.js");
const { clearQueryCache } = await import("../server/search/searchQueue.js");
const { deepSearch } = await import("../server/search/search.js");
const { decideEpisode } = await import("../server/library/managed.js");
const { indexerNumId } = await import("../server/search/indexers.js");

const TVDB = 800800;
type Mode = "ok" | "timeout" | "500" | "badQuery" | "404" | "flaky";
const modes: Record<string, Mode> = { o1: "ok", o2: "ok", o3: "ok" };
let flakyCalls = 0;
const set = (o1: Mode, o2: Mode, o3: Mode) => {
  Object.assign(modes, { o1, o2, o3 });
  clearQueryCache();
  flakyCalls = 0;
  db.prepare("DELETE FROM indexer_breaker").run();
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
      "INSERT INTO series (id, tvdb_id, title, path, monitored, synced_at) VALUES (80, ?, 'Repro Show', '/media/AnimeArr/Repro Show', 1, 0)",
    )
    .run(TVDB);
  for (let ep = 1; ep <= 9; ep++)
    cache
      .prepare(
        "INSERT INTO episodes (id, series_id, season, episode, title, monitored, has_file, air_utc, runtime) VALUES (?, 80, 1, ?, ?, 1, 0, ?, 24)",
      )
      .run(8000 + ep, ep, `Title ${ep}`, Date.now() - 2 * 86_400_000);
  db.prepare("INSERT INTO managed (tvdb_id, series_id, title, dry_run, since) VALUES (?, 80, 'Repro Show', 0, 0)").run(TVDB);
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/AnimeArr"],
    managed: { ...s.managed, dryRun: false, maxAttempts: 3, backoffMin: [60, 360, 1440] },
    prowlarr: { ...s.prowlarr, url: "", apiKey: "" },
    indexers: [ix("o1"), ix("o2"), ix("o3")],
    search: { maxQueries: 6, indexerTimeoutSec: 20 },
  }));
  globalThis.fetch = (async (u: string | URL) => {
    const id = new URL(String(u)).hostname.split(".")[0];
    const m = modes[id];
    if (m === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (m === "500") return new Response("boom", { status: 500 });
    if (m === "badQuery") return new Response("bad request", { status: 400 });
    if (m === "404") return new Response("not found", { status: 404 });
    if (m === "flaky" && flakyCalls++ === 0) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    return new Response("<rss><channel></channel></rss>", { headers: { "content-type": "application/xml" } });
  }) as typeof fetch;
});
after(() => void (globalThis.fetch = realFetch));

const state = (id: number) =>
  db.prepare("SELECT state, attempts, next_at, last_why FROM search_state WHERE episode_id = ?").get(id) as {
    state: string;
    attempts: number;
    next_at: number;
    last_why: string;
  };
const row = (id: number, attempts: number) => {
  db.prepare(
    "INSERT OR REPLACE INTO search_state (episode_id, tvdb_id, air_utc, next_at, attempts, state, kind) VALUES (?, ?, 0, 0, ?, 'retry', 'new')",
  ).run(id, TVDB, attempts);
  return db.prepare("SELECT * FROM search_state WHERE episode_id = ?").get(id) as never;
};

test("one indexer refuses the query (400) while the other two are down: the outage shows and the managed search doesn't give up", async () => {
  set("badQuery", "timeout", "500");
  const r = await deepSearch(TVDB, [8001], { budget: 8 });
  assert.equal(r.outage.counts, false, `outage: ${JSON.stringify(r.outage)}`);
  await decideEpisode(row(8002, 2), Date.now());
  const s = state(8002);
  assert.notEqual(s.state, "gave-up", JSON.stringify(s));
  assert.equal(s.attempts, 2, "an outage uses up no attempt");
});

test("an indexer that answers 404 to every query trips its breaker", async () => {
  set("404", "ok", "ok");
  for (let i = 0; i < 5; i++) {
    clearQueryCache();
    await deepSearch(TVDB, [8003], { budget: 8 });
  }
  const br = db.prepare("SELECT state FROM indexer_breaker WHERE indexer_id = ?").get(indexerNumId("o1")) as { state: string } | undefined;
  assert.ok(br && br.state !== "on", `breaker: ${JSON.stringify(br)}`);
});

test(
  "one timed-out query from a flaky indexer still lets the search count (backoff applies)",
  { todo: "known: any failed query keeps a search from counting (de8de87); not fixed on this branch" },
  async () => {
    const now = Date.now();
    set("ok", "flaky", "ok"); // o2 times out on its first query only
    await decideEpisode(row(8004, 2), now);
    const s = state(8004);
    assert.ok(s.attempts > 2 || s.next_at - now > 30 * 60_000, `never counted: ${JSON.stringify(s)}`);
  },
);
