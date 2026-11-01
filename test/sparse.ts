import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * A file that reports `size` bytes but takes no disk space. On Linux and macOS a truncated file is sparse by itself; on
 * Windows NTFS allocates every byte unless the file is flagged sparse first (a few test runs filled a drive that way).
 */
export function sparseFile(p: string, size: number) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "");
  if (process.platform === "win32") {
    try {
      execFileSync("fsutil", ["sparse", "setflag", p], { stdio: "ignore" });
    } catch {
      /* no fsutil: the file still works, it just takes real space */
    }
  }
  fs.truncateSync(p, size);
}
