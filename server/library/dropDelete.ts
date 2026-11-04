/**
 * "Drop" → "Also delete it: all episodes, the folder, and remove it from my library", and Remove for a show whose
 * record Sonarr holds. AnimeArr never calls Sonarr here: it works on its own records, its own files and its own
 * recycling bin only (removeFiles.ts, with `block`). Sonarr's record of the show stays in Sonarr, untouched; AnimeArr
 * just never shows or adopts it again (the block, dropped.removed = 1).
 *
 * Order: the files move to the bin first (refused or failed: nothing else changes, the show stays as it was), then the
 * show is dropped, blocked and excluded from import lists, then forgotten (its card goes). A retry after a half-done
 * run finds the folder gone and just finishes the rest.
 */
import { cache, db, tx } from "../system/db.js";
import { logDecision } from "../system/activity.js";
import { invalidateIndex } from "../metadata/metadata.js";
import { dropShow, isBlocked } from "./dropped.js";
import { excludeShow } from "./importLists.js";
import { removeShow } from "./native.js";
import { NATIVE_BASE } from "./nativeIds.js";
import { binOwnFolder, withRemoveLock } from "./removeFiles.js";

const err = (msg: string, statusCode = 400) => Object.assign(new Error(msg), { statusCode });
const ACTIVE = "('sending', 'downloading', 'importing', 'needs-attention', 'removing')";

/** Every per-show row AnimeArr keeps by tvdbId that makes it act on the show (the native removeShow's list). */
const PER_SHOW = ["managed", "series_scope", "series_prefs", "fill_queue", "search_state", "upgrade_state"];

export async function dropShowAndRemove(tvdbId: number, o: { why?: string; deleteFiles: boolean }) {
  const owner = { kind: "show", tvdbId, block: true } as const;
  return withRemoveLock(owner, async () => {
    const native = !!db.prepare("SELECT 1 FROM native_series WHERE tvdb_id = ?").get(tvdbId);
    const row = cache.prepare("SELECT title FROM series WHERE tvdb_id = ?").get(tvdbId) as { title: string } | undefined;
    if (!native && !row) {
      if (isBlocked(tvdbId)) return { tvdbId, removed: true, already: true }; // a second click after it finished
      throw err("That show isn't in the library", 404);
    }
    const title = row?.title ?? (db.prepare("SELECT title FROM native_series WHERE tvdb_id = ?").get(tvdbId) as { title: string }).title;
    // Remove only (no files): a download still landing would import into a show AnimeArr just forgot.
    if (!o.deleteFiles && db.prepare(`SELECT 1 FROM grabs WHERE dry_run = 0 AND tvdb_id = ? AND state IN ${ACTIVE}`).get(tvdbId))
      throw err("A download for this show is still in progress; wait for it, or remove it in Activity, first", 409);
    const binned = o.deleteFiles ? await binOwnFolder(owner) : null; // throws (and changes nothing else) when refused or failed
    const what = binned
      ? binned.folderMissing
        ? "removed from the library (its folder was already gone)"
        : `deleted: ${binned.moved} file${binned.moved === 1 ? "" : "s"} went to AnimeArr's recycling bin, then it was removed from the library`
      : "removed from the library (its files were left alone)";
    const why = `${o.why?.trim() ? `${o.why.trim()}; ` : ""}dropped and ${what}`;
    // Blocked before forgotten: the exclusions read the show's AniList entries, and nothing may re-add it in between.
    const excluded = excludeShow(tvdbId, title, { blocked: true });
    await dropShow(tvdbId, { removed: why });
    if (native) removeShow(tvdbId, { filesBinned: !!binned?.moved });
    tx(cache, () => {
      for (const s of cache.prepare(`SELECT id FROM series WHERE tvdb_id = ? AND id < ${NATIVE_BASE}`).all(tvdbId) as { id: number }[])
        for (const t of ["series WHERE id", "episodes WHERE series_id", "files WHERE series_id", "alt_titles WHERE series_id"])
          cache.prepare(`DELETE FROM ${t} = ?`).run(s.id);
    });
    tx(db, () => {
      for (const t of PER_SHOW) db.prepare(`DELETE FROM ${t} WHERE tvdb_id = ?`).run(tvdbId);
    });
    invalidateIndex();
    logDecision("managed", {
      tvdbId,
      title,
      why: `You dropped ${title}: ${what}. It is blocked: Sonarr's list, import lists and Add won't bring it back until you unblock it (Import lists → Blocked shows). Sonarr wasn't asked to change anything.`,
    });
    return { tvdbId, title, removed: true, excluded, ...(binned ? { binned } : {}) };
  });
}
