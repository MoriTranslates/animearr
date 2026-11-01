/** "- 001" of a whole-show pack could be S01E01 or the newest season's E01: the grab's own episodes settle it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-expect-"));
process.env.ANIMEARR_NO_LOCK = "1";
const { parseRelease } = await import("../server/core/parser.js");
const { resolveRelease } = await import("../server/core/resolver.js");

const ep = (id: number, season: number, episode: number, absolute: number) => ({ id, season, episode, absolute, sceneSeason: null, sceneEpisode: null, sceneAbsolute: null, airUtc: 0, title: `Ep ${id}` });
const lib = [ep(1, 1, 1, 1), ep(2, 1, 2, 2), ep(3, 1, 3, 3), ep(101, 2, 1, 4), ep(102, 2, 2, 5)];
const cand = { tvdbId: 1, seriesId: 1, aid: null, impliedSeason: null, entry: null, score: 100, inLibrary: true, matchedTitle: "Show", source: "library", inferred: false, why: [] } as never;
const name = "[Erai-raws] Show (TV) - 001 [1080p][Multiple Subtitle][284B3626].mkv";

test("without a grab, a bare 001 stays ambiguous (absolute S01E01 or the newest season's E01)", () => {
  const r = resolveRelease(parseRelease(name), cand, lib);
  assert.ok(r.ok);
  assert.ok(r.confidence <= 70, String(r.confidence));
  assert.match(r.why.join(" "), /ambiguous/);
});

test("a grab for season 1 picks S01E01 at full confidence", () => {
  const r = resolveRelease(parseRelease(name), cand, lib, { expect: [1, 2, 3] });
  assert.ok(r.ok);
  assert.deepEqual(r.episodes.map((e) => e.id), [1]);
  assert.ok(r.confidence > 80, String(r.confidence));
  assert.match(r.why.join(" "), /grabbed for it/);
});

test("a grab for season 2 picks S02E01", () => {
  const r = resolveRelease(parseRelease(name), cand, lib, { expect: [101, 102] });
  assert.ok(r.ok);
  assert.deepEqual(r.episodes.map((e) => e.id), [101]);
});
