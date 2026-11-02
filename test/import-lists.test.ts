/** Import lists: AniList/MAL parsing, status filtering, library skip, exclusions, the first-sync preview, and that a list never removes. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-lists-"));
process.env.ANIMEARR_NO_LOCK = "1";
fs.mkdirSync(path.join(process.env.ANIMEARR_CONFIG, "cache"), { recursive: true });
fs.writeFileSync(
  path.join(process.env.ANIMEARR_CONFIG, "cache", "anime-list-master.xml"),
  `<anime-list>
    <anime anidbid="5001" tvdbid="777" defaulttvdbseason="1" episodeoffset=""><name>Harbor Tales</name></anime>
    <anime anidbid="5002" tvdbid="778" defaulttvdbseason="1" episodeoffset=""><name>Second Show</name></anime>
    <anime anidbid="5003" tvdbid="779" defaulttvdbseason="1" episodeoffset=""><name>Third Show</name></anime>
    <anime anidbid="5005" tvdbid="781" defaulttvdbseason="1" episodeoffset=""><name>Fifth Show</name></anime>
    <anime anidbid="5006" tvdbid="781" defaulttvdbseason="2" episodeoffset=""><name>Fifth Show S2</name></anime>
  </anime-list>`,
);

const { cache, db } = await import("../server/system/db.js");
const { patchSettings, getSettings } = await import("../server/system/settings.js");
const { createTag, tagsOf } = await import("../server/tags.js");
const { listActivity } = await import("../server/system/activity.js").then((_m) => ({
  listActivity: () => db.prepare("SELECT kind, why FROM decisions ORDER BY id").all() as { kind: string; why: string }[],
}));
const L = await import("../server/importLists.js");
type AniMedia = import("../server/metadata/anilist.js").AniMedia;

const media = (id: number): AniMedia => ({
  id,
  idMal: 9000 + id,
  title: { romaji: `Romaji ${id}`, english: `Show ${id}`, native: null },
  synonyms: [],
  format: id === 604 ? "MOVIE" : "TV",
  status: "FINISHED",
  episodes: 2,
  duration: 24,
  season: null,
  seasonYear: 2020,
  startDate: { year: 2020, month: 1, day: 1 },
  endDate: { year: 2020, month: 1, day: 8 },
  countryOfOrigin: "JP",
  coverImage: { large: null, color: null },
  bannerImage: null,
  description: "",
  genres: [],
  isAdult: false,
  relations: { edges: [] },
  airingSchedule: {
    nodes: [
      { episode: 1, airingAt: 1577836800 },
      { episode: 2, airingAt: 1578441600 },
    ],
  },
  nextAiringEpisode: null,
  streamingEpisodes: [],
});
const fribb = async () => ({
  mtime: 0,
  anidbToAnilist: new Map([
    [5001, 601],
    [5002, 602],
    [5003, 603],
    [5005, 605],
    [5006, 606],
  ]),
  anilistToAnidb: new Map([
    [601, 5001],
    [602, 5002],
    [603, 5003],
    [605, 5005],
    [606, 5006],
  ]),
  anilistToAnidbAll: new Map<number, number[]>(),
  anilistToTmdb: new Map([[604, 4040]]),
});
let account: { id: number; status: L.ListStatus }[] = [];
const deps = (): L.ListDeps => ({
  fetcher: fetch,
  media: async (ids) => ids.filter((i) => i !== 699).map(media),
  fribb,
  entries: async () => account,
});
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const base = (over: Record<string, unknown> = {}) => ({
  name: "My list",
  source: "anilist",
  username: "someone",
  statuses: ["CURRENT", "PLANNING"],
  rootFolder: "/media/Anime",
  movieRootFolder: "/media/Movies",
  ...over,
});
const seriesCount = () => (db.prepare("SELECT COUNT(*) AS n FROM native_series").get() as { n: number }).n;
const wipe = () => {
  db.exec(
    "DELETE FROM import_lists; DELETE FROM import_list_exclusions; DELETE FROM native_series; DELETE FROM native_movies; DELETE FROM decisions;",
  );
  cache.exec("DELETE FROM series; DELETE FROM episodes; DELETE FROM movies;");
};

before(() => {
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/Anime", "/media/Movies"],
    localPathMappings: [
      { from: "/media/Anime", to: os.tmpdir() },
      { from: "/media/Movies", to: os.tmpdir() },
    ],
    lists: { intervalHours: 6, malClientId: "client-123" },
  }));
});

test("AniList: statuses, chunks and duplicates (a custom list repeats an entry) are read; a missing user is a clear error", async () => {
  const pages = [
    {
      MediaListCollection: {
        hasNextChunk: true,
        lists: [
          {
            entries: [
              { mediaId: 1, status: "CURRENT" },
              { mediaId: 2, status: "PLANNING" },
            ],
          },
          { entries: [{ mediaId: 1, status: "CURRENT" }] },
        ],
      },
    },
    {
      MediaListCollection: {
        hasNextChunk: false,
        lists: [
          {
            entries: [
              { mediaId: 3, status: "REPEATING" },
              { mediaId: 4, status: "SOMETHING" },
            ],
          },
        ],
      },
    },
  ];
  const asked: { u: string; c: number }[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    const v = JSON.parse(String(init.body)).variables;
    asked.push(v);
    return json({ data: pages[v.c - 1] });
  }) as unknown as typeof fetch;
  const r = await L.anilistUserEntries("someone", f);
  assert.deepEqual(r, [
    { id: 1, status: "CURRENT" },
    { id: 2, status: "PLANNING" },
    { id: 3, status: "REPEATING" },
  ]);
  assert.deepEqual(
    asked.map((a) => a.c),
    [1, 2],
  );
  const none = (async () => json({ data: { MediaListCollection: null } })) as unknown as typeof fetch;
  await assert.rejects(L.anilistUserEntries("ghost", none), /not found or the list is private/);
});

test("MyAnimeList: statuses map onto AniList's (rewatching too), ids map through the catalog or AniList, and it needs a client ID", async () => {
  await assert.rejects(L.malUserEntries("someone", ""), /client ID/);
  db.prepare("INSERT INTO entries (anilist_id, mal_id, kind, title_romaji, fetched_at) VALUES (801, 1, 'TV', 'Known', 0)").run();
  const seen: string[] = [];
  const f = (async (url: string, init: RequestInit) => {
    if (String(url).includes("graphql.anilist.co")) {
      seen.push("anilist");
      assert.deepEqual(JSON.parse(String(init.body)).variables.ids, [2, 3, 4, 5, 6]);
      return json({
        data: {
          Page: {
            media: [
              { id: 802, idMal: 2 },
              { id: 803, idMal: 3 },
              { id: 804, idMal: 4 },
            ],
          },
        },
      });
    }
    assert.equal((init.headers as Record<string, string>)["X-MAL-CLIENT-ID"], "client-123");
    seen.push(String(url));
    if (!String(url).includes("offset=1")) {
      return json({
        data: [
          { node: { id: 1 }, list_status: { status: "watching" } },
          { node: { id: 2 }, list_status: { status: "completed" } },
          { node: { id: 3 }, list_status: { status: "plan_to_watch" } },
        ],
        paging: { next: "https://api.myanimelist.net/v2/users/someone/animelist?offset=1" },
      });
    }
    return json({
      data: [
        { node: { id: 4 }, list_status: { status: "on_hold" } },
        { node: { id: 5 }, list_status: { status: "watching", is_rewatching: true } },
        { node: { id: 6 }, list_status: { status: "dropped" } },
      ],
    });
  }) as unknown as typeof fetch;
  const r = await L.malUserEntries("someone", "client-123", f);
  assert.deepEqual(r, [
    { id: 801, status: "CURRENT" },
    { id: 802, status: "COMPLETED" },
    { id: 803, status: "PLANNING" },
    { id: 804, status: "PAUSED" },
  ]);
  assert.ok(seen.some((u) => u.includes("/v2/users/someone/animelist")));
  const priv = (async () => new Response("", { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(L.malUserEntries("someone", "client-123", priv), /private/);
  const bad = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(L.malUserEntries("someone", "client-123", bad), /refused the client ID/);
});

test("the list form is checked: source, username, at least one status, known folders and profile", () => {
  assert.throws(() => L.cleanList(base({ source: "plex" })), /AniList or MyAnimeList/);
  assert.throws(() => L.cleanList(base({ username: "  " })), /username/);
  assert.throws(() => L.cleanList(base({ statuses: ["NOPE"] })), /at least one/);
  assert.throws(() => L.cleanList(base({ rootFolder: "/etc" })), /library folders/);
  assert.throws(() => L.cleanList(base({ profileId: "nope" })), /Unknown profile/);
  const ok = L.cleanList(base({ name: "", statuses: ["CURRENT", "CURRENT", "DROPPED"], tags: [999] }));
  assert.deepEqual(ok.statuses, ["CURRENT", "DROPPED"]);
  assert.equal(ok.name, "AniList: someone");
  assert.deepEqual(ok.tags, [], "unknown tags are ignored");
  assert.equal(ok.then, "none");
});

test("planning: only the chosen statuses; library, excluded and unknown entries are skipped with a reason", async () => {
  wipe();
  account = [
    { id: 601, status: "CURRENT" },
    { id: 602, status: "PLANNING" },
    { id: 603, status: "COMPLETED" },
    { id: 605, status: "CURRENT" },
    { id: 606, status: "PLANNING" },
    { id: 699, status: "CURRENT" },
    { id: 604, status: "PLANNING" },
    { id: 607, status: "DROPPED" },
  ];
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, title, path, monitored, synced_at) VALUES (1, 777, 'Show 601', '/media/Anime/Show 601', 1, 0)",
    )
    .run(); // in the library (Sonarr's copy)
  L.addExclusion(605, "Fifth Show");
  const plan = await L.planList(
    { source: "anilist", username: "x", statuses: ["CURRENT", "PLANNING"], rootFolder: "/media/Anime", movieRootFolder: "" },
    deps(),
  );
  assert.equal(plan.total, 8);
  assert.equal(plan.matched, 6, "the completed and the dropped one aren't wanted");
  const by = Object.fromEntries(plan.items.map((i) => [i.anilistId, i.reason ?? i.action]));
  assert.deepEqual(by, { 601: "in library", 602: "add", 605: "excluded", 606: "add", 699: "not on AniList", 604: "add" });
  assert.equal(plan.items.find((i) => i.anilistId === 604)?.kind, "movie");
  // a movie with no movie folder at all is skipped, not forced into the show folder
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/Anime"] }));
  const noMovies = await L.planList(
    { source: "anilist", username: "x", statuses: ["PLANNING"], rootFolder: "/media/Anime", movieRootFolder: "" },
    deps(),
  );
  assert.equal(noMovies.items.find((i) => i.anilistId === 604)?.reason, "no movie folder");
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/Anime", "/media/Movies"] }));
});

test("another season of a show that is in the library, or listed twice, is not a new show", async () => {
  wipe();
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, title, path, monitored, synced_at) VALUES (2, 781, 'Fifth Show', '/media/Anime/Fifth Show', 1, 0)",
    )
    .run();
  account = [{ id: 606, status: "CURRENT" }];
  const p = await L.planList(
    { source: "anilist", username: "x", statuses: ["CURRENT"], rootFolder: "/media/Anime", movieRootFolder: "" },
    deps(),
  );
  assert.equal(p.items[0].reason, "in library");
  cache.exec("DELETE FROM series");
  account = [
    { id: 605, status: "CURRENT" },
    { id: 606, status: "CURRENT" },
  ];
  const q = await L.planList(
    { source: "anilist", username: "x", statuses: ["CURRENT"], rootFolder: "/media/Anime", movieRootFolder: "" },
    deps(),
  );
  assert.deepEqual(
    q.items.map((i) => i.reason ?? i.action),
    ["add", "same show as another entry"],
  );
});

test("the first sync only previews; confirming adds with the list's profile, tags and practice mode; later syncs add by themselves", async () => {
  wipe();
  const tag = createTag("from-list").id;
  const l = L.saveList(null, base({ tags: [tag], then: "queue" }));
  account = [
    { id: 601, status: "CURRENT" },
    { id: 602, status: "PLANNING" },
    { id: 603, status: "COMPLETED" },
  ];
  const first = await L.syncList(l.id, { deps: deps() });
  assert.equal(first.preview, true);
  assert.equal(first.wouldAdd, 2);
  assert.equal(seriesCount(), 0, "nothing is added before the confirm");
  assert.equal(L.getList(l.id).lastResult.pending, true);
  assert.deepEqual(
    L.getList(l.id).lastResult.wouldAdd?.map((x) => x.title),
    ["Show 601", "Show 602"],
  );
  // a second unconfirmed run is still only a preview
  assert.equal((await L.syncList(l.id, { deps: deps() })).preview, true);
  assert.equal(seriesCount(), 0);

  const done = await L.syncList(l.id, { confirm: true, deps: deps() });
  assert.equal(done.preview, false);
  assert.equal(done.added, 2);
  assert.equal(seriesCount(), 2);
  assert.equal(L.getList(l.id).confirmed, true);
  assert.deepEqual(tagsOf("series", 777), [tag]);
  const managed = db.prepare("SELECT dry_run FROM managed WHERE tvdb_id = 777").get() as { dry_run: number };
  assert.equal(managed.dry_run, 1, "practice mode is on, so the show is managed but not live");
  assert.equal(getSettings().managed.dryRun, true);
  assert.ok(db.prepare("SELECT 1 FROM fill_queue WHERE tvdb_id = 777").get(), "'then: queue' puts it in the fill-in queue");
  const log = listActivity();
  assert.ok(
    log.some((r) => r.why.includes('Added from AniList list "My list": Show 601')),
    JSON.stringify(log.map((r) => r.why)),
  );

  // later: a new planning entry is added automatically, the library isn't touched otherwise
  account.push({ id: 605, status: "PLANNING" });
  const later = await L.syncList(l.id, { deps: deps() });
  assert.equal(later.preview, false);
  assert.equal(later.added, 1);
  assert.equal(seriesCount(), 3);
  assert.deepEqual(
    L.getList(l.id).lastResult.added?.map((a) => a.title),
    ["Show 605", "Show 602", "Show 601"],
  );
});

test("a list never removes or unmonitors: shows that leave the account, or change status, stay as they are", async () => {
  wipe();
  const l = L.saveList(null, base());
  account = [
    { id: 601, status: "CURRENT" },
    { id: 602, status: "PLANNING" },
  ];
  await L.syncList(l.id, { confirm: true, deps: deps() });
  assert.equal(seriesCount(), 2);
  const before = db.prepare("SELECT COUNT(*) AS n FROM managed").get() as { n: number };
  account = [{ id: 601, status: "DROPPED" }]; // 602 left the list, 601 was dropped
  const r = await L.syncList(l.id, { deps: deps() });
  assert.equal(r.added, 0);
  assert.equal(seriesCount(), 2);
  assert.deepEqual(db.prepare("SELECT COUNT(*) AS n FROM managed").get(), before);
  account = [];
  await L.syncList(l.id, { deps: deps() });
  assert.equal(seriesCount(), 2, "an empty account removes nothing either");
});

test("an excluded show is never added, and removing the exclusion lets the next sync add it", async () => {
  wipe();
  const l = L.saveList(null, base());
  account = [
    { id: 601, status: "CURRENT" },
    { id: 602, status: "CURRENT" },
  ];
  L.addExclusion(602, "Show 602");
  L.addExclusion(602, "again"); // twice is fine
  assert.equal(L.exclusions().length, 1);
  const r = await L.syncList(l.id, { confirm: true, deps: deps() });
  assert.equal(r.added, 1);
  assert.equal(seriesCount(), 1);
  const next = await L.syncList(l.id, { deps: deps() });
  assert.equal(next.added, 0, "still excluded on the next sync");
  L.removeExclusion(602);
  assert.equal((await L.syncList(l.id, { deps: deps() })).added, 1);
  assert.equal(seriesCount(), 2);
});

test("excluding a removed show also covers the other seasons of it", async () => {
  wipe();
  const l = L.saveList(null, base());
  account = [{ id: 605, status: "CURRENT" }];
  await L.syncList(l.id, { confirm: true, deps: deps() });
  assert.equal(seriesCount(), 1);
  const { removeShow } = await import("../server/native.js");
  const title = "Show 605";
  removeShow(781);
  assert.ok(L.excludeShow(781, title) >= 1);
  assert.ok(L.exclusions().some((x) => x.anilistId === 605));
  assert.equal((await L.syncList(l.id, { deps: deps() })).added, 0);
  assert.equal(seriesCount(), 0);
});

test("a movie on the list is added through the movie path, to the movie folder; a failing item doesn't stop the others", async () => {
  wipe();
  const l = L.saveList(null, base({ statuses: ["PLANNING"], tags: [] }));
  account = [
    { id: 604, status: "PLANNING" },
    { id: 602, status: "PLANNING" },
  ];
  const r = await L.syncList(l.id, { confirm: true, deps: deps() });
  assert.equal(r.added, 2);
  const m = db.prepare("SELECT path FROM native_movies").get() as { path: string };
  assert.ok(m.path.startsWith("/media/Movies/"), m.path);
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/Movies"] })); // the show folder is no longer a library folder: that add fails
  wipe();
  account = [
    { id: 602, status: "PLANNING" },
    { id: 604, status: "PLANNING" },
  ];
  const l2 = L.saveList(null, base({ statuses: ["PLANNING"], rootFolder: "", movieRootFolder: "/media/Movies" }));
  const r2 = await L.syncList(l2.id, { confirm: true, deps: deps() });
  assert.equal(r2.added, 1, "the movie is added, the show has no folder to go to");
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/Anime", "/media/Movies"] }));
});

test("changing the account or widening the statuses asks for a new confirm; renaming does not", async () => {
  wipe();
  const l = L.saveList(null, base());
  account = [{ id: 601, status: "CURRENT" }];
  await L.syncList(l.id, { confirm: true, deps: deps() });
  assert.equal(
    L.saveList(l.id, base({ name: "Renamed", statuses: ["CURRENT"] })).confirmed,
    true,
    "fewer statuses and a new name are safe",
  );
  assert.equal(L.saveList(l.id, base({ statuses: ["CURRENT", "COMPLETED"] })).confirmed, false, "more statuses");
  await L.syncList(l.id, { confirm: true, deps: deps() });
  assert.equal(L.saveList(l.id, base({ username: "someone-else" })).confirmed, false, "another account");
});

test("the background tick previews a new list once, syncs confirmed lists only when due, and skips disabled ones", async () => {
  wipe();
  const l = L.saveList(null, base());
  const off = L.saveList(null, base({ name: "off", enabled: false }));
  account = [{ id: 601, status: "CURRENT" }];
  const t0 = Date.now();
  await L.importListsTick(t0, deps());
  assert.equal(seriesCount(), 0, "a new list only previews");
  assert.equal(L.getList(l.id).lastResult.pending, true);
  assert.equal(L.getList(off.id).lastSyncAt, null);
  await L.syncList(l.id, { confirm: true, deps: deps() });
  account = [
    { id: 601, status: "CURRENT" },
    { id: 602, status: "CURRENT" },
  ];
  await L.importListsTick(Date.now() + 3_600_000, deps());
  assert.equal(seriesCount(), 1, "not due yet (every 6 hours)");
  await L.importListsTick(Date.now() + 7 * 3_600_000, deps());
  assert.equal(seriesCount(), 2, "due");
});

test("a failing account is recorded on the list and raised", async () => {
  wipe();
  const l = L.saveList(null, base());
  const bad: L.ListDeps = {
    ...deps(),
    entries: async () => {
      throw new Error('AniList user "someone" not found or the list is private');
    },
  };
  await assert.rejects(L.syncList(l.id, { deps: bad }), /not found/);
  assert.match(L.getList(l.id).lastResult.error ?? "", /not found/);
});
