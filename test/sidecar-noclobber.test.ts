/**
 * Blind review L10: "Use this as English" (useSidecar) and its undo never overwrite a subtitle file, even one that
 * appears between the check and the rename.
 */
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-side-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { patchSettings } = await import("../server/system/settings.js");
const { useSidecar, renameSidecarBack } = await import("../server/import/detection.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-side-f-"));
const DIR = path.join(tmp, "lib", "Show", "Season 01");
const VIDEO_ARR = "/media/Anime/Show/Season 01/Show - S01E01.mkv";
const write = (p: string, s: string) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, s));

// The race: the target is reported missing to the check, then exists by the time of the rename.
const realExists = fs.existsSync;
let hidden: string | null = null;
(fs as { existsSync: unknown }).existsSync = (p: fs.PathLike) => (hidden && path.resolve(String(p)) === hidden ? false : realExists(p));
afterEach(() => (hidden = null));

before(() => {
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/Anime"],
    localPathMappings: [{ from: "/media/Anime", to: path.join(tmp, "lib") }],
  }));
  write(path.join(DIR, "Show - S01E01.mkv"), "video");
});

test("a subtitle that appears at the target name meanwhile is never overwritten", async () => {
  write(path.join(DIR, "random.ass"), "the picked subtitle");
  const target = path.join(DIR, "Show - S01E01.en.ass");
  write(target, "the user's own English subtitle");
  hidden = path.resolve(target);
  await assert.rejects(
    Promise.resolve().then(() => useSidecar({ video: VIDEO_ARR, file: "random.ass", lang: "en" })),
    /exists/,
  );
  assert.equal(fs.readFileSync(target, "utf8"), "the user's own English subtitle");
  assert.equal(fs.readFileSync(path.join(DIR, "random.ass"), "utf8"), "the picked subtitle");
});

test("its undo never overwrites a file that took the old name meanwhile", async () => {
  write(path.join(DIR, "Show - S01E01.ja.ass"), "renamed subtitle");
  const back = path.join(DIR, "orig.ass");
  write(back, "a new file with the old name");
  hidden = path.resolve(back);
  await assert.rejects(
    Promise.resolve().then(() => renameSidecarBack({ dir: "/media/Anime/Show/Season 01", from: "Show - S01E01.ja.ass", to: "orig.ass" })),
    /exists/,
  );
  assert.equal(fs.readFileSync(back, "utf8"), "a new file with the old name");
  assert.equal(fs.readFileSync(path.join(DIR, "Show - S01E01.ja.ass"), "utf8"), "renamed subtitle");
});

test("the normal rename still works", async () => {
  write(path.join(DIR, "pick.srt"), "subs");
  const r = await useSidecar({ video: VIDEO_ARR, file: "pick.srt", lang: "de" });
  assert.equal(r.renamed, "Show - S01E01.de.srt");
  assert.equal(fs.readFileSync(path.join(DIR, "Show - S01E01.de.srt"), "utf8"), "subs");
  assert.equal(realExists(path.join(DIR, "pick.srt")), false);
});
