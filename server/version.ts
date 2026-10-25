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
export const VERSION = JSON.parse(fs.readFileSync(PKG, "utf8")).version as string;
