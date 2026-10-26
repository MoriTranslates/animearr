/**
 * AniList GraphQL client (no key needed). Gentle: one request at a time, ≥ 2.1 s apart (AniList's degraded limit is 30/min),
 * backs off on 429. Used for AnimeArr's own metadata (titles, format, status, schedule, covers, relations).
 */
import { USER_AGENT } from "./metadata.js";

export interface AniMedia {
  id: number;
  idMal: number | null;
  title: { romaji: string | null; english: string | null; native: string | null };
  synonyms: string[];
  format: string | null;
  status: string | null;
  episodes: number | null;
  duration: number | null;
  season: string | null;
  seasonYear: number | null;
  startDate: { year: number | null; month: number | null; day: number | null };
  endDate: { year: number | null; month: number | null; day: number | null };
  countryOfOrigin: string | null;
  coverImage: { large: string | null; color: string | null };
  bannerImage: string | null;
  description: string | null;
  genres: string[];
  isAdult: boolean;
  relations: { edges: { relationType: string; node: { id: number; type: string; format: string | null } }[] };
  airingSchedule: { nodes: { episode: number; airingAt: number }[] };
  nextAiringEpisode: { episode: number; airingAt: number } | null;
  streamingEpisodes: { title: string | null }[];
}

const FIELDS = `id idMal title { romaji english native } synonyms format status episodes duration season seasonYear
  startDate { year month day } endDate { year month day } countryOfOrigin coverImage { large color } bannerImage
  description(asHtml: false) genres isAdult
  relations { edges { relationType node { id type format } } }
  airingSchedule(perPage: 50) { nodes { episode airingAt } }
  nextAiringEpisode { episode airingAt }
  streamingEpisodes { title }`;

let last = 0;
let chain: Promise<unknown> = Promise.resolve();

/** One GraphQL call, serialised and spaced. */
export function anilistQuery<T>(query: string, variables: Record<string, unknown>, fetcher: typeof fetch = fetch): Promise<T> {
  const run = async (): Promise<T> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = Math.max(0, last + 2100 - Date.now());
      if (wait) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      const res = await fetcher("https://graphql.anilist.co", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429) {
        const raw = Number(res.headers.get("retry-after"));
        const after = Number.isFinite(raw) && raw > 0 ? raw : 60;
        await new Promise((r) => setTimeout(r, Math.min(120, after) * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
      const j = (await res.json()) as { data?: T; errors?: { message: string }[] };
      if (j.errors?.length && !j.data) throw new Error(`AniList: ${j.errors[0].message}`);
      if (!j.data) throw new Error("AniList: empty response");
      return j.data as T;
    }
    throw new Error("AniList is rate-limiting us; try again later");
  };
  const p = chain.then(run, run);
  chain = p.catch(() => undefined);
  return p;
}

/** Media by AniList ids (50 per request). */
export async function mediaByIds(ids: number[], fetcher?: typeof fetch): Promise<AniMedia[]> {
  const out: AniMedia[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const d = await anilistQuery<{ Page: { media: AniMedia[] } }>(`query ($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids, type: ANIME) { ${FIELDS} } } }`, { ids: ids.slice(i, i + 50) }, fetcher);
    out.push(...(d.Page?.media ?? []));
  }
  return out;
}

/** Title search (English, romaji, native, synonyms), anime only. */
export async function searchMedia(q: string, perPage = 15, fetcher?: typeof fetch): Promise<AniMedia[]> {
  const d = await anilistQuery<{ Page: { media: AniMedia[] } }>(`query ($q: String, $n: Int) { Page(perPage: $n) { media(search: $q, type: ANIME, sort: SEARCH_MATCH) { ${FIELDS} } } }`, { q, n: perPage }, fetcher);
  return d.Page?.media ?? [];
}
