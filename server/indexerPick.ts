/**
 * Which of Prowlarr's indexers AnimeArr asks (settings.prowlarr.indexerIds; empty = all). Prowlarr itself is never
 * changed: an unticked indexer stays available to Sonarr/Radarr.
 *
 * - An "anime fit" hint per indexer from the curated catalogue (catalog/indexers.json → animeFit).
 * - New Prowlarr indexers (not seen before) get a default: ticked when they have anime categories (5070) and aren't
 *   known to be a poor fit, unticked otherwise, plus a "New indexer, review" badge until the user ticks/unticks it.
 * - The first time (fresh install / wizard), with nothing chosen yet, the same defaults pick the list.
 */
import { wizardState } from "./wizard.js";
import { getSettings, patchSettings } from "./settings.js";
import { prowlarrConfigured, prowlarrIndexerDetails, type ProwlarrIndexerDetail } from "./arr/prowlarr.js";
import { indexerCatalog } from "./connectionsAdmin.js";

export type AnimeFit = "great" | "general" | "not";

/** The catalogue's verdict for an indexer, by name/definition (case-insensitive substring); null = unknown. */
export function animeFit(name: string, definition = ""): AnimeFit | null {
  const fit = indexerCatalog().animeFit;
  if (!fit) return null;
  const hay = `${name} ${definition}`.toLowerCase();
  // "not" first: Sukebei (adult) is a Nyaa site but not for anime.
  for (const k of ["not", "great", "general"] as const) if ((fit[k] ?? []).some((p) => hay.includes(p.toLowerCase()))) return k;
  return null;
}

/** The default for an indexer AnimeArr hasn't seen: ticked when it carries anime and isn't a known poor fit. */
export const defaultTick = (ix: Pick<ProwlarrIndexerDetail, "name" | "definitionName" | "animeCategories">) => ix.animeCategories && animeFit(ix.name, ix.definitionName ?? "") !== "not";

/** Applies the defaults to new Prowlarr indexers; returns the indexers with their selection state. */
export async function syncProwlarrSelection(list?: ProwlarrIndexerDetail[]) {
  const all = list ?? (await prowlarrIndexerDetails());
  const p = getSettings().prowlarr;
  const known = new Set(p.knownIds ?? []);
  const fresh = all.filter((x) => !known.has(x.id));
  if (fresh.length) {
    patchSettings((s) => {
      const cur = s.prowlarr;
      let ids = [...cur.indexerIds];
      let review = [...(cur.newIds ?? [])];
      if (!known.size) {
        // First time on a fresh install (setup wizard not finished), nothing chosen yet → pick by the defaults (all
        // of them = keep the empty "all" list). An existing install keeps what it had ("all" stays "all").
        if (!ids.length && !wizardState().done) {
          const picked = all.filter(defaultTick).map((x) => x.id);
          ids = picked.length && picked.length < all.length ? picked : [];
        }
      } else {
        // Later: a new indexer gets its default and a review badge.
        review.push(...fresh.map((x) => x.id));
        const off = fresh.filter((x) => !defaultTick(x));
        if (ids.length) ids.push(...fresh.filter(defaultTick).map((x) => x.id));
        else if (off.length) ids = all.filter((y) => !off.includes(y)).map((y) => y.id);
      }
      review = [...new Set(review)].filter((id) => all.some((x) => x.id === id));
      return { ...s, prowlarr: { ...cur, indexerIds: [...new Set(ids)], knownIds: [...new Set([...known, ...fresh.map((x) => x.id)])], newIds: review } };
    });
  }
  const now = getSettings().prowlarr;
  return all.map((x) => ({
    id: x.id,
    use: !now.indexerIds.length || now.indexerIds.includes(x.id),
    fit: animeFit(x.name, x.definitionName ?? ""),
    animeCategories: x.animeCategories,
    isNew: (now.newIds ?? []).includes(x.id),
  }));
}

let lastSync = 0;
/** Before a search: make sure new Prowlarr indexers got their default (at most every 10 minutes). */
export async function ensureProwlarrSelection(now = Date.now()) {
  if (!prowlarrConfigured() || now - lastSync < 10 * 60_000) return;
  lastSync = now;
  await syncProwlarrSelection().catch(() => undefined);
}

/** The user ticks/unticks one indexer: "all" (empty) becomes an explicit list on the first untick. */
export async function setIndexerUse(indexerId: number, use: boolean) {
  const all = await prowlarrIndexerDetails();
  if (!all.some((x) => x.id === indexerId)) throw Object.assign(new Error("Prowlarr doesn't have that indexer"), { statusCode: 404 });
  patchSettings((s) => {
    const cur = s.prowlarr;
    let ids = cur.indexerIds.length ? [...cur.indexerIds] : all.map((x) => x.id);
    ids = use ? [...new Set([...ids, indexerId])] : ids.filter((x) => x !== indexerId);
    // An empty list means "all": unticking the last one can't be expressed (and would search nothing).
    if (!ids.filter((id) => all.some((x) => x.id === id)).length) throw Object.assign(new Error("Keep at least one indexer ticked"), { statusCode: 400 });
    // Every indexer ticked again = back to "all" (new ones then join automatically by default).
    const everything = all.every((x) => ids.includes(x.id));
    return { ...s, prowlarr: { ...cur, indexerIds: everything ? [] : ids.filter((id) => all.some((x) => x.id === id)), newIds: (cur.newIds ?? []).filter((x) => x !== indexerId) } };
  });
  return { ok: true };
}
