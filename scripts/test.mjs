/**
 * Runs the test suite with every temporary folder inside one throwaway directory, wiped before and after. The tests
 * make many scratch folders (and on Windows a "sparse" test file really takes its full size), so without this a few
 * hundred runs fill the system drive.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = path.join(os.tmpdir(), "animearr-tests");
const wipe = () => fs.rmSync(dir, { recursive: true, force: true });
wipe();
fs.mkdirSync(dir, { recursive: true });
const files = process.argv.slice(2);
const r = spawnSync(process.execPath, ["--no-warnings", "--import", "tsx", "--test", ...(files.length ? files : ["test/**/*.test.ts"])], {
  stdio: "inherit",
  env: { ...process.env, TMPDIR: dir, TEMP: dir, TMP: dir },
});
wipe();
process.exit(r.status ?? 1);
