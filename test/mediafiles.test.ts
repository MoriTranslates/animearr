/** Own file records: scan, incremental re-probe (size/mtime), removal, sidecars, forced-only detection. Fake ffprobe. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-files-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { db } = await import("../server/db.js");
const { scanLibrary, recordFor, probeOf, fileSummary } = await import("../server/mediafiles.js");

const lib = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-lib-"));
const show = path.join(lib, "Show", "Season 1");
fs.mkdirSync(show, { recursive: true });
const ep1 = path.join(show, "Show - S01E01.mkv");
const ep2 = path.join(show, "Show - S01E02.mkv");
fs.writeFileSync(ep1, "a");
fs.writeFileSync(ep2, "b");
fs.writeFileSync(path.join(show, "Show - S01E02.en.ass"), "subs");
const arr = (p: string) => lib + p.slice(lib.length).replace(/\\/g, "/");

let probes: string[] = [];
const fake = async (f: string) => {
  probes.push(path.basename(f));
  const forcedOnly = f.endsWith("E01.mkv");
  return {
    duration: 1420,
    container: "matroska,webm",
    video: { codec: "hevc", width: 1920, height: 1080, hdr: false },
    audio: [{ index: 1, codec: "aac", lang: "ja", title: null, default: true, forced: false, channels: 2 }],
    subs: [{ index: 2, codec: "ass", lang: "en", title: forcedOnly ? "Signs & Songs" : "Full", default: true, forced: false, partial: forcedOnly }],
  };
};

test("first scan probes everything, with sidecars; forced-only English is detected", async () => {
  const r = await scanLibrary({ roots: [lib], probe: fake });
  assert.equal(r.files, 2);
  assert.equal(r.probed, 2);
  const one = recordFor(arr(ep1))!;
  assert.deepEqual(probeOf(one).subs, [], "a Signs & Songs track isn't dialogue");
  assert.deepEqual(probeOf(one).forced, ["en"]);
  const two = recordFor(arr(ep2))!;
  assert.deepEqual(two.sidecars.map((s) => s.lang), ["en"]);
  assert.equal(fileSummary().forcedOnlyEnglish, 1);
});

test("incremental: unchanged files aren't probed again; a rewritten file (Tdarr) is; a deleted one is removed", async () => {
  probes = [];
  await scanLibrary({ roots: [lib], probe: fake });
  assert.deepEqual(probes, []);
  fs.writeFileSync(ep1, "rewritten by tdarr");
  fs.rmSync(ep2);
  const r = await scanLibrary({ roots: [lib], probe: fake });
  assert.deepEqual(probes, ["Show - S01E01.mkv"]);
  assert.equal(r.removed, 1);
  assert.equal(recordFor(arr(ep2)), null);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM media_files").get() as { n: number }).n, 1);
});

test("an unreachable root is reported and its records are kept", async () => {
  const r = await scanLibrary({ roots: [lib, "/no/such/root"], probe: fake });
  assert.deepEqual(r.unreachable, ["/no/such/root"]);
  assert.ok(recordFor(arr(ep1)));
});

test("an empty or failing walk never wipes records; errored probes are retried after 12 h", async () => {
  const before = (db.prepare("SELECT COUNT(*) AS n FROM media_files").get() as { n: number }).n;
  const away = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "animearr-away-")), "Show");
  fs.cpSync(path.join(lib, "Show"), away, { recursive: true });
  fs.rmSync(path.join(lib, "Show"), { recursive: true });
  const r = await scanLibrary({ roots: [lib], probe: fake });
  assert.equal(r.removed, 0, "an empty root (e.g. share not mounted) keeps its records");
  assert.deepEqual(r.skippedRemoval, [lib.split(path.sep).join("/")]);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM media_files").get() as { n: number }).n, before);
  fs.cpSync(away, path.join(lib, "Show"), { recursive: true, preserveTimestamps: true });
  // A probe that failed is tried again later.
  db.prepare("UPDATE media_files SET error = 'ffprobe failed: timeout', probed_at = ?").run(Date.now() - 13 * 3_600_000);
  probes = [];
  await scanLibrary({ roots: [lib], probe: fake });
  assert.deepEqual(probes, ["Show - S01E01.mkv"]);
});

test("record keys use forward slashes: a Windows-style *arr path still finds the record", () => {
  const winStyle = arr(ep1).replace(/\//g, "\\");
  assert.ok(recordFor(winStyle));
});
