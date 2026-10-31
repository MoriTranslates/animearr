/**
 * Propers and repacks: fansub groups re-release an episode as v2 / v3 (or scene PROPER / REPACK) to fix errors. The
 * setting "Propers and repacks" (Settings → Media management) decides what that means:
 * - preferAndUpgrade: a higher version from the SAME group as the file you have replaces it (and wins in searches);
 * - doNotUpgrade: a higher version wins when choosing a new release, but never replaces an existing file;
 * - doNotPrefer: versions are ignored.
 * Pure: the library side (which file we have, locks) is in propers.ts at the server root.
 */
import { parseRelease, type ParsedRelease } from "./parser.js";

export type ProperMode = "preferAndUpgrade" | "doNotUpgrade" | "doNotPrefer";

/** Who released an episode and which version of it. */
export interface Revision {
  group: string | null;
  version: number;
}
/** The file we have: its revision, and whether it is locked ([Keep] / [Remaster], a locked show or season, keep-originals). */
export interface HaveRevision extends Revision {
  locked?: boolean;
}

export const revisionOf = (release: string | ParsedRelease): Revision => {
  const p = typeof release === "string" ? parseRelease(release) : release;
  return { group: p.group, version: p.version };
};

const sameGroup = (a: string | null, b: string | null) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** Score points a version earns in a search (a tiebreaker among releases of one group; none when versions are ignored). */
export const versionPoints = (version: number, mode: ProperMode) => (mode === "doNotPrefer" ? 0 : Math.min(Math.max(version - 1, 0), 3) * 2);

/**
 * Is the candidate a newer version of the file we have? Same group (case-insensitive), a higher version, the file isn't
 * locked and the setting allows upgrades. The caller checks the quality category (a lower one never qualifies); the
 * release rules and the blocklist have already had their say by the time this is asked.
 */
export function isNewerRevision(have: HaveRevision, cand: Revision, mode: ProperMode): { ok: boolean; why: string } {
  if (mode !== "preferAndUpgrade") return { ok: false, why: mode === "doNotUpgrade" ? "newer versions don't replace files you already have (Settings → Media management)" : "versions are ignored (Settings → Media management)" };
  if (have.locked) return { ok: false, why: "your file is locked (keep as is)" };
  if (!sameGroup(have.group, cand.group)) return { ok: false, why: `a different group than your file${have.group ? ` (${have.group})` : ""}` };
  if (cand.version <= have.version) return { ok: false, why: cand.version === have.version ? `same version as your file (v${have.version})` : `older than your file (v${have.version})` };
  return { ok: true, why: `v${cand.version} of the episode you have from ${have.group} (fixes a v${have.version}) — upgrade` };
}
