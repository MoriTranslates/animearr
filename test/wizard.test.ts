/** Setup wizard: saved progress, folder browser (directories only). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-wiz-"));
process.env.ANIMEARR_NO_LOCK = "1";
const { saveWizard, wizardState, listFolders } = await import("../server/wizard.js");

test("progress is saved and validated", () => {
  assert.deepEqual([wizardState().done, wizardState().step], [false, "welcome"]);
  saveWizard({ path: "new", step: "folders", completed: ["account", "../evil", "account"] });
  const w = wizardState();
  assert.deepEqual([w.path, w.step, w.completed], ["new", "folders", ["account"]]);
  saveWizard({ step: "bad step!" });
  assert.equal(wizardState().step, "folders");
  saveWizard({ done: true });
  assert.equal(wizardState().done, true);
});

test("folder browser lists directories only, with a writable flag", () => {
  if (process.platform === "win32") return; // container paths (posix)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-fs-"));
  fs.mkdirSync(path.join(root, "Anime"));
  fs.writeFileSync(path.join(root, "secret.txt"), "x");
  const r = listFolders(root);
  assert.deepEqual(r.dirs.map((d) => d.name), ["Anime"]);
  assert.equal(r.dirs[0].writable, true);
  assert.throws(() => listFolders(path.join(root, "nope")), /Can't open/);
});
