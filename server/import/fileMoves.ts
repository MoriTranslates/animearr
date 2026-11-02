/**
 * File operations that never overwrite (a leaf: used by the importer, the renamer and the subtitle tools).
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Renames a → b; fails if b exists (link + unlink; exclusive copy across disks). All or nothing: when the source can't
 * be removed, the link or copy just made at b goes again, so a failed move leaves only the source.
 */
export async function moveNoClobber(a: string, b: string) {
  fs.mkdirSync(path.dirname(b), { recursive: true });
  try {
    fs.linkSync(a, b); // EEXIST if b exists: never overwritten
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new Error(`${path.basename(b)} already exists: not overwritten`);
    if (code !== "EXDEV" && code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw e;
    await copyNoClobber(a, b);
    // Checked before the source goes: a copy that came out short (a full disk on some filesystems) never costs it.
    if (fs.statSync(b).size !== fs.statSync(a).size) {
      dropOwn(b, a, new Error(`the copy of ${path.basename(a)} came out short; the original was kept`));
    }
  }
  try {
    fs.unlinkSync(a);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return; // the source is already gone: b holds the file, moved
    dropOwn(b, a, e as Error);
  }
}

/**
 * Removes the link or copy this move just made at b (ours: b didn't exist before), then throws why the move failed.
 * Only while the source is still there: b is never removed when it may be the last copy.
 */
function dropOwn(b: string, a: string, why: Error): never {
  if (!fs.existsSync(a)) throw new Error(`${why.message}; ${a} is gone, so the file is kept at ${b}`, { cause: why });
  try {
    fs.unlinkSync(b);
  } catch (re) {
    throw new Error(`${why.message}; and the extra copy at ${b} couldn't be removed (${(re as Error).message}): ${a} is the original`, {
      cause: why,
    });
  }
  throw why;
}

/**
 * Copies a → b; fails if b exists; a failed copy leaves nothing behind. Asynchronous: a 1.5 GB copy between shares
 * takes ~20 s, and the web UI must keep answering meanwhile.
 */
export async function copyNoClobber(a: string, b: string) {
  fs.mkdirSync(path.dirname(b), { recursive: true });
  try {
    await fs.promises.copyFile(a, b, fs.constants.COPYFILE_EXCL);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${path.basename(b)} already exists: not overwritten`);
    fs.rmSync(b, { force: true }); // ours: COPYFILE_EXCL created it
    throw e;
  }
}
