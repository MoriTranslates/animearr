/** Indexer health: learned from download-link failures; non-ASCII Prowlarr 500s don't count. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-health-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { indexerHealth, recordIndexerFailure, isTitleEncodingError } = await import("../server/health.js");
const { rankRelease } = await import("../server/core/rank.js");
const { parseRelease } = await import("../server/core/parser.js");
const { fetchOrNote } = await import("../server/pipeline.js");

const prof = { subLangs: ["en"], softOnly: true, preferUncensored: true, protocolOrder: ["usenet", "torrent"] as ("usenet" | "torrent")[], resolution: 1080 };

test("a failing indexer's release ranks below an equivalent torrent elsewhere", () => {
  recordIndexerFailure(1, "getaddrinfo ENOTFOUND storage.animetosho.org");
  recordIndexerFailure(1, "getaddrinfo ENOTFOUND storage.animetosho.org");
  const p = parseRelease("[SubsPlease] Show - 01 (1080p)");
  const nzb = rankRelease(p, { protocol: "usenet", size: 1.4e9, indexer: "AnimeTosho", episodeCount: 1 }, prof, null, { indexerHealth: indexerHealth(1) });
  const tor = rankRelease(p, { protocol: "torrent", size: 1.4e9, seeders: 40, indexer: "Nyaa", episodeCount: 1 }, prof, null, { indexerHealth: indexerHealth(2) });
  assert.ok(nzb.accept, "still usable as a fallback");
  assert.ok(tor.score > nzb.score, `${tor.score} > ${nzb.score}`);
  assert.ok(nzb.flags.some((f) => f.key === "indexerHealth"));
});

test("Prowlarr's HTTP 500 on a non-ASCII title doesn't count against the indexer", async () => {
  assert.ok(isTitleEncodingError("Download link failed (HTTP 500)", "[G] 葬送のフリーレン - 01"));
  const deps = { fetchRelease: async () => { throw new Error("Download link failed (HTTP 500)"); } } as never;
  await assert.rejects(fetchOrNote(deps, { guid: "x", title: "[G] 葬送のフリーレン - 01", indexerId: 7, indexer: "X", protocol: "torrent", size: 1, label: "", group: null, why: "", episodeIds: [] } as never), /non-ASCII/);
  assert.equal(indexerHealth(7), undefined);
});
