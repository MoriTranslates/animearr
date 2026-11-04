/**
 * The user's choice (2026-11-04): "I would rather get a 35% if there is no other file than none." A MISSING episode
 * with nothing that passes the English threshold takes the best release of merely unknown language; the subtitle check
 * after the download decides (refuse, blocklist, next one), at most LAST_RESORT_CAP downloads per episode. Never for an
 * episode that has a file, never for an explicit rejection (raw, JP market, foreign-only, blocklisted) or a release the
 * library already knows has no English.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sparseFile } from "./sparse.js";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-lastres-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/system/db.js");
const { patchSettings } = await import("../server/system/settings.js");
const { autoSearchEpisodes } = await import("../server/search/autosearch.js");
const { decideEpisode, lastResortPicks, lastResortsUsed, LAST_RESORT_CAP } = await import("../server/library/managed.js");
const { startGrab, importAndVerify } = await import("../server/grabs/pipeline.js");
const { invalidateIndex } = await import("../server/metadata/metadata.js");
type SR = import("../server/search/search.js").SearchResult;
type PDeps = import("../server/grabs/pipelineState.js").PipelineDeps;
type Row = import("../server/grabs/pipelineState.js").GrabRow;

const TVDB = 700900;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-lastres-f-"));
const LIB = path.join(tmp, "lib");
const DL = path.join(tmp, "dl");

before(() => {
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, title, year, series_type, path, root_folder, monitored, synced_at) VALUES (90, ?, 'Last Show', 2026, 'anime', '/media/Anime/Last Show', '/media/Anime', 1, 0)",
    )
    .run(TVDB);
  for (const ep of [1, 2, 3, 4, 5, 6, 7, 8, 9])
    cache
      .prepare(
        "INSERT INTO episodes (id, series_id, season, episode, absolute, title, monitored, has_file, air_utc, runtime) VALUES (?, 90, 1, ?, ?, ?, 1, ?, 0, 24)",
      )
      .run(9000 + ep, ep, ep, `Title ${ep}`, ep === 2 ? 1 : 0);
  invalidateIndex();
  db.prepare("INSERT INTO managed (tvdb_id, series_id, title, dry_run, since) VALUES (?, 90, 'Last Show', 0, 0)").run(TVDB);
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/Anime"],
    propers: "ignore",
    managed: { ...s.managed, dryRun: false, minConfidence: 80, maxAttempts: 12, backoffMin: [30] },
    importer: { ...s.importer, engine: "animearr", allowReal: true, realBudget: -1, sourceRoots: ["/data"] },
    localPathMappings: [
      { from: "/media/Anime", to: path.join(LIB, "anime") },
      { from: "/data", to: DL },
    ],
    media: { ...s.media, recycleBin: "", skipFreeSpaceCheck: true },
  }));
});

/** A search result as the ranking hands it over: 35% English with nothing known, unless told otherwise. */
const r = (title: string, ids: number[], over: { p?: number; accept?: boolean; reject?: string | null; why?: string } = {}): SR =>
  ({
    guid: `g-${title}`,
    title,
    indexer: "X",
    indexerId: 1,
    protocol: "torrent",
    size: 1.4e9,
    seeders: 10,
    publishDate: null,
    ageHours: 30,
    episodeIds: ids,
    label: "",
    confidence: 95,
    coversTarget: true,
    extra: 0,
    rank: {
      accept: over.accept ?? true,
      score: 50,
      langProb: over.p ?? 0.35,
      lang: "en",
      langSource: "no language info in the name",
      flags: [],
      why: over.why ?? `${Math.round((over.p ?? 0.35) * 100)}% English (no language info in the name), torrent`,
      reject: over.reject ?? null,
    },
    mappingWhy: [],
    group: null,
    downloadUrl: "http://x",
  }) as SR;

function autoDeps(results: (ids: number[]) => SR[]) {
  const grabbed: { title: string; why: string; fallbacks: string[] }[] = [];
  return {
    grabbed,
    d: {
      search: (async (_t: number, ids: number[]) => ({ results: results(ids) })) as never,
      grab: (async (req: { candidate: { title: string; why: string }; fallbacks: { title: string }[] }) => (
        grabbed.push({ title: req.candidate.title, why: req.candidate.why, fallbacks: req.fallbacks.map((f) => f.title) }),
        { id: 1, dryRun: false, message: "Sent" }
      )) as never,
    },
  };
}

test("⚡, missing episode with only 35% candidates: the best is grabbed, labelled a last resort", async () => {
  const { d, grabbed } = autoDeps((ids) => [
    r("[Diogo4D] [WEB][1080p] Last Show - 01 [A4E78F4C].mkv", ids, { p: 0.35 }),
    r("Last.Show.S01E01.1080p.WEB-DL-GRP", ids, { p: 0.4 }),
  ]);
  const out = await autoSearchEpisodes(TVDB, [9001], d);
  assert.equal(out.results[0].outcome, "grabbed");
  assert.equal(grabbed.length, 1);
  assert.equal(grabbed[0].title, "Last.Show.S01E01.1080p.WEB-DL-GRP", "highest P(sub) first");
  assert.match(grabbed[0].why, /^Last resort: nothing better found, the subtitle check decides · 40% English/);
  assert.deepEqual(grabbed[0].fallbacks, ["[Diogo4D] [WEB][1080p] Last Show - 01 [A4E78F4C].mkv"]);
});

test("⚡, an episode that has a file plus only 35% candidates: no grab", async () => {
  const { d, grabbed } = autoDeps((ids) => [r("Last.Show.S01E02.1080p.WEB-DL-GRP", ids)]);
  const out = await autoSearchEpisodes(TVDB, [9002], d);
  assert.notEqual(out.results[0].outcome, "grabbed");
  assert.equal(grabbed.length, 0);
});

test("⚡, only raw / JP-market / foreign-only / blocklisted / known-no-English candidates: no grab, needs a look", async () => {
  const { d, grabbed } = autoDeps((ids) => [
    r("[Ohys-Raws] Last Show - 03 (CR 1920x1080).mp4", ids, { p: 0.02, accept: false, reject: "raw release (no subtitles)" }),
    r("Last.Show.S01E03.JPN-Subs-GRP", ids, { p: 0.03, accept: false, reject: "Japanese-market release, no English subtitles" }),
    r("Last.Show.S01E03.VOSTFR-GRP", ids, { p: 0.05, accept: false, reject: "foreign subtitles only (French)" }),
    r("Last.Show.S01E03.WEB-OLD", ids, { accept: false, reject: "blocklisted: no subtitles at all" }),
    // The library knows this group's files had no English: not "unknown", so not a last resort either.
    r("[NoEng] Last Show - 03", ids, { p: 0.12 }),
    // A burned-in release isn't an unknown-language one.
    { ...r("[Burn] Last Show - 03", ids), rank: { ...r("x", ids).rank, flags: [{ key: "burnIn", label: "", tone: "warn" }] } } as SR,
    // Unsure it's even this episode.
    { ...r("Last Show 3", ids), confidence: 50 } as SR,
  ]);
  const out = await autoSearchEpisodes(TVDB, [9003], d);
  assert.equal(out.results[0].outcome, "needs-look");
  assert.equal(grabbed.length, 0);
});

// ---------------------------------------------------------------- the managed search, and the subtitle check behind it

const state = (id: number) =>
  db.prepare("SELECT state, last_why FROM search_state WHERE episode_id = ?").get(id) as { state: string; last_why: string };
const stRow = (id: number, kind: "new" | "backlog", airUtc: number) => {
  db.prepare(
    "INSERT OR REPLACE INTO search_state (episode_id, tvdb_id, air_utc, next_at, attempts, state, kind) VALUES (?, ?, ?, 0, 0, ?, ?)",
  ).run(id, TVDB, airUtc, kind === "backlog" ? "backlog" : "retry", kind);
  return db.prepare("SELECT * FROM search_state WHERE episode_id = ?").get(id) as never;
};
const managedSearch = (results: SR[]) =>
  (async () => ({ results, targets: [{ season: 1, episode: 4 }], found: results.length, outage: { kind: "none", counts: true } })) as never;

test("managed search: a new episode gets a day for the usual subbers before a last resort", async () => {
  const sent: string[] = [];
  const grab = (async (req: { candidate: { title: string } }) => (
    sent.push(req.candidate.title),
    { id: 1, dryRun: false, message: "Sent" }
  )) as never;
  const now = Date.now();
  cache.prepare("UPDATE episodes SET air_utc = ? WHERE id = 9005").run(now - 3 * 3_600_000);
  await decideEpisode(stRow(9005, "new", now - 3 * 3_600_000), now, { search: managedSearch([r("Last.Show.S01E05-GRP", [9005])]), grab });
  assert.deepEqual(sent, []);
  cache.prepare("UPDATE episodes SET air_utc = ? WHERE id = 9005").run(now - 25 * 3_600_000);
  await decideEpisode(stRow(9005, "new", now - 25 * 3_600_000), now, { search: managedSearch([r("Last.Show.S01E05-GRP", [9005])]), grab });
  assert.deepEqual(sent, ["Last.Show.S01E05-GRP"]);
});

test("managed search: a last-resort file without English is refused and blocklisted, the next is tried, and it stops at the cap", async () => {
  const EP = 9004;
  const names = [1, 2, 3, 4].map((n) => `Last.Show.S01E04.1080p.WEB-DL-UNK${n}`);
  const paths = new Map<string, string>();
  const pdeps = {
    clients: {
      addNzb: async () => ({ client: "sabnzbd", ref: "x" }),
      addTorrent: async (_f: unknown, title: string) => ({ client: "qbittorrent", ref: `h-${title}` }),
      remove: async () => undefined,
      status: async () => ({ state: "completed", progress: 1, path: "" }),
    },
    fetchRelease: async () => ({ data: Buffer.from("d8:announce0:e"), filename: "x.torrent" }),
    sonarr: {
      preview: async (folder: string) =>
        [...paths.values()].filter((p) => p.startsWith(`${folder}/`)).map((p) => ({ path: p, size: 5e8, quality: {}, languages: [] })),
      importFiles: async () => ({ id: 1 }),
      command: async () => ({ id: 1, status: "completed" }),
      episode: async () => ({}),
      episodeFile: async () => ({}),
    },
    // Every download turns out to have no subtitles at all.
    probe: async () => ({ durationSec: 1440, audio: ["ja"], subs: [], sidecars: [], untagged: 0, forced: [] }),
    localPath: (p: string) => p.replace("/data", DL).replace("/media/Anime", path.join(LIB, "anime")),
    sleep: async () => undefined,
    refreshSeries: async () => undefined,
    cleanup: async () => null,
  } as unknown as PDeps;
  const grab = ((req: Parameters<typeof startGrab>[0]) => startGrab(req, pdeps)) as typeof startGrab;
  const blocked = () => (db.prepare("SELECT release FROM blocklist ORDER BY id").all() as { release: string }[]).map((x) => x.release);
  // What the search would rank: a blocklisted release comes back rejected.
  const results = () =>
    names.map((n) => (blocked().includes(n) ? r(n, [EP], { accept: false, reject: "blocklisted: no subtitles at all" }) : r(n, [EP])));

  await decideEpisode(stRow(EP, "backlog", 0), Date.now(), { search: managedSearch(results()), grab });
  // Download → check → refuse, three times: one chain, the next candidate each time.
  for (let i = 0; i < LAST_RESORT_CAP; i++) {
    const row = db.prepare("SELECT * FROM grabs WHERE state = 'downloading' AND episode_ids = ?").get(`[${EP}]`) as unknown as
      Row | undefined;
    assert.ok(row, `download ${i + 1} was sent`);
    assert.equal(row.release, names[i]);
    assert.match(row.why, /^Last resort: /);
    const file = `/data/${row.release}.mkv`;
    paths.set(row.release, file);
    sparseFile(pdeps.localPath(file)!, 31e6);
    db.prepare("UPDATE grabs SET state = 'importing' WHERE id = ?").run(row.id);
    await importAndVerify({ ...row, state: "importing" }, file, pdeps);
    assert.equal((db.prepare("SELECT state FROM grabs WHERE id = ?").get(row.id) as { state: string }).state, "failed");
  }
  assert.deepEqual(blocked(), names.slice(0, 3), "each refused release is blocklisted");
  assert.equal(
    (
      db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE kind = 'verify-fail' AND why LIKE '%no subtitles at all%'").get() as {
        n: number;
      }
    ).n,
    3,
  );
  assert.equal(db.prepare("SELECT 1 FROM grabs WHERE state IN ('sending', 'downloading')").get(), undefined, "the chain stopped");

  // The next search still sees an unknown release (UNK4), but the cap is used up: no fourth download, a note instead.
  await decideEpisode(stRow(EP, "backlog", 0), Date.now(), { search: managedSearch(results()), grab });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM grabs WHERE episode_ids = ?").get(`[${EP}]`) as { n: number }).n, 3);
  assert.match(
    state(EP).last_why,
    /3 last-resort downloads were already tried for this episode without giving it a file, so no more are tried automatically/,
  );
  const note = db.prepare("SELECT why, detail FROM decisions WHERE kind = 'skip' ORDER BY id DESC LIMIT 1").get() as {
    why: string;
    detail: string;
  };
  assert.match(note.why, /pick one by hand/);
  assert.equal(JSON.parse(note.detail).needsLook, true);
});

// ---------------------------------------------------------------- review fixes (2026-11-04)

const setAir = (epId: number, air: number | null) => cache.prepare("UPDATE episodes SET air_utc = ? WHERE id = ?").run(air, epId);

test("⚡: the day for the usual subbers applies here too; an unknown air time counts as not yet eligible", async () => {
  const EP = 9006;
  const now = Date.now();
  const only = (ids: number[]) => [r("Last.Show.S01E06.1080p.WEB-DL-GRP", ids)];
  for (const [air, grabs] of [
    [now - 3 * 3_600_000, 0],
    [null, 0],
    [now + 3_600_000, 0],
    [now - 25 * 3_600_000, 1],
  ] as const) {
    setAir(EP, air);
    const { d, grabbed } = autoDeps(only);
    await autoSearchEpisodes(TVDB, [EP], d);
    assert.equal(grabbed.length, grabs, `air time ${air}`);
  }
});

test("managed search: an unknown air time in the search row counts as not yet eligible, not as aired in 1970", async () => {
  const sent: string[] = [];
  const grab = (async (req: { candidate: { title: string } }) => (
    sent.push(req.candidate.title),
    { id: 1, dryRun: false, message: "Sent" }
  )) as never;
  const now = Date.now();
  setAir(9006, null);
  const row = { ...stRow(9006, "new", 0), air_utc: null } as never;
  await decideEpisode(row, now, { search: managedSearch([r("Last.Show.S01E06-GRP", [9006])]), grab });
  assert.deepEqual(sent, []);
});

/** Pipeline deps whose download client can be switched off: a refused send leaves a failed grab row that never reached it. */
function flakyClient() {
  const flaky = { down: true };
  const pdeps = {
    clients: {
      addNzb: async () => ({ client: "sabnzbd", ref: "x" }),
      addTorrent: async (_f: unknown, title: string) => {
        if (flaky.down) throw new Error("connection refused");
        return { client: "qbittorrent", ref: `h-${title}` };
      },
      remove: async () => undefined,
      status: async () => ({ state: "downloading", progress: 0.1, path: "" }),
    },
    fetchRelease: async () => ({ data: Buffer.from("d8:announce0:e"), filename: "x.torrent" }),
    sleep: async () => undefined,
    refreshSeries: async () => undefined,
    cleanup: async () => null,
  } as unknown as PDeps;
  return { flaky, grab: ((req: Parameters<typeof startGrab>[0]) => startGrab(req, pdeps)) as typeof startGrab };
}

test("send failures (client down) don't use up the cap: once it answers again a last resort is still allowed", async () => {
  const EP = 9007;
  const names = [1, 2, 3, 4].map((n) => `Last.Show.S01E07.1080p.WEB-DL-SND${n}`);
  const { flaky, grab } = flakyClient();
  const results = () => names.map((n) => r(n, [EP]));
  setAir(EP, 0);
  await decideEpisode(stRow(EP, "backlog", 0), Date.now(), { search: managedSearch(results()), grab });
  const rows = db.prepare("SELECT state, client FROM grabs WHERE episode_ids = ?").all(`[${EP}]`) as {
    state: string;
    client: string | null;
  }[];
  assert.ok(rows.length >= LAST_RESORT_CAP, `${rows.length} send attempts`);
  assert.ok(rows.every((x) => x.state === "failed" && x.client === null));
  assert.equal(lastResortsUsed(EP), 0, "nothing reached the client");
  flaky.down = false;
  await decideEpisode(stRow(EP, "backlog", 0), Date.now(), { search: managedSearch(results()), grab });
  assert.ok(
    db.prepare("SELECT 1 FROM grabs WHERE state = 'downloading' AND episode_ids = ?").get(`[${EP}]`),
    "sent after the client recovered",
  );
  assert.equal(lastResortsUsed(EP), 1);
});

test("a last resort covers exactly the one target episode: a season pack of unknown language is never picked", () => {
  const EP = 9008;
  setAir(EP, 0);
  const pack = r("Last.Show.S01.1080p.WEB-DL-PACK", [9001, 9002, 9003, 9004, 9005, 9006, EP, 9009]);
  const single = r("Last.Show.S01E08.1080p.WEB-DL-ONE", [EP], { p: 0.35 });
  const both = lastResortPicks([{ ...pack, rank: { ...pack.rank, langProb: 0.4 } }, single], TVDB, 1, EP);
  assert.deepEqual(
    both.picks.map((x) => x.title),
    [single.title],
  );
  assert.deepEqual(lastResortPicks([pack], TVDB, 1, EP).picks, []);
});
