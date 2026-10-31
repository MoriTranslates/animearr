import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function findPackageJson() {
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    const p = path.join(dir, "package.json");
    if (fs.existsSync(p)) return p;
    if (path.dirname(dir) === dir) throw new Error("package.json not found");
  }
}
const PKG = findPackageJson();
export const ROOT_DIR = path.dirname(PKG);
// Nightly images add the commit they were built from ("0.10.0-nightly+1a2b3c4"), so a bug report names the exact build.
const BUILD = (process.env.ANIMEARR_BUILD ?? "").trim().slice(0, 7);
export const VERSION = (JSON.parse(fs.readFileSync(PKG, "utf8")).version as string) + (BUILD ? `+${BUILD}` : "");
