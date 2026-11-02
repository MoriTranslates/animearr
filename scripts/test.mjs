/**
 * Runs the test suite with every temporary folder inside one throwaway directory, wiped before and after. The tests
 * make many scratch folders (and on Windows a "sparse" test file really takes its full size), so without this a few
 * hundred runs fill the system drive.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// One folder per run, so two runs at once (several worktrees or agents) never wipe each other's files.
const dir = path.join(os.tmpdir(), `animearr-tests-${process.pid}`);
const wipe = () => fs.rmSync(dir, { recursive: true, force: true });
wipe();
// A killed run never reaches its own wipe: clear folders left by runs whose process is gone (and the old shared folder).
for (const name of fs.readdirSync(os.tmpdir())) {
  const m = /^animearr-tests(?:-(\d+))?$/.exec(name);
  if (!m || (m[1] && alive(Number(m[1])))) continue;
  fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
}
fs.mkdirSync(dir, { recursive: true });
const files = process.argv.slice(2);
const r = spawnSync(process.execPath, ["--no-warnings", "--import", "tsx", "--test", ...(files.length ? files : ["test/**/*.test.ts"])], {
  stdio: "inherit",
  env: { ...process.env, TMPDIR: dir, TEMP: dir, TMP: dir },
});
wipe();
process.exit(r.status ?? 1);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return e.code === "EPERM";
  }
}
