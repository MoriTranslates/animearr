/** The iCal feed: valid structure, folding, escaping, the API key, the date window, monitored-only and the tags filter. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-ical-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/db.js");
const { setAccount, regenerateApiKey } = await import("../server/settings.js");
const { buildIcal, icalEscape, icalFold, icalOptions, registerIcal } = await import("../server/ical.js");
const { createTag, setTags } = await import("../server/tags.js");

const NOW = Date.parse("2026-11-10T12:00:00Z");
const DAY = 86_400_000;
const unfold = (s: string) => s.replace(/\r\n /g, "");
const events = (ics: string) => unfold(ics).split("BEGIN:VEVENT\r\n").slice(1).map((e) => e.split("END:VEVENT")[0]);
const field = (ev: string, name: string) => new RegExp(`^${name}[;:](.*)$`, "m").exec(ev)?.[0];

let KEY = "";
const app = Fastify();
await app.register(fastifyCookie);
registerIcal(app);

before(async () => {
  await setAccount("owner", "owners-own-password");
  KEY = regenerateApiKey();
  // A managed show with episodes at -10, -2, +3 and +40 days; an unmonitored show with one in the window; a movie.
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, runtime, synced_at) VALUES (1, 111, 'Harbor Tales; Part, One', '/m/a', 1, 25, 0)").run();
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, runtime, synced_at) VALUES (2, 222, 'Quiet Cove', '/m/b', 1, NULL, 0)").run();
  const ep = cache.prepare("INSERT INTO episodes (id, series_id, season, episode, absolute, title, monitored, has_file, air_utc, runtime) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)");
  ep.run(10, 1, 1, 1, 1, "Too old", NOW - 10 * DAY, 24);
  ep.run(11, 1, 1, 5, 17, "The Long, Long Title; with a back\\slash and enough words to force the content line past seventy-five octets", NOW - 2 * DAY, 22);
  ep.run(12, 1, 1, 6, 18, null, NOW + 3 * DAY, null);
  ep.run(13, 1, 1, 7, 19, "Far away", NOW + 40 * DAY, 24);
  ep.run(20, 2, 1, 1, 1, "Unwatched", NOW + 1 * DAY, 24);
  db.prepare("INSERT INTO managed (tvdb_id, series_id, title, dry_run, since) VALUES (111, 1, 'Harbor Tales', 1, 0)").run();
  cache.prepare("INSERT INTO movies (id, tmdb_id, title, year, path, monitored, has_file, is_anime, digital_release, synced_at) VALUES (900000007, 9, 'Sea Film', 2026, '/m/f', 1, 0, 1, ?, 0)").run(Date.UTC(2026, 10, 12));
  setTags("series", 111, [createTag("dubs").id]);
});

test("escaping and folding follow RFC 5545", () => {
  assert.equal(icalEscape("a;b,c\\d\ne"), "a\\;b\\,c\\\\d\\ne");
  const long = "SUMMARY:" + "ああ".repeat(60) + " end";
  const folded = icalFold(long).split("\r\n");
  assert.ok(folded.length > 2);
  for (const [i, l] of folded.entries()) {
    assert.ok(Buffer.byteLength(l, "utf8") <= 75, `line ${i} is ${Buffer.byteLength(l, "utf8")} octets`);
    if (i > 0) assert.ok(l.startsWith(" "));
  }
  assert.equal(folded.map((l, i) => (i ? l.slice(1) : l)).join(""), long, "unfolding gives the original, no character split");
  assert.equal(icalFold("short"), "short");
});

test("the feed is a valid calendar: CRLF, required properties, UTC times, stable UIDs", () => {
  const ics = buildIcal(icalOptions({ unmonitored: "true" }), NOW);
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.ok(!/[^\r]\n/.test(ics), "every line ends in CRLF");
  for (const l of ics.split("\r\n")) assert.ok(Buffer.byteLength(l, "utf8") <= 75);
  assert.ok(unfold(ics).includes("PRODID:"));
  const evs = events(ics);
  assert.equal(evs.length, 4, "S01E05, S01E06, the other show's episode and the movie; the old and far ones are outside the window");
  for (const e of evs) {
    assert.ok(/^UID:animearr-(episode|movie)-[\w-]+@animearr$/m.test(e));
    assert.ok(/^DTSTAMP:20261110T120000Z$/m.test(e));
    assert.ok(/^SUMMARY:/m.test(e));
  }
  assert.equal(buildIcal(icalOptions({ unmonitored: "true" }), NOW), ics, "the same moment gives the same feed");
});

test("an episode: UTC start, runtime as the duration, number, absolute number and title", () => {
  const e = events(buildIcal(icalOptions({ unmonitored: "true" }), NOW)).find((x) => x.includes("episode-11@"))!;
  assert.equal(field(e, "DTSTART"), `DTSTART:${new Date(NOW - 2 * DAY).toISOString().replace(/[-:]|\.\d+/g, "")}`);
  assert.equal(field(e, "DTEND"), `DTEND:${new Date(NOW - 2 * DAY + 22 * 60_000).toISOString().replace(/[-:]|\.\d+/g, "")}`);
  const summary = field(e, "SUMMARY")!;
  assert.ok(summary.startsWith("SUMMARY:Harbor Tales\\; Part\\, One – S01E05 (#17) – The Long\\, Long Title\\; with a back\\\\slash"), summary);
  // no episode runtime: the show's (25 minutes); no title: just the number; none anywhere: 24 minutes
  const noTitle = events(buildIcal(icalOptions({ unmonitored: "true" }), NOW)).find((x) => x.includes("episode-12@"))!;
  assert.equal(field(noTitle, "SUMMARY"), "SUMMARY:Harbor Tales\\; Part\\, One – S01E06 (#18)");
  assert.ok(field(noTitle, "DTEND")!.endsWith(new Date(NOW + 3 * DAY + 25 * 60_000).toISOString().replace(/[-:]|\.\d+/g, "")));
  const quiet = events(buildIcal(icalOptions({ unmonitored: "true" }), NOW)).find((x) => x.includes("episode-20@"))!;
  assert.ok(field(quiet, "DTEND")!.endsWith(new Date(NOW + DAY + 24 * 60_000).toISOString().replace(/[-:]|\.\d+/g, "")));
  assert.ok(!field(quiet, "SUMMARY")!.includes("(#"), "no absolute number when it equals the episode number");
});

test("a movie is an all-day event on its release date", () => {
  const m = events(buildIcal(icalOptions({ unmonitored: "true" }), NOW)).find((x) => x.includes("movie-900000007-digital@"))!;
  assert.equal(field(m, "DTSTART"), "DTSTART;VALUE=DATE:20261112");
  assert.equal(field(m, "DTEND"), "DTEND;VALUE=DATE:20261113");
  assert.equal(field(m, "SUMMARY"), "SUMMARY:Sea Film (2026) – Digital release");
});

test("pastDays and futureDays set the window; unmonitored is off by default", () => {
  const ids = (q: Record<string, string>) => events(buildIcal(icalOptions(q), NOW)).map((e) => /^UID:animearr-(\S+)@/m.exec(e)![1]).sort();
  assert.deepEqual(ids({ unmonitored: "true" }), ["episode-11", "episode-12", "episode-20", "movie-900000007-digital"]);
  assert.deepEqual(ids({}), ["episode-11", "episode-12"], "only the managed show; the movie isn't wanted");
  assert.deepEqual(ids({ unmonitored: "true", pastDays: "15", futureDays: "1" }), ["episode-10", "episode-11", "episode-20"]);
  assert.deepEqual(ids({ unmonitored: "true", pastDays: "0", futureDays: "60" }), ["episode-12", "episode-13", "episode-20", "movie-900000007-digital"]);
  assert.deepEqual(icalOptions({ pastDays: "-3", futureDays: "abc" }), { pastDays: 7, futureDays: 28, unmonitored: false, tags: [] }, "bad values fall back to the defaults");
});

test("tags keep only shows and movies with one of the tags", () => {
  const dubs = createTag("dubs").id;
  const other = createTag("other").id;
  const ids = (q: Record<string, string>) => events(buildIcal(icalOptions(q), NOW)).map((e) => /^UID:animearr-(\S+)@/m.exec(e)![1]).sort();
  assert.deepEqual(ids({ unmonitored: "true", tags: String(dubs) }), ["episode-11", "episode-12"]);
  assert.deepEqual(ids({ unmonitored: "true", tags: `${other},${dubs}` }), ["episode-11", "episode-12"]);
  assert.deepEqual(ids({ unmonitored: "true", tags: String(other) }), []);
  assert.deepEqual(icalOptions({ tags: "999, x" }).tags, [], "unknown tags are ignored");
});

test("the route needs the API key (query or header) and answers text/calendar", async () => {
  const no = await app.inject({ method: "GET", url: "/feed/calendar/animearr.ics" });
  assert.equal(no.statusCode, 401);
  const bad = await app.inject({ method: "GET", url: "/feed/calendar/animearr.ics?apikey=nope" });
  assert.equal(bad.statusCode, 401);
  const ok = await app.inject({ method: "GET", url: `/feed/calendar/animearr.ics?apikey=${KEY}&unmonitored=true` });
  assert.equal(ok.statusCode, 200);
  assert.match(String(ok.headers["content-type"]), /^text\/calendar; charset=utf-8/);
  assert.ok(ok.body.startsWith("BEGIN:VCALENDAR\r\n"));
  const header = await app.inject({ method: "GET", url: "/feed/calendar/animearr.ics", headers: { "x-api-key": KEY } });
  assert.equal(header.statusCode, 200);
});
