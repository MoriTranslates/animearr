/** Backup download / upload: manifest validation, newer-schema refusal, safety copy before the swap. */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-test-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { getSettings, patchSettings } = await import("../server/system/settings.js");
const { BACKUP_DIR, listBackups, userSchemaVersion } = await import("../server/system/db.js");
const { createBackup, parseBackup, applyBackup, safetyBackup, tarPack, tarUnpack } = await import("../server/system/backupTransfer.js");

patchSettings((s) => ({ ...s, externalUrl: "http://backup-test.lan" })); // something to find again after a restore
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

/** Rebuilds a backup file with the manifest or parts changed. */
function remake(data: Buffer, change: (files: Map<string, Buffer>, manifest: Record<string, unknown>) => void) {
  const files = tarUnpack(zlib.gunzipSync(data));
  const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8"));
  change(files, manifest);
  files.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
  return zlib.gzipSync(tarPack([...files].map(([name, data]) => ({ name, data }))));
}

test("a downloaded backup holds the manifest, a consistent database and the key, and reads back", async () => {
  const b = await createBackup();
  assert.match(b.name, /^animearr-backup-.*\.tar\.gz$/);
  const files = tarUnpack(zlib.gunzipSync(b.data));
  assert.deepEqual([...files.keys()].sort(), ["animearr.db", "manifest.json", "secret.key"]);
  const p = await parseBackup(b.data);
  assert.equal(p.manifest.format, "animearr-backup");
  assert.equal(p.manifest.schema, userSchemaVersion());
  assert.equal(p.manifest.files["animearr.db"].sha256, sha(p.db));
  assert.equal(fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith(".")).length, 0, "no temp copies left behind");
});

test("files that aren't backups, or are damaged, are refused in plain words", async () => {
  const good = (await createBackup()).data;
  await assert.rejects(() => parseBackup(Buffer.from("hello, not a backup")), /isn't an AnimeArr backup/);
  await assert.rejects(() => parseBackup(zlib.gzipSync(tarPack([{ name: "x.txt", data: Buffer.from("hi") }]))), /no manifest/);
  await assert.rejects(() => parseBackup(remake(good, (_f, m) => (m.format = "other"))), /isn't an AnimeArr backup/);
  await assert.rejects(() => parseBackup(remake(good, (f) => f.delete("secret.key"))), /missing its database or its secret key/);
  await assert.rejects(
    () => parseBackup(remake(good, (f) => f.set("animearr.db", Buffer.concat([f.get("animearr.db")!, Buffer.from("x")])))),
    /checksum/,
  );
  await assert.rejects(() => parseBackup(good.subarray(0, good.length - 40)), /isn't an AnimeArr backup|damaged/);
});

test("a backup from a newer schema is refused", async () => {
  const good = (await createBackup()).data;
  const newer = remake(good, (_f, m) => (m.schema = userSchemaVersion() + 1));
  await assert.rejects(() => parseBackup(newer), /newer AnimeArr/);
  await assert.doesNotReject(() => parseBackup(good, userSchemaVersion() + 1), "an older backup is fine for a newer app");
  await assert.rejects(() => parseBackup(good, userSchemaVersion() - 1), /newer AnimeArr/);
});

test("a key that doesn't unlock the settings is refused", async () => {
  const good = (await createBackup()).data;
  const wrongKey = remake(good, (f, m) => {
    const k = Buffer.from(crypto.randomBytes(32).toString("hex"));
    f.set("secret.key", k);
    (m.files as Record<string, { size: number; sha256: string }>)["secret.key"] = { size: k.length, sha256: sha(k) };
  });
  await assert.rejects(() => parseBackup(wrongKey), /doesn't unlock its settings/);
});

test("restoring makes the safety copy first, then swaps database and key", async () => {
  const good = await parseBackup((await createBackup()).data);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-restore-"));
  const paths = { db: path.join(dir, "animearr.db"), key: path.join(dir, "secret.key") };
  fs.writeFileSync(paths.db, "old database");
  fs.writeFileSync(`${paths.db}-wal`, "old wal");
  fs.writeFileSync(paths.key, "old key");
  const order: string[] = [];
  applyBackup(good, paths, {
    safety: () => {
      assert.equal(fs.readFileSync(paths.db, "utf8"), "old database", "nothing touched before the safety copy");
      order.push("safety");
    },
    closeDb: () => void order.push("close"),
  });
  assert.deepEqual(order, ["safety", "close"]);
  assert.ok(good.db.equals(fs.readFileSync(paths.db)));
  assert.equal(fs.readFileSync(paths.key, "utf8"), good.key.toString("utf8").trim());
  assert.ok(!fs.existsSync(`${paths.db}-wal`), "the old journal is gone");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["animearr.db", "secret.key"]);
});

test("the live database is replaced by a rename, never deleted first; a copy that fails its check changes nothing", async () => {
  const good = await parseBackup((await createBackup()).data);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-restore-"));
  const paths = { db: path.join(dir, "animearr.db"), key: path.join(dir, "secret.key") };
  fs.writeFileSync(paths.db, "old database");
  fs.writeFileSync(paths.key, "old key");
  // While the database is being swapped, the live path must always hold a file.
  const realRm = fs.rmSync;
  const removed: string[] = [];
  (fs as { rmSync: typeof fs.rmSync }).rmSync = ((p: fs.PathLike, o?: fs.RmOptions) => {
    removed.push(String(p));
    return realRm(p, o);
  }) as typeof fs.rmSync;
  try {
    applyBackup(good, paths, { safety: () => undefined, closeDb: () => undefined });
  } finally {
    (fs as { rmSync: typeof fs.rmSync }).rmSync = realRm;
  }
  assert.ok(!removed.includes(paths.db), "the live file is never deleted before the rename");
  assert.ok(good.db.equals(fs.readFileSync(paths.db)));
  // A damaged copy (here: the bytes aren't a database) is caught before the swap.
  fs.writeFileSync(paths.db, "old database");
  fs.writeFileSync(paths.key, "old key");
  const broken = { ...good, db: Buffer.from("not a database at all, just text that is long enough".repeat(20)) };
  assert.throws(
    () => applyBackup(broken, paths, { safety: () => undefined, closeDb: () => assert.fail("must not close the database") }),
    /nothing was changed/,
  );
  assert.equal(fs.readFileSync(paths.db, "utf8"), "old database");
  assert.equal(fs.readFileSync(paths.key, "utf8"), "old key");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["animearr.db", "secret.key"], "no temporary files left");
});

test("a failing safety copy stops the restore before anything changes", async () => {
  const good = await parseBackup((await createBackup()).data);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-restore-"));
  const paths = { db: path.join(dir, "animearr.db"), key: path.join(dir, "secret.key") };
  fs.writeFileSync(paths.db, "old database");
  fs.writeFileSync(paths.key, "old key");
  assert.throws(
    () =>
      applyBackup(good, paths, {
        safety: () => {
          throw new Error("disk full");
        },
        closeDb: () => assert.fail("must not close the database"),
      }),
    /disk full/,
  );
  assert.equal(fs.readFileSync(paths.db, "utf8"), "old database");
  assert.equal(fs.readFileSync(paths.key, "utf8"), "old key");
});

test("the real safety copy is a database backup plus the current key", async () => {
  const before = listBackups().filter((b) => b.kind === "prerestore").length;
  safetyBackup();
  assert.equal(listBackups().filter((b) => b.kind === "prerestore").length, before + 1);
  assert.ok(fs.readdirSync(BACKUP_DIR).some((f) => /^animearr-prerestore-.*\.secret\.key$/.test(f)));
  assert.equal(getSettings().externalUrl, "http://backup-test.lan", "the live data is untouched");
});
