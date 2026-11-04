/**
 * Blind review round 5, M2: restoring a named backup must never leave a database the live secret.key can't open (the
 * app then crash-loops on "Can't read settings ... Was secret.key replaced?"). A backup with a matching saved key (the
 * safety copy an upload restore makes) goes in together with that key; one with no key that the live key can't open is
 * refused before anything is closed. Own file: the last test restores for real, which closes the database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-restore-named-key-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";
delete process.env.TRUST_PROXY;

const { setAccount, patchSettings } = await import("../server/system/settings.js");
await setAccount("captain", "pw-test-1");
const { app } = await import("../server/index.js");
const { USER_DB, BACKUP_DIR, backupNow, db, listBackups } = await import("../server/system/db.js");
const { KEY_FILE, open } = await import("../server/system/secretbox.js");

const exits: number[] = [];
process.exit = ((code?: number) => void exits.push(code ?? 0)) as typeof process.exit;

/** The secretbox format, with a key of our choosing (the app's own seal only uses the live key). */
function sealWith(plain: string, key: Buffer) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `enc:v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64")}`;
}
const settingsIn = (file: string, key: Buffer) => {
  const d = new DatabaseSync(file, { readOnly: true });
  try {
    const row = d.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as { value: string };
    return JSON.parse(open(row.value, key)) as { externalUrl: string };
  } finally {
    d.close();
  }
};
const liveKey = () => Buffer.from(fs.readFileSync(KEY_FILE, "utf8").trim(), "hex");

/** A backup made while another secret.key was in use: its settings row is sealed with `key`. */
function backupLockedWith(kind: "manual" | "prerestore", label: string, key: Buffer, marker: string) {
  patchSettings((s) => ({ ...s, externalUrl: `http://${marker}.lan` }));
  const name = backupNow(kind, label)!;
  const file = path.join(BACKUP_DIR, name);
  const d = new DatabaseSync(file);
  const row = d.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as { value: string };
  d.prepare("UPDATE settings SET value = ? WHERE key = 'settings'").run(sealWith(open(row.value), key));
  d.close();
  patchSettings((s) => ({ ...s, externalUrl: "http://live.lan" }));
  return name;
}

let cookie = "";
const restore = (name: string) =>
  app.inject({
    method: "POST",
    url: "/api/system/restore",
    headers: { cookie, "x-animearr": "1" },
    payload: { name, password: "pw-test-1" },
  });

test("M2: a named backup no saved key opens is refused before anything is closed, and says why", async () => {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { "x-animearr": "1" },
    payload: { username: "captain", password: "pw-test-1" },
  });
  cookie = String([login.headers["set-cookie"]].flat()[0]).split(";")[0];
  const name = backupLockedWith("manual", "otherkey", crypto.randomBytes(32), "other-install");
  const keyBefore = fs.readFileSync(KEY_FILE);
  const dbBefore = fs.readFileSync(USER_DB);
  const prerestores = listBackups().filter((b) => b.kind === "prerestore").length;
  const r = await restore(name);
  assert.equal(r.statusCode, 409, r.body);
  assert.match(r.body, /secret\.key/);
  assert.match(r.body, /nothing was changed/i);
  assert.match(r.body, /unable to start/);
  assert.ok(fs.readFileSync(KEY_FILE).equals(keyBefore), "the live key is untouched");
  assert.ok(fs.readFileSync(USER_DB).equals(dbBefore), "the live database is untouched");
  assert.equal(listBackups().filter((b) => b.kind === "prerestore").length, prerestores, "refused before the safety copy");
  assert.equal(
    (await app.inject({ method: "GET", url: "/api/settings", headers: { cookie } })).statusCode,
    200,
    "the database is still open",
  );
  await new Promise((res) => setTimeout(res, 700));
  assert.deepEqual(exits, [], "no restart: nothing was touched");
});

test("M2: the upload restore's safety copy restores together with its own key, so the app can start", async () => {
  const oldKey = crypto.randomBytes(32);
  const name = backupLockedWith("prerestore", "upload", oldKey, "before-upload");
  // The key file the upload restore's safety copy wrote before this fix: no "-upload" in its name, and its time stamp
  // taken just before the database copy, so it can be a second earlier.
  // (Names carry milliseconds, and -2, -3, ... on a clash, since the merge of the files branch's collision-proof names.)
  const stamp = /^animearr-prerestore-(.{19})-\d{3}(?:-\d+)?-upload\.db$/.exec(name)![1];
  const iso = `${stamp.slice(0, 10)}T${stamp.slice(11).replace(/-/g, ":")}Z`;
  const earlier = new Date(Date.parse(iso) - 1000).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  fs.writeFileSync(path.join(BACKUP_DIR, `animearr-prerestore-${earlier}.secret.key`), oldKey.toString("hex"));
  // A saved key that unlocks nothing here, which must not be picked.
  fs.writeFileSync(path.join(BACKUP_DIR, "animearr-prerestore-2020-01-01T00-00-00.secret.key"), crypto.randomBytes(32).toString("hex"));
  const liveBefore = liveKey();
  db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('m2', 'live')").run();
  const r = await restore(name);
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(liveKey().equals(oldKey), "the backup's own key is live");
  assert.equal(settingsIn(USER_DB, liveKey()).externalUrl, "http://before-upload.lan", "the live key opens the restored settings");
  // And this restore's own safety copy can be undone the same way: database and key are saved as a named pair.
  const safety = listBackups().find((b) => b.kind === "prerestore" && b.name !== name && !b.name.includes("upload"))!;
  assert.ok(safety, "a safety copy of what was live");
  const pairedKey = path.join(BACKUP_DIR, safety.name.replace(/\.db$/, ".secret.key"));
  assert.ok(fs.existsSync(pairedKey), "the safety copy's key is saved next to it, under the same name");
  assert.ok(Buffer.from(fs.readFileSync(pairedKey, "utf8").trim(), "hex").equals(liveBefore));
  assert.equal(settingsIn(path.join(BACKUP_DIR, safety.name), liveBefore).externalUrl, "http://live.lan");
  assert.deepEqual(
    fs.readdirSync(path.dirname(USER_DB)).filter((f) => f.includes("restore-tmp") || f.includes("rollback-tmp")),
    [],
    "no temporary files left",
  );
  await new Promise((res) => setTimeout(res, 700));
  assert.deepEqual(exits, [0]);
});
