/** ⚡ as background jobs, the app-wide query scheduler, per-indexer time limits, early stop and the query cache. Mocks only. */
import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-squeue-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/system/db.js");
const { patchSettings } = await import("../server/system/settings.js");
const { queueAutoSearch, autoJobs, autoJobsIdle } = await import("../server/autosearch.js");
const { clearQueryCache, schedulerStats } = await import("../server/searchQueue.js");
const { searchAll, indexerNumId } = await import("../server/indexers.js");
const { deepSearch, clearlyBest } = await import("../server/search.js");
const { saveSeadex } = await import("../server/seadex.js");
const { startGrab } = await import("../server/pipeline.js");
type SR = import("../server/search.js").SearchResult;

const realFetch = globalThis.fetch;
after(() => void (globalThis.fetch = realFetch));
const IX = {
  id: "q1",
  kind: "newznab",
  protocol: "usenet",
  name: "Q",
  url: "https://q.example",
  apiPath: "/api",
  apiKey: "",
  categories: [5070],
  priority: 25,
  enabled: true,
  seedRatio: null,
  seedTimeMin: null,
  tags: [],
} as never;
const item = (title: string, size = 1.4e9) =>
  `<item><title>${title}</title><guid>${title}</guid><link>https://q.example/get/${encodeURIComponent(title)}</link><pubDate>${new Date(Date.now() - 86_400_000).toUTCString()}</pubDate><newznab:attr name="size" value="${size}"/></item>`;
const rss = (...items: string[]) =>
  new Response(`<rss><channel>${items.join("")}</channel></rss>`, { headers: { "content-type": "application/xml" } });
const qOf = (u: string | URL) => new URL(String(u)).searchParams.get("q") ?? "";
/** Waits for the request's abort (a hanging indexer), like a real fetch does. */
const hang = (init?: RequestInit) =>
  new Promise<Response>((_, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)));

before(() => {
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, title, path, monitored, synced_at) VALUES (60, 700600, 'Queue Show', '/media/AnimeArr/Queue Show', 1, 0)",
    )
    .run();
  for (const ep of [1, 2, 3, 4, 5, 6, 7, 8])
    cache
      .prepare(
        "INSERT INTO episodes (id, series_id, season, episode, title, monitored, has_file, air_utc, runtime) VALUES (?, 60, 1, ?, ?, 1, 0, 0, 24)",
      )
      .run(6000 + ep, ep, `Title ${ep}`);
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/AnimeArr"],
    managed: { ...s.managed, dryRun: false, minConfidence: 80 },
    prowlarr: { ...s.prowlarr, url: "", apiKey: "" },
    indexers: [IX],
    search: { maxQueries: 6, indexerTimeoutSec: 20 },
  }));
});

const res = (title: string, episodeIds: number[], over: Partial<SR> = {}): SR =>
  ({
    guid: `g-${title}`,
    title,
    indexer: "Q",
    indexerId: 1,
    protocol: "usenet",
    size: 1.4e9,
    seeders: null,
    publishDate: null,
    ageHours: 30,
    episodeIds,
    label: "",
    confidence: 95,
    coversTarget: true,
    extra: 0,
    quality: { source: "bluray", resolution: 1080, remux: false },
    rank: { accept: true, score: 100, langProb: 0.97, lang: "en", langSource: "", flags: [], why: "97% English, Usenet", reject: null },
    mappingWhy: [],
    group: "Grp",
    downloadUrl: "http://x",
    ...over,
  }) as SR;
const flags = (...f: [string, string, "good" | "warn" | "bad" | "info"][]) => f.map(([key, label, tone]) => ({ key, label, tone }));
const withFlags = (r: SR, ...f: [string, string, "good" | "warn" | "bad" | "info"][]) => ({
  ...r,
  rank: { ...r.rank, flags: flags(...f) },
});

/** A search that waits until `open()`; counts calls per episode. */
function gated(results: (ids: number[]) => SR[] = (ids) => [res(`[Good] Queue Show - ${ids[0]}`, ids)]) {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const calls: number[][] = [];
  const grabbed: string[] = [];
  return {
    open: () => open(),
    calls,
    grabbed,
    d: {
      search: (async (_t: number, ids: number[]) => (calls.push(ids), await gate, { results: results(ids) })) as never,
      grab: (async (req: { candidate: { title: string } }) => (
        grabbed.push(req.candidate.title),
        { id: 1, dryRun: false, message: "Sent" }
      )) as never,
    },
  };
}

test("⚡ answers at once with the job; the search runs after, and its outcome lands in the job list and Activity", async () => {
  const g = gated();
  const t0 = Date.now();
  const r = queueAutoSearch(700600, [6001], g.d);
  assert.ok(Date.now() - t0 < 100, "no waiting for the search");
  assert.equal(r.queued, true);
  assert.equal(r.episodes, 1);
  assert.equal(r.position, 0);
  const view = autoJobs();
  assert.ok(view.searching.includes(6001), "the episode shows as being searched");
  assert.equal(view.jobs.find((j) => j.id === r.jobId)?.state, "running");
  g.open();
  await autoJobsIdle();
  const job = autoJobs().jobs.find((j) => j.id === r.jobId)!;
  assert.equal(job.state, "done");
  assert.deepEqual(
    job.results.map((x) => [x.label, x.outcome]),
    [["S01E01 · Title 1", "grabbed"]],
  );
  assert.deepEqual(g.grabbed, ["[Good] Queue Show - 6001"]);
  assert.ok(!autoJobs().searching.includes(6001), "released when done");
  const log = db.prepare("SELECT why FROM decisions WHERE kind = 'search' ORDER BY id DESC LIMIT 1").get() as { why: string };
  assert.match(log.why, /^Automatic search for Queue Show: 1 started/);
});

test("a second ⚡ on an episode still queued is skipped as already being searched; extra jobs wait their turn", async () => {
  const a = gated();
  const b = gated();
  const c = gated();
  queueAutoSearch(700600, [6002], a.d);
  queueAutoSearch(700600, [6003], b.d);
  const third = queueAutoSearch(700600, [6004], c.d);
  assert.equal(third.position, 1, "two jobs run at once; the third waits");
  assert.equal(autoJobs().jobs.find((j) => j.id === third.jobId)?.state, "queued");
  const again = queueAutoSearch(700600, [6004], c.d);
  assert.equal(again.episodes, 0);
  const dup = autoJobs().jobs.find((j) => j.id === again.jobId)!;
  assert.equal(dup.state, "done");
  assert.deepEqual(
    dup.results.map((x) => [x.outcome, x.why]),
    [["skipped", "already being searched"]],
  );
  a.open();
  b.open();
  c.open();
  await autoJobsIdle();
  assert.deepEqual(c.calls, [[6004]], "searched once");
  assert.equal(autoJobs().jobs.find((j) => j.id === third.jobId)?.results[0].outcome, "grabbed");
});

test("practice mode: the job goes through the real grab path and only would-grab", async () => {
  patchSettings((s) => ({ ...s, managed: { ...s.managed, dryRun: true } }));
  try {
    const g = gated();
    g.open();
    const r = queueAutoSearch(700600, [6005], { search: g.d.search, grab: startGrab });
    await autoJobsIdle();
    const job = autoJobs().jobs.find((j) => j.id === r.jobId)!;
    assert.equal(job.results[0].outcome, "would-grab");
    const sent = db.prepare("SELECT COUNT(*) AS n FROM grabs WHERE dry_run = 0 AND tvdb_id = 700600").get() as { n: number };
    assert.equal(sent.n, 0, "nothing sent to a download client");
  } finally {
    patchSettings((s) => ({ ...s, managed: { ...s.managed, dryRun: false } }));
  }
});

test("one cap for every indexer query in the app, shared in turn between two ⚡ jobs", async () => {
  clearQueryCache();
  patchSettings((s) => ({ ...s, search: { ...s.search, maxQueries: 2 } }));
  let now = 0;
  let peak = 0;
  const started: string[] = [];
  globalThis.fetch = (async (u: string | URL) => {
    started.push(qOf(u));
    peak = Math.max(peak, ++now);
    await new Promise((r) => setTimeout(r, 15));
    now--;
    return rss();
  }) as typeof fetch;
  const job = (prefix: string, n: number) => ({
    search: (async () => (await Promise.all(Array.from({ length: n }, (_, i) => searchAll(`${prefix}${i}`))), { results: [] })) as never,
    grab: (async () => assert.fail("nothing to grab")) as never,
  });
  try {
    queueAutoSearch(700600, [6006], job("a", 6));
    queueAutoSearch(700600, [6007], job("b", 3));
    await autoJobsIdle();
  } finally {
    globalThis.fetch = realFetch;
    patchSettings((s) => ({ ...s, search: { ...s.search, maxQueries: 6 } }));
  }
  assert.equal(started.length, 9);
  assert.equal(peak, 2, "never more than the cap at once, across both jobs");
  const firstB = started.findIndex((q) => q.startsWith("b"));
  const lastA = started.findLastIndex((q) => q.startsWith("a"));
  assert.ok(firstB < lastA, `the second job's first query ran before the first job's last one (${started.join(" ")})`);
  assert.deepEqual(
    started.filter((q) => q.startsWith("a")),
    ["a0", "a1", "a2", "a3", "a4", "a5"],
    "first come, first served within a job",
  );
  assert.deepEqual(schedulerStats().running, 0);
});

test("an indexer that doesn't answer in time is left out of the query and its search health notes it", async () => {
  clearQueryCache();
  patchSettings((s) => ({ ...s, search: { ...s.search, indexerTimeoutSec: 1 } }));
  try {
    // A direct indexer: aborted after the limit.
    globalThis.fetch = (async (_u: string | URL, init?: RequestInit) => hang(init)) as typeof fetch;
    const t0 = Date.now();
    await assert.rejects(searchAll("slow direct"), /Q: timed out after 1 s/);
    assert.ok(Date.now() - t0 < 5000);
    const row = db.prepare("SELECT search_streak, last_error FROM indexer_breaker WHERE indexer_id = ?").get(indexerNumId("q1")) as {
      search_streak: number;
      last_error: string;
    };
    assert.equal(row.search_streak, 1);
    assert.match(row.last_error, /timed out/);

    // Prowlarr: asked per indexer, so the fast one's results come back while the slow one is cut off.
    patchSettings((s) => ({ ...s, indexers: [], prowlarr: { ...s.prowlarr, url: "http://prowlarr.test", apiKey: "k", indexerIds: [] } }));
    globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
      const url = new URL(String(u));
      if (url.pathname.endsWith("/indexer"))
        return Response.json(
          [1, 2].map((id) => ({
            id,
            name: id === 1 ? "Fast" : "Slow",
            protocol: "torrent",
            enable: true,
            capabilities: { categories: [{ id: 5070 }] },
          })),
        );
      if (url.searchParams.get("indexerIds") === "2") return hang(init);
      return Response.json([{ guid: "f1", title: "[Grp] Queue Show - 01", indexerId: 1, indexer: "Fast", protocol: "torrent", size: 1e9 }]);
    }) as typeof fetch;
    const t1 = Date.now();
    const rows = await searchAll("slow prowlarr");
    assert.deepEqual(
      rows.map((x) => x.guid),
      ["f1"],
    );
    assert.ok(Date.now() - t1 < 5000, "didn't wait for the slow indexer");
    const slow = db.prepare("SELECT search_streak, last_error FROM indexer_breaker WHERE indexer_id = 2").get() as {
      search_streak: number;
      last_error: string;
    };
    assert.equal(slow.search_streak, 1);
    assert.match(slow.last_error, /timed out after 1 s/);
    const fast = db.prepare("SELECT search_streak FROM indexer_breaker WHERE indexer_id = 1").get() as
      { search_streak: number } | undefined;
    assert.ok(!fast || fast.search_streak === 0);
  } finally {
    globalThis.fetch = realFetch;
    patchSettings((s) => ({
      ...s,
      indexers: [IX],
      prowlarr: { ...s.prowlarr, url: "", apiKey: "" },
      search: { ...s.search, indexerTimeoutSec: 20 },
    }));
  }
});

test("early stop: only for a result nothing later can beat (SeaDex best, sure, preferred protocol, no warnings)", () => {
  const o = {
    profile: { protocolOrder: ["usenet", "torrent"] as ("usenet" | "torrent")[], resolution: 1080 },
    minConfidence: 80,
    seasonGroup: null,
  };
  const best = withFlags(
    res("[Kekkan] Queue Show - 05 (BD 1080p)", [6005], { group: "Kekkan" }),
    ["seadex", "SeaDex best", "good"],
    ["lang", "English 97%", "good"],
  );
  assert.equal(clearlyBest(best, o), true);
  assert.equal(clearlyBest(withFlags(best, ["seadex", "SeaDex alt", "good"]), o), false, "an alt can be beaten by the best");
  assert.equal(clearlyBest(withFlags(best), o), false, "a top-tier group without SeaDex isn't the ceiling");
  assert.equal(clearlyBest(withFlags(best, ["seadex", "SeaDex best", "good"], ["burnIn", "English burned-in", "warn"]), o), false);
  assert.equal(clearlyBest({ ...best, protocol: "torrent" }, o), false, "the same release on the preferred protocol would rank higher");
  assert.equal(clearlyBest({ ...best, confidence: 85 }, o), false);
  assert.equal(clearlyBest({ ...best, rank: { ...best.rank, langProb: 0.85 } }, o), false);
  assert.equal(clearlyBest({ ...best, quality: { source: "bluray", resolution: 720, remux: false } }, o), false);
  assert.equal(clearlyBest({ ...best, extra: 11, coversTarget: true }, o), false, "a pack isn't an episode's ceiling");
  assert.equal(clearlyBest(best, { ...o, seasonGroup: "OtherGrp" }), false, "the season's group would score more");
  assert.equal(clearlyBest({ ...best, rank: { ...best.rank, accept: false, reject: "blocklisted: x" } }, o), false);
});

test("early stop in a real Deep Search: a SeaDex-best hit skips the queries still waiting; a mediocre one doesn't", async () => {
  clearQueryCache();
  db.prepare(
    "INSERT INTO entries (anilist_id, tvdb_id, tvdb_season, tvdb_offset, kind, title_english, synonyms, status, start_date, episodes, fetched_at) VALUES (96000, 700600, '1', 0, 'TV', 'Queue Show', '[]', 'FINISHED', '2020-01-01', 8, 1)",
  ).run();
  saveSeadex(96000, { incomplete: false, torrents: [{ group: "Kekkan", tracker: "Nyaa", best: true, dualAudio: false, tags: [] }] });
  patchSettings((s) => ({ ...s, search: { ...s.search, maxQueries: 1 } }));
  const asked: string[] = [];
  let release = "";
  globalThis.fetch = (async (u: string | URL) => (asked.push(qOf(u)), rss(item(release)))) as typeof fetch;
  try {
    release = "[Kekkan] Queue Show S01E05 (BD 1080p) [English Subs]";
    const hit = await deepSearch(700600, [6005], { budget: 12, earlyStop: { minConfidence: 80 } });
    assert.equal(hit.results[0]?.title, release);
    assert.match(hit.stoppedEarly ?? "", /SeaDex's best release.*\(1 query skipped\)/);
    assert.equal(asked.length, 1, `one query asked, the other dropped (${asked.join(" | ")})`);

    asked.length = 0;
    release = "[SomeGrp] Queue Show S01E06 (WEB 1080p) [English Subs]";
    const meh = await deepSearch(700600, [6006], { budget: 12, earlyStop: { minConfidence: 80 } });
    assert.equal(meh.results[0]?.title, release);
    assert.equal(meh.stoppedEarly, null);
    assert.equal(asked.length, meh.queries.length, "every query asked");
    assert.ok(asked.length >= 2);

    // Without earlyStop (interactive searches) the same SeaDex hit doesn't cut anything short.
    asked.length = 0;
    clearQueryCache();
    release = "[Kekkan] Queue Show S01E05 (BD 1080p) [English Subs]";
    const full = await deepSearch(700600, [6005], { budget: 12 });
    assert.equal(full.stoppedEarly, null);
    assert.equal(asked.length, full.queries.length);
  } finally {
    globalThis.fetch = realFetch;
    patchSettings((s) => ({ ...s, search: { ...s.search, maxQueries: 6 } }));
  }
});

test("⚡ asks for the early stop on single episodes and says so when it fired", async () => {
  const asked: unknown[] = [];
  const d = {
    search: (async (_t: number, ids: number[], o: unknown) => (
      asked.push(o),
      {
        results: [res(`[Kekkan] Queue Show - ${ids[0]}`, ids)],
        stoppedEarly: "[Kekkan] Queue Show is SeaDex's best release (1 query skipped)",
      }
    )) as never,
    grab: (async () => ({ id: 1, dryRun: false, message: "Sent" })) as never,
  };
  const r = queueAutoSearch(700600, [6008], d);
  await autoJobsIdle();
  assert.deepEqual(asked, [{ budget: 12, earlyStop: { minConfidence: 80 } }]);
  const job = autoJobs().jobs.find((j) => j.id === r.jobId)!;
  assert.match(job.results[0].why, /stopped early: \[Kekkan\] Queue Show is SeaDex's best release/);
  const log = db.prepare("SELECT why FROM decisions WHERE kind = 'search' ORDER BY id DESC LIMIT 1").get() as { why: string };
  assert.match(log.why, /1 started, 1 stopped early/);
});

test("identical queries within 10 minutes reuse the answer; fresh asks again; after the window it's asked again", async () => {
  clearQueryCache();
  let fetches = 0;
  globalThis.fetch = (async () => (fetches++, rss(item("[Grp] Cached - 01")))) as typeof fetch;
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    assert.equal((await searchAll("cache me")).length, 1);
    assert.equal((await searchAll("cache me")).length, 1);
    assert.equal(fetches, 1, "the second identical query came from the cache");
    await searchAll("cache me", { categories: [5000] });
    assert.equal(fetches, 2, "other categories are another query");
    await searchAll("cache me", { fresh: true });
    assert.equal(fetches, 3, "fresh skips the cache");
    mock.timers.tick(9 * 60_000);
    await searchAll("cache me");
    assert.equal(fetches, 3, "still within 10 minutes");
    mock.timers.tick(2 * 60_000);
    await searchAll("cache me");
    assert.equal(fetches, 4, "expired");
    await searchAll("");
    await searchAll("");
    assert.equal(fetches, 6, "the empty recent-releases poll is never cached");
  } finally {
    mock.timers.reset();
    globalThis.fetch = realFetch;
  }
});
