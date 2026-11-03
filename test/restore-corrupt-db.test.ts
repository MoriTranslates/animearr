/**
 * Blind review round 5, M1: while animearr.db is flagged corrupt (it failed its startup check) an uploaded backup must
 * still restore, since that is when a restore is needed most. The safety copy is then a raw copy of the damaged files
 * plus the key; if even that can't be written the restore is refused, and the message never says "try again" for a
 * retry that can't work. Own file: the last test restores for real, which closes the database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-restore-corrupt-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";
delete process.env.TRUST_PROXY;

const { setAccount } = await import("../server/system/settings.js");
await setAccount("captain", "pw-test-1");
const { app } = await import("../server/index.js");
const { USER_DB, BACKUP_DIR, dbState, db } = await import("../server/system/db.js");
const { createBackup } = await import("../server/system/backupTransfer.js");
const { KEY_FILE } = await import("../server/system/secretbox.js");

const exits: number[] = [];
process.exit = ((code?: number) => void exits.push(code ?? 0)) as typeof process.exit;

let cookie = "";
let token = "";
const restore = () =>
  app.inject({
    method: "POST",
    url: "/api/system/backup/restore-upload",
    headers: { cookie, "x-animearr": "1" },
    payload: { token, password: "pw-test-1" },
  });

test("M1: with the database flagged corrupt, a safety copy that can't be written refuses without 'try again'", async () => {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { "x-animearr": "1" },
    payload: { username: "captain", password: "pw-test-1" },
  });
  cookie = String([login.headers["set-cookie"]].flat()[0]).split(";")[0];
  const up = await app.inject({
    method: "POST",
    url: "/api/system/backup/upload",
    headers: { cookie, "x-animearr": "1", "content-type": "application/octet-stream" },
    payload: (await createBackup()).data,
  });
  assert.equal(up.statusCode, 200, up.body);
  token = (up.json() as { token: string }).token;
  db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('m1', 'live')").run();
  dbState.corrupt = true; // what openUser sets when animearr.db fails its startup check
  dbState.detail = "test: flagged corrupt";
  const keyBefore = fs.readFileSync(KEY_FILE);
  const realCopy = fs.copyFileSync;
  fs.copyFileSync = ((a: fs.PathLike, b: fs.PathLike, mode?: number) => {
    if (path.dirname(path.resolve(String(b))) === path.resolve(BACKUP_DIR))
      throw Object.assign(new Error("ENOSPC: no space left on device, copyfile"), { code: "ENOSPC" });
    realCopy(a, b, mode);
  }) as typeof fs.copyFileSync;
  let r;
  try {
    r = await restore();
  } finally {
    fs.copyFileSync = realCopy;
  }
  assert.equal(r.statusCode, 500, r.body);
  assert.match(r.body, /safety copy/);
  assert.match(r.body, /ENOSPC/);
  assert.match(r.body, /nothing was changed/i);
  assert.doesNotMatch(r.body, /try again/i, "a plain retry would fail the same way");
  assert.ok(fs.readFileSync(KEY_FILE).equals(keyBefore), "the key is untouched");
  assert.equal((db.prepare("SELECT value FROM kv WHERE key = 'm1'").get() as { value: string }).value, "live", "still open");
  assert.deepEqual(
    fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith("animearr-damaged-")),
    [],
    "no half-written safety copy is left",
  );
  await new Promise((res) => setTimeout(res, 700));
  assert.deepEqual(exits, [], "no restart: nothing was touched");
});

test("M1: with the database flagged corrupt, an uploaded backup restores after a raw copy of the damaged files", async () => {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); // so the main file alone is what a raw copy must match
  const damagedBefore = fs.readFileSync(USER_DB);
  const keyBefore = fs.readFileSync(KEY_FILE);
  const r = await restore();
  assert.equal(r.statusCode, 200, r.body);
  const copies = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith("animearr-damaged-"));
  const dbCopy = copies.find((f) => f.endsWith(".db"));
  assert.ok(dbCopy, `a raw copy of the damaged database is kept (${copies.join(", ")})`);
  assert.ok(fs.readFileSync(path.join(BACKUP_DIR, dbCopy)).equals(damagedBefore), "byte for byte");
  const keyCopy = copies.find((f) => f === dbCopy.replace(/\.db$/, ".secret.key"));
  assert.ok(keyCopy, "the key that goes with it is kept under the same name");
  assert.ok(fs.readFileSync(path.join(BACKUP_DIR, keyCopy)).equals(keyBefore));
  await new Promise((res) => setTimeout(res, 700));
  assert.deepEqual(exits, [0]);
});
