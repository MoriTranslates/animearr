/** ▶ Trailer: AniList's trailer normalised (YouTube/Dailymotion, safe ids only) and the player/watch links built from it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-trailer-"));
process.env.ANIMEARR_NO_LOCK = "1";
const { normTrailer } = await import("../server/anilist.js");
const { trailerLinks } = await import("../web/src/trailerLinks.js");

test("normTrailer keeps YouTube and Dailymotion trailers with a plain id", () => {
  assert.deepEqual(normTrailer({ id: "dQw4w9WgXcQ", site: "youtube", thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" }), { site: "youtube", id: "dQw4w9WgXcQ", thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" });
  assert.deepEqual(normTrailer({ id: "x8abcd1", site: "Dailymotion", thumbnail: null }), { site: "dailymotion", id: "x8abcd1", thumbnail: null });
  assert.equal(normTrailer({ id: "a_b-C", site: "youtube", thumbnail: "http://insecure/x.jpg" })?.thumbnail, null, "only https thumbnails");
});

test("normTrailer drops missing, unknown-site and odd-id trailers", () => {
  for (const raw of [null, undefined, "youtube", {}, { id: null, site: "youtube" }, { id: "abc", site: "vimeo" }, { id: "abc", site: null }, { id: "a/b", site: "youtube" }, { id: "a?b=1", site: "youtube" }, { id: "", site: "youtube" }, { id: "x".repeat(65), site: "youtube" }, { id: 123, site: "youtube" }])
    assert.equal(normTrailer(raw), null, JSON.stringify(raw));
});

test("trailerLinks builds the player and the open-on-site links", () => {
  assert.deepEqual(trailerLinks({ site: "youtube", id: "dQw4w9WgXcQ" }), { embed: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0", watch: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", site: "YouTube" });
  assert.deepEqual(trailerLinks({ site: "dailymotion", id: "x8abcd1" }), { embed: "https://www.dailymotion.com/embed/video/x8abcd1", watch: "https://www.dailymotion.com/video/x8abcd1", site: "Dailymotion" });
});

test("trailerLinks refuses ids that aren't plain (never builds a URL from them)", () => {
  assert.equal(trailerLinks(null), null);
  assert.equal(trailerLinks({ site: "youtube", id: "../../evil" }), null);
  assert.equal(trailerLinks({ site: "youtube", id: "abc\"onload=x" }), null);
  assert.equal(trailerLinks({ site: "vimeo" as "youtube", id: "abc" }), null);
});
