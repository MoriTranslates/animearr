/** Library (allowed root) folders: never AnimeArr's own data folder or a system folder (playtest: /config was offered). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-roots-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { rootRefusal, hiddenInBrowser } = await import("../server/roots.js");
const { getSettings, patchSettings, updateSettings } = await import("../server/settings.js");

test("refuses /config, the app data folder, system folders and CD/USB placeholders", () => {
  for (const bad of ["/config", "/config/", "/config/Anime", "/", "/proc", "/etc/x", "/usr/share", "/tmp/anime", "/home", "/media/cdrom", "/mnt/usb0", "relative/path"]) assert.ok(rootRefusal(bad, "/config"), bad);
  assert.match(rootRefusal("/config", "/config")!, /AnimeArr's own data folder/);
  assert.match(rootRefusal("/appdata/animearr/x", "/appdata/animearr")!, /own data folder/);
  assert.match(rootRefusal("/appdata", "/appdata/animearr")!, /own data folder/, "a folder that contains the app data");
  for (const ok of ["/media/Anime", "/data/media/anime", "/mnt/disk1/Anime", "/home/me/Anime", "/srv/media/anime"]) assert.equal(rootRefusal(ok, "/config"), null, ok);
});

test("the folder browser hides system folders at / and CD/floppy/USB placeholders", () => {
  assert.ok(hiddenInBrowser("/", "proc"));
  assert.ok(hiddenInBrowser("/", "cdrom"));
  assert.ok(hiddenInBrowser("/media", "floppy"));
  assert.ok(hiddenInBrowser("/mnt", "usb"));
  assert.ok(!hiddenInBrowser("/", "media"));
  assert.ok(!hiddenInBrowser("/", "config"), "shown (but refused), so the user sees why");
  assert.ok(!hiddenInBrowser("/media/Anime", "usb"), "deep down it's somebody's show folder");
});

test("a newly added /config is refused when saving; a root saved before the check doesn't block other saves", () => {
  assert.throws(() => updateSettings({ allowedRoots: ["/config"] }), /own data folder/);
  assert.throws(() => updateSettings({ allowedRoots: ["/media/Anime", "/proc"] }), /system folder/);
  updateSettings({ allowedRoots: ["/media/Anime/"] });
  assert.deepEqual(getSettings().allowedRoots, ["/media/Anime"]);
  patchSettings((s) => ({ ...s, allowedRoots: ["/config/Frieren"] }));
  updateSettings({ allowedRoots: ["/config/Frieren", "/media/Anime"] });
  assert.deepEqual(getSettings().allowedRoots, ["/config/Frieren", "/media/Anime"]);
});
