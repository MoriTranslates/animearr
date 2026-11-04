/**
 * Blind review L8: moveNoClobber never leaves a stray copy or extra hardlink behind when the source can't be removed,
 * and never removes the source after a short cross-disk copy. A move either happened (only the destination) or didn't
 * (only the source).
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-mnc-"));
process.env.ANIMEARR_NO_LOCK = "1";
const { moveNoClobber } = await import("../server/import/importer.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-mnc-f-"));
let n = 0;
/** A fresh source file and a destination in another folder. */
function pair() {
  n++;
  const a = path.join(tmp, "src", `ep${n}.mkv`);
  const b = path.join(tmp, "bin", "Show", `ep${n}.mkv`);
  fs.mkdirSync(path.dirname(a), { recursive: true });
  fs.writeFileSync(a, `episode ${n} `.repeat(1000));
  return { a, b, content: fs.readFileSync(a, "utf8") };
}
const errno = (code: string) => Object.assign(new Error(`${code}: simulated`), { code });

const real = { link: fs.linkSync, unlink: fs.unlinkSync, copy: fs.promises.copyFile };
let linkFault: string | null = null;
let unlinkFault: ((p: string) => string | null) | null = null;
let shortCopy = false;
(fs as { linkSync: unknown }).linkSync = (a: fs.PathLike, b: fs.PathLike) => {
  if (linkFault) throw errno(linkFault);
  return real.link(a, b);
};
(fs as { unlinkSync: unknown }).unlinkSync = (p: fs.PathLike) => {
  const code = unlinkFault?.(path.resolve(String(p)));
  if (code) throw errno(code);
  return real.unlink(p);
};
(fs.promises as { copyFile: unknown }).copyFile = async (a: fs.PathLike, b: fs.PathLike, mode?: number) => {
  if (!shortCopy) return real.copy(a, b, mode);
  // A copy that "succeeds" but comes out short (some network/FUSE filesystems when the disk fills up).
  fs.writeFileSync(b, fs.readFileSync(a).subarray(0, 100), { flag: "wx" });
};
afterEach(() => {
  linkFault = null;
  unlinkFault = null;
  shortCopy = false;
});

function assertNotMoved(p: { a: string; b: string; content: string }) {
  assert.equal(fs.readFileSync(p.a, "utf8"), p.content, "the source is intact");
  assert.equal(fs.existsSync(p.b), false, "no stray copy or hardlink at the destination");
}

for (const code of ["EPERM", "EBUSY", "EACCES"])
  test(`hardlinked, then the source can't be removed (${code}): the extra link goes, the source stays`, async () => {
    const p = pair();
    unlinkFault = (f) => (f === path.resolve(p.a) ? code : null);
    await assert.rejects(moveNoClobber(p.a, p.b), new RegExp(code));
    assertNotMoved(p);
  });

test("across disks, a copy that comes out short: the source is never removed, the short copy goes", async () => {
  const p = pair();
  linkFault = "EXDEV";
  shortCopy = true;
  await assert.rejects(moveNoClobber(p.a, p.b), /short/);
  assertNotMoved(p);
});

test("across disks, copied but the source can't be removed (EBUSY): the copy goes, the source stays", async () => {
  const p = pair();
  linkFault = "EXDEV";
  unlinkFault = (f) => (f === path.resolve(p.a) ? "EBUSY" : null);
  await assert.rejects(moveNoClobber(p.a, p.b), /EBUSY/);
  assertNotMoved(p);
});

test("a normal move still works, on the same disk and across disks; an existing file is never overwritten", async () => {
  for (const fault of [null, "EXDEV"]) {
    const p = pair();
    linkFault = fault;
    await moveNoClobber(p.a, p.b);
    assert.equal(fs.existsSync(p.a), false);
    assert.equal(fs.readFileSync(p.b, "utf8"), p.content);
  }
  linkFault = null;
  const p = pair();
  fs.mkdirSync(path.dirname(p.b), { recursive: true });
  fs.writeFileSync(p.b, "someone else's");
  await assert.rejects(moveNoClobber(p.a, p.b), /already exists/);
  assert.equal(fs.readFileSync(p.b, "utf8"), "someone else's");
  assert.equal(fs.readFileSync(p.a, "utf8"), p.content);
});

test("the source vanished right after the link (ENOENT): the file at the destination is kept, the move counts", async () => {
  const p = pair();
  unlinkFault = (f) => {
    if (f !== path.resolve(p.a)) return null;
    real.unlink(p.a); // someone else removed it meanwhile
    return "ENOENT";
  };
  await moveNoClobber(p.a, p.b);
  assert.equal(fs.readFileSync(p.b, "utf8"), p.content, "the only copy is kept");
});
