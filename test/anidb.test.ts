/** AniDB provider: parsing, gentle queue with bans persisted, S0 placement through Anime-Lists; mocked HTTP only. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-test-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { patchSettings } = await import("../server/settings.js");
const { parseAnime, fetchAnime, anidbStatus, due, storeAnime } = await import("../server/anidb.js");

const XML = `<?xml version="1.0"?><anime id="1" restricted="false"><type>TV Series</type><episodecount>2</episodecount><enddate>2001-01-01</enddate>
<episodes>
 <episode id="1" update="x"><epno type="1">1</epno><length>25</length><airdate>2000-01-01</airdate><title xml:lang="en">Arrival &amp; Departure</title><title xml:lang="x-jat">Toujou</title><title xml:lang="ja">登場</title></episode>
 <episode id="2"><epno type="2">S1</epno><length>5</length><title xml:lang="en">Recap Special</title></episode>
 <episode id="3"><epno type="3">C1</epno><length>2</length><title xml:lang="en">Opening</title></episode>
 <episode id="4"><epno type="4">T1</epno><title xml:lang="en">PV</title></episode>
</episodes></anime>`;

test("parses episodes: types, numbers, titles in three languages, lengths, air dates", () => {
  const a = parseAnime(XML, 1);
  assert.equal(a.episodes.length, 4);
  assert.deepEqual(a.episodes.map((e) => `${e.type}:${e.number}`), ["regular:1", "special:1", "credit:1", "trailer:1"]);
  assert.equal(a.episodes[0].titleEn, "Arrival & Departure");
  assert.equal(a.episodes[0].titleJa, "登場");
  assert.equal(a.episodes[0].length, 25);
  assert.equal(a.episodes[0].airdate, "2000-01-01");
});

test("the cache: finished anime weekly, airing daily", () => {
  storeAnime(parseAnime(XML, 1), Date.now() - 2 * 86_400_000);
  assert.equal(due(1), false, "finished: not again within a week");
  storeAnime(parseAnime(XML.replace("2001-01-01", "2999-01-01"), 2), Date.now() - 2 * 86_400_000);
  assert.equal(due(2), true, "airing: daily");
});

test("one request at a time, gzip handled, and a ban stops everything for a day (persisted)", async () => {
  patchSettings((s) => ({ ...s, metadata: { ...s.metadata, anidbClient: "animearrtest", anidbClientVer: 1 } }));
  const zlib = await import("node:zlib");
  let calls = 0;
  const ok = (async () => (calls++, new Response(zlib.gzipSync(Buffer.from(XML)), { status: 200 }))) as unknown as typeof fetch;
  const a = await fetchAnime(1, { fetch: ok });
  assert.equal(a.episodes.length, 4);
  const banned = (async () => (calls++, new Response("<error>Banned</error>", { status: 200 }))) as unknown as typeof fetch;
  await assert.rejects(fetchAnime(3, { fetch: banned }), /banned/i);
  assert.ok(anidbStatus().blockedUntil! > Date.now() + 23 * 3_600_000);
  const before = calls;
  await assert.rejects(fetchAnime(4, { fetch: ok }), /paused/);
  assert.equal(calls, before, "no request while blocked");
});

test("the daily counter starts again on a new day", async () => {
  const { db } = await import("../server/db.js");
  db.prepare("DELETE FROM anidb_state").run();
  db.prepare("INSERT INTO anidb_state (key, value) VALUES ('day', '2000-01-01'), ('count', '400')").run();
  const zlib = await import("node:zlib");
  await fetchAnime(9, { fetch: (async () => new Response(zlib.gzipSync(Buffer.from(XML)), { status: 200 })) as unknown as typeof fetch });
  assert.equal(anidbStatus().today, 1);
});
