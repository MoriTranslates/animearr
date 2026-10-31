/** Tags: Settings CRUD, links to shows and movies, delete unlinks, and the Sonarr API's /tag round-trip. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-tags-"));
process.env.ANIMEARR_NO_LOCK = "1";
fs.mkdirSync(path.join(process.env.ANIMEARR_CONFIG, "cache"), { recursive: true });
fs.writeFileSync(
  path.join(process.env.ANIMEARR_CONFIG, "cache", "anime-list-master.xml"),
  `<anime-list><anime anidbid="5001" tvdbid="777" defaulttvdbseason="1" episodeoffset=""><name>Harbor Tales</name></anime></anime-list>`,
);

const { db } = await import("../server/db.js");
const { patchSettings, setAccount, regenerateApiKey } = await import("../server/settings.js");
const { guard } = await import("../server/auth.js");
const { registerSonarrApi } = await import("../server/sonarrApi.js");
const { bulkTags, createTag, deleteTag, listTags, renameTag, setTags, tagsOf } = await import("../server/tags.js");
const { listRules, saveRule } = await import("../server/releaseRules.js");
type AniMedia = import("../server/anilist.js").AniMedia;

const media = (id: number): AniMedia => ({
  id, idMal: null, title: { romaji: "Minato Monogatari", english: "Harbor Tales", native: null }, synonyms: [], format: "TV", status: "FINISHED", episodes: 2, duration: 24,
  season: null, seasonYear: 2020, startDate: { year: 2020, month: 1, day: 1 }, endDate: { year: 2020, month: 1, day: 8 }, countryOfOrigin: "JP", coverImage: { large: "https://img.example/cover.jpg", color: null },
  bannerImage: null, description: "", genres: [], isAdult: false, relations: { edges: [] }, airingSchedule: { nodes: [{ episode: 1, airingAt: 1577836800 }, { episode: 2, airingAt: 1578441600 }] },
  nextAiringEpisode: null, streamingEpisodes: [],
});
const fribb = async () => ({ mtime: 0, anidbToAnilist: new Map([[5001, 601]]), anilistToAnidb: new Map([[601, 5001]]), anilistToAnidbAll: new Map<number, number[]>(), anilistToTmdb: new Map<number, number>() });

const app = Fastify();
await app.register(fastifyCookie);
app.addHook("onRequest", guard);
registerSonarrApi(app, {
  urlBase: "",
  deps: {
    media: async (ids) => ids.map(media),
    fribb,
    searchMissing: () => ({ searching: 1 }),
    searchEpisodes: async () => ({ results: [] }),
    searchTitles: async () => ({ results: [], anilist: "ok" as const }),
    queue: async () => ({ items: [] }) as never,
  },
});
let KEY = "";
const call = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, headers: { "x-api-key": KEY }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};

before(async () => {
  await setAccount("owner", "owners-own-password");
  KEY = regenerateApiKey();
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/Anime"], localPathMappings: [{ from: "/media/Anime", to: os.tmpdir() }] }));
});

test("tags: labels are trimmed and lower-case, the same label is the same tag, renames can't collide", () => {
  const a = createTag("  Dubs Only ");
  assert.equal(a.label, "dubs only");
  assert.equal(createTag("dubs only").id, a.id);
  const b = createTag("keep");
  assert.throws(() => renameTag(b.id, "DUBS only"), /already a tag called/);
  assert.deepEqual(renameTag(b.id, "Keep Forever"), { id: b.id, label: "keep forever" });
  assert.throws(() => createTag("   "), /needs a label/);
  assert.throws(() => renameTag(9999, "x"), /not found/);
});

test("tags link to shows and movies; bulk add and remove; delete unlinks everything and reports what it was on", () => {
  const t = createTag("seasonal");
  const u = createTag("old");
  setTags("series", 10, [t.id, u.id, 424242]);
  assert.deepEqual(tagsOf("series", 10), [t.id, u.id], "unknown ids are ignored");
  bulkTags("series", [10, 11, 12], [t.id], [u.id]);
  bulkTags("movie", [5], [t.id], []);
  assert.deepEqual(tagsOf("series", 10), [t.id]);
  assert.deepEqual(tagsOf("series", 12), [t.id]);
  const rule = saveRule(null, { name: "Seasonal only", mustNot: ["cam"], tags: [t.id] });
  const use = listTags().find((x) => x.id === t.id)!;
  assert.deepEqual([use.series, use.movies, use.rules], [3, 1, 1]);
  assert.deepEqual(deleteTag(t.id), { series: 3, movies: 1, rules: 1 });
  assert.deepEqual(tagsOf("series", 10), []);
  assert.deepEqual(tagsOf("movie", 5), []);
  assert.deepEqual(listRules().find((r) => r.id === rule.id)!.tags, []);
  assert.equal(listTags().some((x) => x.id === t.id), false);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tag_links WHERE tag_id = ?").get(t.id) as { n: number }).n, 0);
});

test("Sonarr API: /tag returns the real tags, and tags set in AnimeArr show on series resources", async () => {
  const made = await call("POST", "/api/v3/tag", { label: "Requested " });
  assert.equal(made.status, 201);
  assert.equal(made.body.label, "requested");
  assert.ok(listTags().some((x) => x.id === made.body.id && x.label === "requested"), "created through the API = visible in Settings → Tags");
  const mine = createTag("from settings");
  const all = (await call("GET", "/api/v3/tag")).body as { id: number; label: string }[];
  assert.ok(all.some((x) => x.id === mine.id && x.label === "from settings"));
  const added = await call("POST", "/api/v3/series", { tvdbId: 777, title: "Harbor Tales", seasons: [{ seasonNumber: 1, monitored: true }], tags: [made.body.id, mine.id], monitored: true, rootFolderPath: "/media/Anime", seriesType: "anime" });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.deepEqual(added.body.tags, [made.body.id, mine.id].sort((x, y) => x - y));
  assert.deepEqual(tagsOf("series", 777), added.body.tags, "stored as AnimeArr's own tags");
  setTags("series", 777, [mine.id]);
  assert.deepEqual((await call("GET", `/api/v3/series/${added.body.id}`)).body.tags, [mine.id], "a tag set in AnimeArr is on the resource");
  const edit = await call("PUT", `/api/v3/series/${added.body.id}`, { tags: [made.body.id] });
  assert.deepEqual(edit.body.tags, [made.body.id]);
  assert.equal((await call("PUT", `/api/v3/tag/${made.body.id}`, { label: "Renamed" })).status, 202);
  assert.equal(listTags().find((x) => x.id === made.body.id)!.label, "renamed");
  await call("DELETE", `/api/v3/tag/${made.body.id}`);
  assert.deepEqual((await call("GET", `/api/v3/series/${added.body.id}`)).body.tags, [], "deleting a tag unlinks it from the show");
});

test("the API's old tags table is gone: migration 36 moved its tags (ids kept) into the real ones", () => {
  assert.ok((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version >= 36);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'api_tags'").get(), undefined);
});
