/** Extraction: first-volume detection, no-op, background polling and unavailable paths (no 7-Zip needed). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanUnpacked, extractIfNeeded, firstVolumes, UNPACK_DIR, type ExtractOutcome } from "../server/extract.js";

async function settle(dir: string, key: string, opts: Parameters<typeof extractIfNeeded>[2] = {}): Promise<ExtractOutcome> {
  for (let i = 0; i < 200; i++) {
    const r = await extractIfNeeded(dir, key, opts);
    if (r.kind !== "pending") return r;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error("still pending");
}

test("first volumes only", () => {
  assert.deepEqual(
    firstVolumes(["a/x.part01.rar", "a/x.part02.rar", "a/x.r00", "b/y.rar", "c/z.7z.001", "c/z.7z.002", "d/w.zip", "e/v.7z", "sample/s.rar", `${UNPACK_DIR}/1/q.zip`]),
    ["a/x.part01.rar", "b/y.rar", "c/z.7z.001", "d/w.zip", "e/v.7z"],
  );
});

test("nothing to unpack; a missing 7-Zip needs attention (polled in the background); a finished unpack is reused and cleaned", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-x-"));
  fs.writeFileSync(path.join(dir, "readme.txt"), "x");
  assert.equal((await settle(dir, "1")).kind, "none");
  fs.writeFileSync(path.join(dir, "show.part1.rar"), "x");
  assert.equal((await extractIfNeeded(dir, "1", { tool: "animearr-no-such-7z" })).kind, "pending");
  const r = await settle(dir, "1", { tool: "animearr-no-such-7z" });
  assert.equal(r.kind, "unavailable");
  assert.ok(!fs.existsSync(path.join(dir, UNPACK_DIR, "1.tmp")), "the temp folder is cleaned up");
  // A finished unpack (renamed into place) is reused, e.g. on "Retry import".
  fs.mkdirSync(path.join(dir, UNPACK_DIR, "1"), { recursive: true });
  fs.writeFileSync(path.join(dir, UNPACK_DIR, "1", "Show - 01.mkv"), "x");
  const again = await settle(dir, "1", { tool: "animearr-no-such-7z" });
  assert.equal(again.kind, "extracted");
  assert.deepEqual(again.kind === "extracted" && again.files, [`${UNPACK_DIR}/1/Show - 01.mkv`]);
  cleanUnpacked(path.join(dir, UNPACK_DIR, "1"));
  assert.ok(!fs.existsSync(path.join(dir, UNPACK_DIR)), "removed, with its empty parent");
  cleanUnpacked(dir); // not an unpack folder: ignored
  assert.ok(fs.existsSync(dir));
});
