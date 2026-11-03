/** The user database's migrations: a fresh database takes every step, an old one is brought up to date, a failing step changes nothing. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-mig-"));
process.env.ANIMEARR_NO_LOCK = "1";
const { migrateUserDb, userMigrations, userSchemaVersion, db } = await import("../server/system/db.js");

const version = (d: DatabaseSync) => (d.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
const tables = (d: DatabaseSync) =>
  new Set((d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name));
const columns = (d: DatabaseSync, t: string) =>
  new Set((d.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name));

test("an empty database takes every step and ends at the current version, with the same schema as the live one", () => {
  const d = new DatabaseSync(":memory:");
  let before = 0;
  assert.equal(
    migrateUserDb(d, userMigrations(), () => before++),
    userSchemaVersion(),
  );
  assert.equal(version(d), userMigrations().length);
  assert.equal(before, 0, "no pre-migration backup for a brand-new database");
  assert.deepEqual([...tables(d)].sort(), [...tables(db as unknown as DatabaseSync)].sort());
  assert.ok(columns(d, "recycle_log").has("pinned"));
  assert.ok(tables(d).has("cutover_pending"));
  assert.equal(migrateUserDb(d), userSchemaVersion(), "running again is a no-op");
  d.close();
});

test("an older database is brought up to date, keeping its data, with the backup hook run once first", () => {
  const d = new DatabaseSync(":memory:");
  const steps = userMigrations();
  const old = steps.length - 5;
  migrateUserDb(d, steps.slice(0, old));
  assert.equal(version(d), old);
  d.prepare("INSERT INTO recycle_log (path, at, size) VALUES ('/bin/a.mkv', 1, 2)").run();
  const seen: number[] = [];
  migrateUserDb(d, steps, (v) => seen.push(v));
  assert.deepEqual(seen, [old]);
  assert.equal(version(d), steps.length);
  assert.deepEqual(
    { ...(d.prepare("SELECT path, at, size, pinned FROM recycle_log").get() as object) },
    { path: "/bin/a.mkv", at: 1, size: 2, pinned: null },
  );
  d.close();
});

test("a 'sending' grab left by an earlier version is marked 'handed over, id unknown', never 'never sent' (M5)", () => {
  const d = new DatabaseSync(":memory:");
  const steps = userMigrations();
  // The version before this release: up to the cutover journal.
  const before = steps.findIndex((s) => s.includes("CREATE TABLE cutover_pending")) + 1;
  assert.ok(before > 0 && before < steps.length, "a step after the cutover journal exists");
  migrateUserDb(d, steps.slice(0, before));
  const ins = d.prepare(
    "INSERT INTO grabs (at, updated_at, episode_ids, release, guid, protocol, state, dry_run, client_ref) VALUES (0, 0, '[]', ?, ?, 'torrent', ?, 0, ?)",
  );
  ins.run("old send", "g1", "sending", null); // the old code never wrote client_ref before sending
  ins.run("old done", "g2", "done", null);
  ins.run("old dl", "g3", "downloading", "abc");
  migrateUserDb(d, steps);
  const ref = (guid: string) =>
    (d.prepare("SELECT client_ref FROM grabs WHERE guid = ?").get(guid) as { client_ref: string | null }).client_ref;
  assert.equal(ref("g1"), "?", "handed over, identity unknown: the restart resolution never re-sends it blind");
  assert.equal(ref("g2"), null);
  assert.equal(ref("g3"), "abc");
  d.close();
});

test("a failing step is rolled back whole and leaves user_version where it was", () => {
  const d = new DatabaseSync(":memory:");
  const steps = userMigrations();
  migrateUserDb(d, steps);
  const bad = [
    ...steps,
    "CREATE TABLE half_done (x INTEGER); INSERT INTO no_such_table VALUES (1);",
    "CREATE TABLE never_reached (x INTEGER);",
  ];
  assert.throws(() => migrateUserDb(d, bad), new RegExp(`step ${steps.length + 1} failed.*no_such_table`));
  assert.equal(version(d), steps.length);
  assert.ok(!tables(d).has("half_done"), "the first statement of the failing step was undone");
  assert.ok(!tables(d).has("never_reached"), "later steps don't run");
  // Fixed step: the next start carries on from the same place.
  bad[steps.length] = "CREATE TABLE half_done (x INTEGER);";
  migrateUserDb(d, bad);
  assert.equal(version(d), steps.length + 2);
  d.close();
});
