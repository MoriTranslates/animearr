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
const { BACKUP_DIR, listBackups, restartNeeded, userSchemaVersion } = await import("../server/system/db.js");
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
    beforeSwap: () => void order.push("beforeSwap"),
    closeDb: () => void order.push("close"),
  });
  assert.deepEqual(order, ["safety", "beforeSwap", "close"]);
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
    applyBackup(good, paths, { safety: () => undefined, beforeSwap: () => undefined, closeDb: () => undefined });
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
    () =>
      applyBackup(broken, paths, {
        safety: () => undefined,
        beforeSwap: () => assert.fail("must not run before a checked copy"),
        closeDb: () => assert.fail("must not close the database"),
      }),
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
        beforeSwap: () => assert.fail("must not run"),
        closeDb: () => assert.fail("must not close the database"),
      }),
    /disk full/,
  );
  assert.equal(fs.readFileSync(paths.db, "utf8"), "old database");
  assert.equal(fs.readFileSync(paths.key, "utf8"), "old key");
});

// ---------------------------------------------------------------- blind review round 4, M1: failures after the close

/** A fresh folder with an old database and key, plus a renameSync that throws for the chosen targets. */
async function stoppedSetup() {
  const good = await parseBackup((await createBackup()).data);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-restore-"));
  const paths = { db: path.join(dir, "animearr.db"), key: path.join(dir, "secret.key") };
  fs.writeFileSync(paths.db, "old database");
  fs.writeFileSync(paths.key, "old key");
  return { good, dir, paths };
}
function withFailingRename<T>(fails: (to: string) => boolean, run: () => T): T {
  const real = fs.renameSync;
  fs.renameSync = ((a: fs.PathLike, b: fs.PathLike) => {
    if (fails(String(b))) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
    real(a, b);
  }) as typeof fs.renameSync;
  try {
    return run();
  } finally {
    fs.renameSync = real;
  }
}
const hooksFor = (closed: string[]) => ({
  safety: () => "the-safety-copy",
  beforeSwap: () => undefined,
  closeDb: () => void closed.push("close"),
});

test("M1: a failing beforeSwap changes nothing, never closes the database and is not a restart", async () => {
  const { good, dir, paths } = await stoppedSetup();
  let caught: unknown;
  try {
    applyBackup(good, paths, {
      safety: () => undefined,
      beforeSwap: () => {
        throw new Error("ENOSPC floor");
      },
      closeDb: () => assert.fail("must not close the database"),
    });
  } catch (e) {
    caught = e;
  }
  assert.match(String((caught as Error).message), /ENOSPC floor.*nothing was changed/);
  assert.equal(restartNeeded(caught), false, "a retry is fine: nothing live was touched");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["animearr.db", "secret.key"]);
});

test("M1: the database rename failing after the close leaves the old database and key, and needs a restart", async () => {
  const { good, dir, paths } = await stoppedSetup();
  const closed: string[] = [];
  let caught: unknown;
  const renames: string[] = [];
  try {
    withFailingRename(
      (to) => (renames.push(to), to === paths.db),
      () => applyBackup(good, paths, hooksFor(closed)),
    );
  } catch (e) {
    caught = e;
  }
  assert.deepEqual(closed, ["close"]);
  assert.deepEqual(renames, [paths.db], "the database goes first; the key is never touched once that fails");
  assert.equal(restartNeeded(caught), true);
  const msg = (caught as Error).message;
  assert.match(msg, /EPERM.*undone: your previous database and its key are in place/);
  assert.match(msg, /restarting/);
  assert.match(msg, /the-safety-copy/);
  assert.doesNotMatch(msg, /without choosing the file again|nothing was changed/);
  assert.equal(fs.readFileSync(paths.db, "utf8"), "old database");
  assert.equal(fs.readFileSync(paths.key, "utf8"), "old key");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["animearr.db", "secret.key"], "no temporary files left");
});

test("the key rename failing after the database landed: the key is written in place and the restore completes", async () => {
  const { good, dir, paths } = await stoppedSetup();
  withFailingRename(
    (to) => to === paths.key,
    () => applyBackup(good, paths, hooksFor([])),
  );
  assert.ok(good.db.equals(fs.readFileSync(paths.db)), "the backup's database is live");
  assert.equal(fs.readFileSync(paths.key, "utf8"), good.key.toString("utf8").trim(), "with the backup's key");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["animearr.db", "secret.key"], "no temporary files left");
});

test("if the key can neither be renamed nor written, the waiting key is kept for the next start, and the message says so", async () => {
  const { good, dir, paths } = await stoppedSetup();
  const realWrite = fs.writeFileSync;
  let caught: unknown;
  try {
    withFailingRename(
      (to) => to === paths.key,
      () => {
        fs.writeFileSync = ((f: fs.PathOrFileDescriptor, d: string | NodeJS.ArrayBufferView, o?: fs.WriteFileOptions) => {
          if (String(f) === paths.key) throw new Error("EACCES: permission denied");
          realWrite(f, d, o);
        }) as typeof fs.writeFileSync;
        try {
          return applyBackup(good, paths, hooksFor([]));
        } finally {
          fs.writeFileSync = realWrite;
        }
      },
    );
  } catch (e) {
    caught = e;
  }
  assert.equal(restartNeeded(caught), true);
  const msg = (caught as Error).message;
  assert.match(msg, /EPERM.*EACCES/);
  assert.match(msg, /backup's database is in place.*secret\.key\.restore-tmp.*when it starts again/);
  assert.match(msg, /the-safety-copy/);
  assert.ok(good.db.equals(fs.readFileSync(paths.db)), "the restore went forward: the backup's database is live");
  assert.equal(
    fs.readFileSync(`${paths.key}.restore-tmp`, "utf8"),
    good.key.toString("utf8").trim(),
    "the waiting key is kept, never deleted, for the next start",
  );
  assert.deepEqual(fs.readdirSync(dir).sort(), ["animearr.db", "secret.key", "secret.key.restore-tmp"]);
});

test("M1: closing the database failing is treated as past the point of no return (restart, no retry)", async () => {
  const { good, paths } = await stoppedSetup();
  let caught: unknown;
  try {
    applyBackup(good, paths, {
      safety: () => undefined,
      beforeSwap: () => undefined,
      closeDb: () => {
        throw new Error("database is not open");
      },
    });
  } catch (e) {
    caught = e;
  }
  assert.equal(restartNeeded(caught), true);
  assert.equal(fs.readFileSync(paths.db, "utf8"), "old database");
  assert.equal(fs.readFileSync(paths.key, "utf8"), "old key");
});

test("the real safety copy is a database backup plus the current key", async () => {
  const before = listBackups().filter((b) => b.kind === "prerestore").length;
  safetyBackup("upload");
  assert.equal(listBackups().filter((b) => b.kind === "prerestore").length, before + 1);
  assert.ok(fs.readdirSync(BACKUP_DIR).some((f) => /^animearr-prerestore-.*\.secret\.key$/.test(f)));
  assert.equal(getSettings().externalUrl, "http://backup-test.lan", "the live data is untouched");
});
