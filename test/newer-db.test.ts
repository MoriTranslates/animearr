/**
 * Blind review L16: an older AnimeArr must not run on a database from a newer one (it would read and write tables it
 * doesn't know). Startup refuses with a clear message and leaves the database as it is.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-newer-self-"));
process.env.ANIMEARR_NO_LOCK = "1";
const { userSchemaVersion } = await import("../server/system/db.js");

const CHILD = path.join(import.meta.dirname, "restore-child.ts");
const start = (dir: string) =>
  spawnSync(process.execPath, ["--no-warnings", "--import", "tsx", CHILD, "status"], {
    env: { ...process.env, ANIMEARR_CONFIG: dir, ANIMEARR_NO_LOCK: "1" },
    encoding: "utf8",
    timeout: 120_000,
  });

test("a database from a newer AnimeArr: startup refuses, says why, and changes nothing in it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-newer-"));
  const f = path.join(dir, "animearr.db");
  const d = new DatabaseSync(f);
  d.exec("CREATE TABLE from_the_future (x TEXT); INSERT INTO from_the_future VALUES ('kept')");
  d.exec(`PRAGMA user_version = ${userSchemaVersion() + 3}`);
  d.close();
  const r = start(dir);
  assert.notEqual(r.status, 0, `it must not start: ${r.stdout}`);
  assert.match(r.stderr, /newer AnimeArr.*update AnimeArr/is);
  const after = new DatabaseSync(f, { readOnly: true });
  assert.equal((after.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, userSchemaVersion() + 3);
  assert.equal((after.prepare("SELECT x FROM from_the_future").get() as { x: string }).x, "kept");
  assert.equal(after.prepare("SELECT name FROM sqlite_master WHERE name = 'settings'").get(), undefined, "no tables were added");
  after.close();
});

test("a database from this version (or an older one) starts as usual", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-same-"));
  const r = start(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"corrupt":false/);
});
