/** Plex notify: path mapping, the right library, one partial scan per folder; mocked Plex only. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-test-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { patchSettings } = await import("../server/settings.js");
const { toPlexPath, sectionFor, notifyPlex, flush } = await import("../server/plex.js");

const sections = [
  { key: "1", title: "Anime", type: "show", locations: ["/data/Anime"] },
  { key: "2", title: "Anime Movies", type: "movie", locations: ["/data/Movies/Anime"] },
  { key: "3", title: "Movies", type: "movie", locations: ["/data/Movies"] },
];

test("AnimeArr paths map to Plex paths (longest prefix) and to the right library", () => {
  const maps = [{ from: "/media/Anime", to: "/data/Anime" }, { from: "/media/Movies", to: "/data/Movies" }];
  assert.equal(toPlexPath("/media/Anime/Frieren/Season 1", maps), "/data/Anime/Frieren/Season 1");
  assert.equal(toPlexPath("/elsewhere/x", maps), "/elsewhere/x");
  assert.equal(sectionFor("/data/Movies/Anime/Suzume (2022)", sections)?.title, "Anime Movies", "the most specific library wins");
  assert.equal(sectionFor("/nowhere", sections), null);
});

test("notify: nothing unless switched on; then one scan per folder, batched", async () => {
  const calls: string[] = [];
  const deps = { sections: async () => sections, refresh: async (k: string, p: string) => void calls.push(`${k}:${p}`) };
  notifyPlex(["/media/Anime/Frieren/Season 1"], deps, 1);
  assert.deepEqual(await flush(deps), []);
  patchSettings((s) => ({ ...s, plex: { url: "http://plex:32400", token: "t0k3n", enabled: true, pathMappings: [{ from: "/media", to: "/data" }] } }));
  notifyPlex(["/media/Anime/Frieren/Season 1", "/media/Anime/Frieren/Season 1/", "/media/Unknown/x"], deps, 60_000);
  const out = await flush(deps);
  assert.deepEqual(calls, ["1:/data/Anime/Frieren/Season 1"]);
  assert.equal(out.find((o) => o.folder === "/media/Unknown/x")?.ok, false);
});
