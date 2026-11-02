/**
 * Blind review H1: a recycling bin set INSIDE a library root must be refused, or "Empty now" and the daily purge delete
 * real episodes. Compared by real path (a second mount name / junction for the same folder) and, on Windows, ignoring case.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-bin-in-"));
process.env.ANIMEARR_NO_LOCK = "1";
const { patchSettings } = await import("../server/system/settings.js");
const { cache } = await import("../server/system/db.js");
cache
  .prepare(
    "INSERT INTO series (id, tvdb_id, title, path, root_folder, monitored, synced_at) VALUES (1, 1, 'Show', '/media/Anime/Show', '/media/Anime', 1, 0)",
  )
  .run();
const { purgeBin, binFolder } = await import("../server/import/binpurge.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-bin-in-f-"));
const LIB = path.join(tmp, "Anime");
const episode = path.join(LIB, "Other Show", "Season 01", "Other Show - S01E01.mkv");
fs.mkdirSync(path.dirname(episode), { recursive: true });
fs.writeFileSync(episode, "real episode");
// A second name for the same library folder (another mount, or a junction/symlink).
const ALIAS = path.join(tmp, "Alias");
fs.symlinkSync(LIB, ALIAS, "junction");

const mappings = [
  { from: "/media/Anime", to: LIB },
  { from: "/media/Alias", to: ALIAS },
  { from: "/media/Upper", to: LIB.toUpperCase() },
];

async function assertRefusedAndSafe(bin: string) {
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/Anime"],
    localPathMappings: mappings,
    media: { ...s.media, recycleBin: bin, recycleBinCleanupDays: 1 },
  }));
  const r = binFolder();
  assert.ok("error" in r && /library/.test(r.error), `${bin} must be refused, got ${JSON.stringify(r)}`);
  // "Empty now" and the daily purge (twice, so an unknown file's clock would have run out) delete nothing.
  const all = await purgeBin({ all: true });
  assert.equal(all.deleted, 0, `${bin}: Empty now deleted ${all.deleted}`);
  await purgeBin({ now: Date.now() });
  await purgeBin({ now: Date.now() + 10 * 86_400_000 });
  assert.equal(fs.readFileSync(episode, "utf8"), "real episode", `${bin}: the episode is untouched`);
}

test("a bin inside a library root is refused; Empty now and the purge leave the episodes alone", async () => {
  await assertRefusedAndSafe("/media/Anime/Other Show");
  await assertRefusedAndSafe("/media/Anime/Other Show/Season 01/");
  // A bin that doesn't exist yet, inside the library, is refused too.
  await assertRefusedAndSafe("/media/Anime/not-there-yet/bin");
});

test("a bin reaching the library through another name (junction/symlink) is refused by real path", async () => {
  await assertRefusedAndSafe("/media/Alias/Other Show");
  await assertRefusedAndSafe("/media/Alias");
});

test("on Windows, a case-only difference is the same folder", { skip: process.platform !== "win32" }, async () => {
  await assertRefusedAndSafe("/media/Upper/Other Show");
});

test("a bin beside the library (sharing a name prefix) is still allowed", () => {
  const beside = path.join(tmp, "Anime-bin");
  fs.mkdirSync(beside, { recursive: true });
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/Anime"],
    localPathMappings: [...mappings, { from: "/media/AnimeBin", to: beside }],
    media: { ...s.media, recycleBin: "/media/AnimeBin" },
  }));
  const r = binFolder();
  assert.ok("local" in r, JSON.stringify(r));
});
