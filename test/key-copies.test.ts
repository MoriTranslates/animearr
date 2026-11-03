/**
 * Blind review M2: saved key copies are pruned, but never the last copy of a key an existing backup needs; identical
 * copies are kept once; a restore that is refused never prunes anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-keys-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { BACKUP_DIR, backupNow, userSchemaVersion } = await import("../server/system/db.js");
const { getSettings } = await import("../server/system/settings.js");
const { safetyBackup, restoreSaved } = await import("../server/system/backupTransfer.js");

function sealWith(plain: string, key: Buffer) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return "enc:v1:" + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
const keyFiles = () => fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".secret.key"));
const keysIn = () => keyFiles().map((f) => fs.readFileSync(path.join(BACKUP_DIR, f), "utf8").trim());
let n = 0;
/** A saved copy of `key`, dated in the past. */
function plantKey(key: Buffer) {
  const f = path.join(BACKUP_DIR, `animearr-prerestore-2026-01-0${++n}T00-00-00.secret.key`);
  fs.writeFileSync(f, key.toString("hex"));
  fs.utimesSync(f, new Date(2026, 0, n), new Date(2026, 0, n));
  return f;
}
/** A manual backup whose settings are sealed with `key` (made back when that key was live). */
function backupSealedWith(key: Buffer) {
  const name = backupNow("manual")!;
  const d = new DatabaseSync(path.join(BACKUP_DIR, name));
  d.prepare("UPDATE settings SET value = ? WHERE key = 'settings'").run(sealWith(JSON.stringify({ apiKey: "x" }), key));
  d.close();
  return name;
}

const old = crypto.randomBytes(32);
let oldBackup = "";

test("the only copy of a key an existing backup needs is never pruned, however many safety copies follow", () => {
  getSettings();
  plantKey(old);
  oldBackup = backupSealedWith(old);
  for (let i = 0; i < 5; i++) safetyBackup();
  assert.ok(keysIn().includes(old.toString("hex")), `the old key is kept: ${keyFiles().join(", ")}`);
});

test("identical copies of a key are kept once", () => {
  const live = fs.readFileSync(path.join(process.env.ANIMEARR_CONFIG!, "secret.key"), "utf8").trim();
  assert.equal(keysIn().filter((k) => k === live).length, 1, keyFiles().join(", "));
});

test("a restore that is refused prunes nothing", () => {
  // Spare keys no backup needs (prunable in principle), and a backup from a newer AnimeArr (refused).
  for (let i = 0; i < 4; i++) plantKey(crypto.randomBytes(32));
  const before = keyFiles();
  const newer = backupSealedWith(old);
  const d = new DatabaseSync(path.join(BACKUP_DIR, newer));
  d.exec(`PRAGMA user_version = ${userSchemaVersion() + 1}`);
  d.close();
  assert.throws(() => restoreSaved(newer), /newer AnimeArr/);
  for (const f of before) assert.ok(keyFiles().includes(f), `${f} kept`);
});

test("the backup sealed with the old key restores (its key is still there)", () => {
  assert.doesNotThrow(() => restoreSaved(oldBackup));
});
