/** Replace season's pack list: packs vs single episodes, coverage-then-quality ranking, and "better than what you have". */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareQuality, height, libraryQuality, ranges, splitPacks, step } from "../web/src/packs.js";

const targets = Array.from({ length: 12 }, (_, i) => ({ id: 100 + i + 1, episode: i + 1 }));
const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => 100 + from + i);
const r = (guid: string, episodeIds: number[], source: string | null = "web", resolution: number | null = 1080, remux = false) => ({ guid, episodeIds, quality: { source, resolution, remux } });

test("singles go to their own list; packs need 2+ of the picked episodes", () => {
  const { packs, singles } = splitPacks([r("e1", [101]), r("whole", ids(1, 12)), r("e2", [102]), r("half", ids(1, 6)), r("other", [101, 999])], targets);
  assert.deepEqual(singles.map((x) => x.guid), ["e1", "e2", "other"], "a release with one of the picked episodes is a single");
  assert.deepEqual(packs.map((x) => x.r.guid), ["whole", "half"]);
  assert.equal(packs[0].whole, true);
  assert.equal(packs[0].covered, 12);
  assert.equal(packs[1].whole, false);
  assert.equal(packs[1].episodes, "1–6");
});

test("whole season first, then upgrades before same before lower, then the server's order", () => {
  const have = { source: "web", resolution: 1080 };
  const list = [r("half-bd", ids(1, 6), "bluray"), r("whole-tv", ids(1, 12), "hdtv"), r("whole-web", ids(1, 12)), r("whole-bd", ids(1, 12), "bluray"), r("whole-unknown", ids(1, 12), null), r("whole-bd-2", ids(1, 12), "bluray")];
  assert.deepEqual(splitPacks(list, targets, have).packs.map((x) => x.r.guid), ["whole-bd", "whole-bd-2", "whole-web", "whole-unknown", "whole-tv", "half-bd"]);
  // No library quality known: coverage, then the server's order.
  assert.deepEqual(splitPacks(list, targets).packs.map((x) => x.r.guid), ["whole-tv", "whole-web", "whole-bd", "whole-unknown", "whole-bd-2", "half-bd"]);
});

test("a one-episode search counts any multi-episode release as a pack", () => {
  const { packs, singles } = splitPacks([r("one", [101]), r("pack", ids(1, 12))], targets.slice(0, 1));
  assert.deepEqual([packs.map((x) => x.r.guid), singles.map((x) => x.guid)], [["pack"], ["one"]]);
});

test("episode ranges read plainly", () => {
  assert.equal(ranges([3, 1, 2, 5, 7, 8, 9]), "1–3, 5, 7–9");
  assert.equal(ranges([4]), "4");
});

test("source ladder: TV < WEB < Blu-ray < remux; resolution from any form", () => {
  assert.ok(step({ source: "hdtv", resolution: null }) < step({ source: "WEB", resolution: null }));
  assert.ok(step({ source: "web", resolution: null }) < step({ source: "BluRay", resolution: null }));
  assert.ok(step({ source: "bluray", resolution: null }) < step({ source: "bluray", resolution: null, remux: true }));
  assert.equal(step({ source: null, resolution: 1080 }), 0);
  assert.equal(height("1920x1036"), 1080);
  assert.equal(height("WEBDL-720p"), 720);
  assert.equal(height(1080), 1080);
  assert.equal(height(null), null);
});

test("compare: upgrade, same and lower quality, named plainly", () => {
  const web = { source: "WEB", resolution: "1920x1080" };
  assert.deepEqual(compareQuality({ source: "bluray", resolution: 1080 }, web), { verdict: "up", from: "WEB-DL", to: "Blu-ray" });
  assert.deepEqual(compareQuality({ source: "web", resolution: 1080 }, web), { verdict: "same", from: "WEB-DL 1080p", to: "WEB-DL 1080p" });
  assert.deepEqual(compareQuality({ source: "web", resolution: 720 }, web), { verdict: "down", from: "WEB-DL 1080p", to: "WEB-DL 720p" });
  assert.deepEqual(compareQuality({ source: "hdtv", resolution: 1080 }, { source: "BluRay", resolution: 1080 }), { verdict: "down", from: "Blu-ray", to: "TV" });
  assert.equal(compareQuality({ source: null, resolution: 1080 }, web).verdict, "unknown");
  assert.equal(compareQuality({ source: "web", resolution: 1080 }, null).verdict, "unknown");
});

test("library quality: the most common source × resolution, with the per-source mix", () => {
  const h = libraryQuality([
    { source: "WEB", resolution: "1920x1080", n: 6 },
    { source: "WEB", resolution: "1920x1036", n: 4 },
    { source: "HDTV", resolution: "1080p", n: 2 },
    { source: null, resolution: null, n: 3 },
  ]);
  assert.ok(h);
  assert.equal(step(h.main), 2);
  assert.equal(height(h.main.resolution), 1080);
  assert.equal(h.files, 12);
  assert.deepEqual(h.bySource, [{ name: "WEB-DL", n: 10 }, { name: "TV", n: 2 }]);
  assert.equal(libraryQuality([{ source: null, resolution: null, n: 5 }]), null);
});
