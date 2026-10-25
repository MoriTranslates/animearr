import fs from "node:fs";
import { getSettings, type PathMapping } from "./settings.js";

function apply(p: string, maps: PathMapping[]): string | null {
  const norm = p.replace(/\\/g, "/");
  // Longest prefix wins.
  const m = [...maps].sort((a, b) => b.from.length - a.from.length).find((x) => {
    const f = x.from.replace(/\\/g, "/").replace(/\/+$/, "");
    return norm === f || norm.startsWith(`${f}/`);
  });
  if (!m) return null;
  const f = m.from.replace(/\\/g, "/").replace(/\/+$/, "");
  return m.to.replace(/[\\/]+$/, "") + norm.slice(f.length);
}

/** Sonarr/client path → a path this machine can open, or null when no mapping applies (or it isn't reachable). */
export function localPath(p: string): string | null {
  const mapped = apply(p, getSettings().localPathMappings);
  const candidate = mapped ?? p;
  try {
    fs.accessSync(candidate);
    return candidate;
  } catch {
    return null;
  }
}

/** Download-client path → Sonarr path (remote path mappings); unchanged when none applies. */
export function clientToSonarr(p: string): string {
  return apply(p, getSettings().remotePathMappings) ?? p.replace(/\\/g, "/");
}
