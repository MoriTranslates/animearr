/**
 * Import lists (Sonarr's "Import Lists"): a public AniList or MyAnimeList account whose anime AnimeArr adds to the
 * library, through the same add flow as Find & add (franchise placement, seasons, monitoring, tags).
 *
 * Safety: a list only ever ADDS. It never removes, unmonitors or changes a show (Sonarr's "clean library" isn't built).
 * The first sync of a list is a preview that needs a confirm; later syncs add by themselves (at most MAX_AUTO per run).
 * A show on the exclusion list is never added by any list.
 *
 * MyAnimeList: the official API v2 with a client ID the user makes for free at myanimelist.net/apiconfig (kept encrypted
 * in the settings). Jikan (a third-party scraper) needs no key, but it's unofficial and often down, so it isn't used.
 */
import { logDecision } from "./system/activity.js";
import { anilistQuery, mediaByIds, type AniMedia } from "./metadata/anilist.js";
import { fribb } from "./metadata/covers.js";
import { cache, db } from "./system/db.js";
import { droppedList } from "./dropped.js";
import { addToQueue } from "./fillin.js";
import { setManaged } from "./managed.js";
import { animeListEntries, USER_AGENT } from "./metadata/metadata.js";
import { addMovie, addShow, isNativeTvdb, NATIVE_BASE } from "./native.js";
import { setMoviePrefs, setSeriesPrefs } from "./profiles.js";
import { setScope, validateScope, type Scope } from "./scope.js";
import { getSettings } from "./system/settings.js";
import { setTags, tagRows } from "./tags.js";

export type ListSource = "anilist" | "mal";
/** AniList's statuses; MAL's are mapped onto them. */
export const LIST_STATUSES = ["CURRENT", "PLANNING", "COMPLETED", "PAUSED", "DROPPED", "REPEATING"] as const;
export type ListStatus = (typeof LIST_STATUSES)[number];
export const MAX_AUTO = 50;

const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export interface ListCfg {
  id: number;
  name: string;
  source: ListSource;
  username: string;
  statuses: ListStatus[];
  profileId: string | null;
  rootFolder: string;
  movieRootFolder: string;
  scope: Scope | null;
  /** What happens after an add: nothing, or the fill-in queue (paced; a list never starts a burst of searches). */
  then: "none" | "queue";
  tags: number[];
  enabled: boolean;
  confirmed: boolean;
  lastSyncAt: number | null;
  lastResult: ListResult;
  createdAt: number;
}

export interface PlanItem {
  anilistId: number;
  title: string;
  kind: "show" | "movie";
  status: ListStatus;
  action: "add" | "skip";
  reason?: string;
}
export interface ListResult {
  at?: number;
  /** Entries on the account / of the chosen statuses. */
  total?: number;
  matched?: number;
  /** Waiting for the first confirm: what a sync would add. */
  pending?: boolean;
  wouldAdd?: { anilistId: number; title: string; kind: "show" | "movie" }[];
  /** Added by this list, newest first (the last 30). */
  added?: { anilistId: number; title: string; at: number }[];
  skipped?: Record<string, number>;
  errors?: string[];
  error?: string;
}

interface Row {
  id: number;
  name: string;
  source: ListSource;
  username: string;
  statuses: string;
  profile_id: string | null;
  root_folder: string;
  movie_root_folder: string;
  scope: string | null;
  then_do: string;
  tags: string;
  enabled: number;
  confirmed: number;
  last_sync_at: number | null;
  last_result: string;
  created_at: number;
}

const parse = <T>(s: string | null | undefined, d: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : d;
  } catch {
    return d;
  }
};
const toCfg = (r: Row): ListCfg => ({
  id: r.id,
  name: r.name,
  source: r.source,
  username: r.username,
  statuses: parse<ListStatus[]>(r.statuses, []),
  profileId: r.profile_id,
  rootFolder: r.root_folder,
  movieRootFolder: r.movie_root_folder,
  scope: parse<Scope | null>(r.scope, null),
  then: r.then_do === "queue" ? "queue" : "none",
  tags: parse<number[]>(r.tags, []),
  enabled: !!r.enabled,
  confirmed: !!r.confirmed,
  lastSyncAt: r.last_sync_at,
  lastResult: parse<ListResult>(r.last_result, {}),
  createdAt: r.created_at,
});

export const listLists = (): ListCfg[] => (db.prepare("SELECT * FROM import_lists ORDER BY id").all() as unknown as Row[]).map(toCfg);
export const getList = (id: number): ListCfg => {
  const r = db.prepare("SELECT * FROM import_lists WHERE id = ?").get(id) as unknown as Row | undefined;
  if (!r) throw fail("List not found", 404);
  return toCfg(r);
};

/** Validates an untrusted list definition (the browser's form). */
export function cleanList(input: Record<string, unknown>): Omit<ListCfg, "id" | "confirmed" | "lastSyncAt" | "lastResult" | "createdAt"> {
  const source = input.source === "mal" ? "mal" : input.source === "anilist" ? "anilist" : null;
  if (!source) throw fail("Pick AniList or MyAnimeList");
  const username = String(input.username ?? "").trim();
  if (!/^[\w .-]{1,60}$/.test(username)) throw fail("Enter the account's username");
  const name =
    String(input.name ?? "")
      .trim()
      .slice(0, 60) || `${source === "mal" ? "MyAnimeList" : "AniList"}: ${username}`;
  const statuses = [...new Set(Array.isArray(input.statuses) ? input.statuses.map(String) : [])].filter((x): x is ListStatus =>
    (LIST_STATUSES as readonly string[]).includes(x),
  );
  if (!statuses.length) throw fail("Pick at least one list status to import");
  const s = getSettings();
  const profileId = input.profileId ? String(input.profileId) : null;
  if (profileId && !s.profiles.some((p) => p.id === profileId)) throw fail("Unknown profile");
  const root = (v: unknown, what: string) => {
    const r = String(v ?? "")
      .trim()
      .replace(/\/+$/, "");
    if (r && !s.allowedRoots.some((a) => a.replace(/\/+$/, "") === r)) throw fail(`Pick one of the library folders for ${what}`);
    return r;
  };
  const known = new Set(tagRows().map((t) => t.id));
  return {
    name,
    source,
    username,
    statuses,
    profileId,
    rootFolder: root(input.rootFolder, "shows"),
    movieRootFolder: root(input.movieRootFolder, "movies"),
    scope: input.scope ? validateScope(input.scope as Partial<Scope>) : null,
    then: input.then === "queue" ? "queue" : "none",
    tags: [...new Set(Array.isArray(input.tags) ? input.tags.map(Number) : [])].filter((x) => known.has(x)),
    enabled: input.enabled !== false,
  };
}

export function saveList(id: number | null, input: Record<string, unknown>): ListCfg {
  const c = cleanList(input);
  if (!id && (db.prepare("SELECT COUNT(*) AS n FROM import_lists").get() as { n: number }).n >= 20) throw fail("Up to 20 lists");
  const args = [
    c.name,
    c.source,
    c.username,
    JSON.stringify(c.statuses),
    c.profileId,
    c.rootFolder,
    c.movieRootFolder,
    c.scope ? JSON.stringify(c.scope) : null,
    c.then,
    JSON.stringify(c.tags),
    c.enabled ? 1 : 0,
  ] as const;
  if (id === null) {
    const r = db
      .prepare(
        "INSERT INTO import_lists (name, source, username, statuses, profile_id, root_folder, movie_root_folder, scope, then_do, tags, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(...args, Date.now());
    return getList(Number(r.lastInsertRowid));
  }
  const cur = getList(id);
  // A different account or wider statuses is a new list as far as safety goes: it shows its preview again.
  const same =
    cur.source === c.source && cur.username.toLowerCase() === c.username.toLowerCase() && c.statuses.every((x) => cur.statuses.includes(x));
  db.prepare(
    "UPDATE import_lists SET name = ?, source = ?, username = ?, statuses = ?, profile_id = ?, root_folder = ?, movie_root_folder = ?, scope = ?, then_do = ?, tags = ?, enabled = ?, confirmed = ? WHERE id = ?",
  ).run(...args, same && cur.confirmed ? 1 : 0, id);
  return getList(id);
}

export function deleteList(id: number) {
  const l = getList(id);
  db.prepare("DELETE FROM import_lists WHERE id = ?").run(id);
  logDecision("info", { why: `Removed the import list "${l.name}" (shows it added stay in your library)` });
}

// ---------------------------------------------------------------- exclusions

export const exclusions = () =>
  db.prepare("SELECT anilist_id AS anilistId, title, list_name AS listName, at FROM import_list_exclusions ORDER BY at DESC").all() as {
    anilistId: number;
    title: string;
    listName: string;
    at: number;
  }[];
export function addExclusion(anilistId: number, title = "", listName = "") {
  if (!Number.isInteger(anilistId) || anilistId <= 0) throw fail("Give the AniList id of the show");
  db.prepare(
    "INSERT INTO import_list_exclusions (anilist_id, title, list_name, at) VALUES (?, ?, ?, ?) ON CONFLICT(anilist_id) DO NOTHING",
  ).run(anilistId, title.slice(0, 200), listName.slice(0, 60), Date.now());
}
export const removeExclusion = (anilistId: number) =>
  void db.prepare("DELETE FROM import_list_exclusions WHERE anilist_id = ?").run(anilistId);
/** A show removed from the library: no list adds it (or the other seasons of it) again. */
export function excludeShow(tvdbId: number, title: string) {
  const ids = new Set<number>(
    (db.prepare("SELECT anilist_id FROM entries WHERE tvdb_id = ?").all(tvdbId) as { anilist_id: number }[]).map((r) => r.anilist_id),
  );
  const n = db.prepare("SELECT anilist_id FROM native_series WHERE tvdb_id = ?").get(tvdbId) as { anilist_id: number } | undefined;
  if (n) ids.add(n.anilist_id);
  for (const id of ids) addExclusion(id, title);
  return ids.size;
}

// ---------------------------------------------------------------- fetching the accounts

export interface ListDeps {
  fetcher: typeof fetch;
  media: typeof mediaByIds;
  fribb: typeof fribb;
  /** Tests: the account's entries without going through AniList/MAL. */ entries?: (
    l: Pick<ListCfg, "source" | "username">,
  ) => Promise<Raw[]>;
}
export const realListDeps: ListDeps = { fetcher: fetch, media: mediaByIds, fribb };
export interface Raw {
  id: number;
  status: ListStatus;
}

/** An AniList account's anime list (AniList's own client: serialised and spaced; 500 entries per chunk). */
export async function anilistUserEntries(user: string, fetcher: typeof fetch = fetch): Promise<Raw[]> {
  const out = new Map<number, ListStatus>();
  for (let chunk = 1; chunk <= 20; chunk++) {
    let d: { MediaListCollection: { hasNextChunk: boolean; lists: { entries: { mediaId: number; status: string }[] }[] } | null };
    try {
      d = await anilistQuery(
        `query ($u: String, $c: Int) { MediaListCollection(userName: $u, type: ANIME, chunk: $c, perChunk: 500) { hasNextChunk lists { entries { mediaId status } } } }`,
        { u: user, c: chunk },
        fetcher,
        { priority: true },
      );
    } catch (e) {
      if (/not found|private/i.test((e as Error).message)) throw fail(`AniList user "${user}" not found or the list is private`);
      throw e;
    }
    const col = d.MediaListCollection;
    if (!col) throw fail(`AniList user "${user}" not found or the list is private`);
    for (const l of col.lists)
      for (const e of l.entries)
        if ((LIST_STATUSES as readonly string[]).includes(e.status) && !out.has(e.mediaId)) out.set(e.mediaId, e.status as ListStatus);
    if (!col.hasNextChunk) break;
  }
  return [...out].map(([id, status]) => ({ id, status }));
}

const MAL_STATUS: Record<string, ListStatus> = {
  watching: "CURRENT",
  completed: "COMPLETED",
  on_hold: "PAUSED",
  dropped: "DROPPED",
  plan_to_watch: "PLANNING",
};

/** A MyAnimeList account's anime list (API v2), mapped from MAL ids to AniList ids. */
export async function malUserEntries(user: string, clientId: string, fetcher: typeof fetch = fetch): Promise<Raw[]> {
  if (!clientId)
    throw fail(
      "MyAnimeList needs a free API client ID (create one at myanimelist.net/apiconfig, then paste it in Settings → Import lists)",
    );
  const mal: { malId: number; status: ListStatus }[] = [];
  let url: string | null =
    `https://api.myanimelist.net/v2/users/${encodeURIComponent(user)}/animelist?fields=list_status&limit=1000&nsfw=true`;
  for (let page = 0; url && page < 30; page++) {
    const res: Response = await fetcher(url, {
      headers: { "X-MAL-CLIENT-ID": clientId, "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404 || res.status === 403) throw fail(`MyAnimeList user "${user}" not found or the list is private`);
    if (res.status === 401) throw fail("MyAnimeList refused the client ID; check it at myanimelist.net/apiconfig");
    if (!res.ok) throw fail(`MyAnimeList failed (HTTP ${res.status})`, 502);
    const d = (await res.json()) as {
      data?: { node: { id: number }; list_status?: { status?: string; is_rewatching?: boolean } }[];
      paging?: { next?: string };
    };
    for (const e of d.data ?? []) {
      const st = e.list_status?.is_rewatching ? "REPEATING" : MAL_STATUS[e.list_status?.status ?? ""];
      if (st && Number.isInteger(e.node?.id)) mal.push({ malId: e.node.id, status: st });
    }
    url = d.paging?.next && /^https:\/\/api\.myanimelist\.net\//.test(d.paging.next) ? d.paging.next : null;
  }
  // MAL id → AniList id: the catalog knows many already, AniList the rest.
  const ids = new Map<number, number>();
  const find = db.prepare("SELECT anilist_id FROM entries WHERE mal_id = ?");
  const unknown: number[] = [];
  for (const m of mal) {
    const e = find.get(m.malId) as { anilist_id: number } | undefined;
    if (e) ids.set(m.malId, e.anilist_id);
    else unknown.push(m.malId);
  }
  for (let i = 0; i < unknown.length; i += 50) {
    const d = await anilistQuery<{ Page: { media: { id: number; idMal: number | null }[] } }>(
      `query ($ids: [Int]) { Page(perPage: 50) { media(idMal_in: $ids, type: ANIME) { id idMal } } }`,
      { ids: unknown.slice(i, i + 50) },
      fetcher,
      { priority: true },
    );
    for (const m of d.Page?.media ?? []) if (m.idMal) ids.set(m.idMal, m.id);
  }
  const out = new Map<number, ListStatus>();
  for (const m of mal) {
    const id = ids.get(m.malId);
    if (id && !out.has(id)) out.set(id, m.status);
  }
  return [...out].map(([id, status]) => ({ id, status }));
}

const fetchEntries = (l: Pick<ListCfg, "source" | "username">, deps: ListDeps) =>
  deps.entries
    ? deps.entries(l)
    : l.source === "mal"
      ? malUserEntries(l.username, getSettings().lists.malClientId, deps.fetcher)
      : anilistUserEntries(l.username, deps.fetcher);

// ---------------------------------------------------------------- planning

interface Info {
  title: string;
  kind: "show" | "movie";
  tvdbId: number | null;
  tmdbMovie: number | null;
}
const titleOf = (m: { title_english?: string | null; title_romaji?: string | null; title_native?: string | null }, id: number) =>
  m.title_english ?? m.title_romaji ?? m.title_native ?? `AniList ${id}`;

/** What the catalog (or AniList, for ids it hasn't seen) says about these ids. */
async function infoFor(ids: number[], deps: ListDeps): Promise<Map<number, Info>> {
  const out = new Map<number, Info>();
  const row = db.prepare("SELECT title_english, title_romaji, title_native, kind, tvdb_id, tmdb_movie FROM entries WHERE anilist_id = ?");
  const missing: number[] = [];
  for (const id of ids) {
    const e = row.get(id) as
      | {
          title_english: string | null;
          title_romaji: string | null;
          title_native: string | null;
          kind: string | null;
          tvdb_id: number | null;
          tmdb_movie: number | null;
        }
      | undefined;
    if (e) out.set(id, { title: titleOf(e, id), kind: e.kind === "MOVIE" ? "movie" : "show", tvdbId: e.tvdb_id, tmdbMovie: e.tmdb_movie });
    else missing.push(id);
  }
  if (missing.length) {
    const f = await deps.fribb();
    const al = animeListEntries();
    const got: AniMedia[] = [];
    for (let i = 0; i < missing.length; i += 50)
      got.push(...(await deps.media(missing.slice(i, i + 50), deps.fetcher, { priority: true })));
    for (const m of got) {
      const map = al.get(f.anilistToAnidb.get(m.id) ?? -1);
      out.set(m.id, {
        title: m.title.english ?? m.title.romaji ?? m.title.native ?? `AniList ${m.id}`,
        kind: m.format === "MOVIE" ? "movie" : "show",
        tvdbId: map?.tvdbId ?? null,
        tmdbMovie: map?.tmdbMovie ?? f.anilistToTmdb?.get(m.id) ?? null,
      });
    }
  }
  return out;
}

/** Is it in the library already (the check Find & add makes: this entry, or another season of the same show)? */
function inLibrary(anilistId: number, i: Info): boolean {
  if (i.kind === "movie")
    return !!(
      (i.tmdbMovie && cache.prepare("SELECT 1 FROM movies WHERE tmdb_id = ?").get(i.tmdbMovie)) ||
      db.prepare("SELECT 1 FROM native_movies WHERE anilist_id = ?").get(anilistId)
    );
  if (cache.prepare("SELECT 1 FROM series WHERE tvdb_id = ?").get(NATIVE_BASE + anilistId)) return true;
  return !!i.tvdbId && (!!cache.prepare("SELECT 1 FROM series WHERE tvdb_id = ?").get(i.tvdbId) || isNativeTvdb(i.tvdbId));
}

const movieRootFor = (l: Pick<ListCfg, "movieRootFolder">) =>
  l.movieRootFolder || getSettings().allowedRoots.find((a) => /movies/i.test(a)) || "";

export interface Plan {
  total: number;
  matched: number;
  items: PlanItem[];
  add: PlanItem[];
  skipped: Record<string, number>;
}

/** Reads the account and decides, per entry, what a sync would do. Adds nothing. */
export async function planList(
  l: Pick<ListCfg, "source" | "username" | "statuses" | "movieRootFolder" | "rootFolder">,
  deps: ListDeps = realListDeps,
): Promise<Plan> {
  const raw = await fetchEntries(l, deps);
  const picked = raw.filter((r) => l.statuses.includes(r.status));
  const excluded = new Map(exclusions().map((x) => [x.anilistId, x.title]));
  const infos = await infoFor(
    picked.filter((r) => !excluded.has(r.id)).map((r) => r.id),
    deps,
  );
  const dropped = new Set(droppedList().map((d) => d.tvdbId));
  const items: PlanItem[] = [];
  const seen = new Set<number>(); // a show or movie already planned (another season of it adds nothing new)
  const moviesOk = !!movieRootFor(l);
  for (const r of picked) {
    const base = { anilistId: r.id, status: r.status };
    const skip = (title: string, kind: "show" | "movie", reason: string) => items.push({ ...base, title, kind, action: "skip", reason });
    if (excluded.has(r.id)) {
      skip(excluded.get(r.id) || `AniList ${r.id}`, "show", "excluded");
      continue;
    }
    const i = infos.get(r.id);
    if (!i) {
      skip(`AniList ${r.id}`, "show", "not on AniList");
      continue;
    }
    if (inLibrary(r.id, i)) skip(i.title, i.kind, "in library");
    else if (i.kind === "show" && i.tvdbId && dropped.has(i.tvdbId)) skip(i.title, i.kind, "dropped");
    else if (i.kind === "movie" && !moviesOk) skip(i.title, i.kind, "no movie folder");
    else if (i.kind === "show" && !l.rootFolder) skip(i.title, i.kind, "no show folder");
    else {
      const key = i.kind === "movie" ? -r.id : (i.tvdbId ?? NATIVE_BASE + r.id);
      if (seen.has(key)) skip(i.title, i.kind, "same show as another entry");
      else {
        seen.add(key);
        items.push({ ...base, title: i.title, kind: i.kind, action: "add" });
      }
    }
  }
  const skipped: Record<string, number> = {};
  for (const x of items) if (x.action === "skip") skipped[x.reason!] = (skipped[x.reason!] ?? 0) + 1;
  return { total: raw.length, matched: picked.length, items, add: items.filter((x) => x.action === "add"), skipped };
}

// ---------------------------------------------------------------- adding

/** Adds one planned item the way Add does; throws on failure. Returns the title. */
async function addItem(l: ListCfg, it: PlanItem, deps: ListDeps) {
  const sourceName = l.source === "mal" ? "MyAnimeList" : "AniList";
  const live = !getSettings().managed.dryRun; // practice mode: managed but not live, like Add
  if (it.kind === "movie") {
    const mv = await addMovie({ anilistId: it.anilistId, rootFolder: movieRootFor(l) }, { media: deps.media, fribb: deps.fribb });
    if (l.profileId) setMoviePrefs(mv.movieId, l.profileId, null);
    if (l.tags.length) setTags("movie", mv.movieId, l.tags);
    logDecision("info", { title: mv.title, why: `Added from ${sourceName} list "${l.name}": the movie ${mv.title}` });
    return mv.title;
  }
  const status = (db.prepare("SELECT status FROM entries WHERE anilist_id = ?").get(it.anilistId) as { status: string | null } | undefined)
    ?.status;
  const added = await addShow({ anilistId: it.anilistId, rootFolder: l.rootFolder }, { media: deps.media, fribb: deps.fribb });
  if (l.profileId) setSeriesPrefs(added.tvdbId, l.profileId, null, null);
  const s = getSettings().scope;
  setScope([added.tvdbId], l.scope ?? validateScope(status === "FINISHED" ? s.ended : s.continuing));
  setManaged([added.tvdbId], true, { live });
  if (l.tags.length) setTags("series", added.tvdbId, l.tags);
  if (l.then === "queue") addToQueue([added.tvdbId]);
  logDecision("info", {
    tvdbId: added.tvdbId,
    title: added.title,
    why: `Added from ${sourceName} list "${l.name}": ${added.title}${live ? "" : " (practice mode: nothing downloads yet)"}`,
  });
  return added.title;
}

const running = new Set<number>();

export interface SyncOutcome {
  list: ListCfg;
  preview: boolean;
  added: number;
  wouldAdd: number;
  errors: string[];
}

/**
 * One sync. An unconfirmed list only previews (and stores what it would add) unless `confirm` is set, which adds all
 * of it and marks the list confirmed. A confirmed list adds up to MAX_AUTO per run, the rest on the next one.
 */
export async function syncList(id: number, opts: { confirm?: boolean; deps?: ListDeps; quiet?: boolean } = {}): Promise<SyncOutcome> {
  const deps = opts.deps ?? realListDeps;
  const l = getList(id);
  if (running.has(id)) throw fail("This list is syncing already", 409);
  running.add(id);
  try {
    let plan: Plan;
    try {
      plan = await planList(l, deps);
    } catch (e) {
      db.prepare("UPDATE import_lists SET last_sync_at = ?, last_result = ? WHERE id = ?").run(
        Date.now(),
        JSON.stringify({ ...l.lastResult, error: (e as Error).message, at: Date.now() }),
        id,
      );
      throw e;
    }
    const base: ListResult = {
      at: Date.now(),
      total: plan.total,
      matched: plan.matched,
      skipped: plan.skipped,
      added: l.lastResult.added ?? [],
    };
    const would = plan.add.map((x) => ({ anilistId: x.anilistId, title: x.title, kind: x.kind }));
    if (!l.confirmed && !opts.confirm) {
      db.prepare("UPDATE import_lists SET last_sync_at = ?, last_result = ? WHERE id = ?").run(
        Date.now(),
        JSON.stringify({ ...base, pending: true, wouldAdd: would }),
        id,
      );
      if (!opts.quiet && would.length)
        logDecision("info", {
          why: `Import list "${l.name}": would add ${would.length} ${would.length === 1 ? "show" : "shows"}. Check the list in Settings → Import lists and confirm it before anything is added`,
        });
      return { list: getList(id), preview: true, added: 0, wouldAdd: would.length, errors: [] };
    }
    const todo = opts.confirm ? plan.add : plan.add.slice(0, MAX_AUTO);
    const errors: string[] = [];
    const added = [...(l.lastResult.added ?? [])];
    let n = 0;
    for (const it of todo) {
      try {
        const title = await addItem(l, it, deps);
        added.unshift({ anilistId: it.anilistId, title, at: Date.now() });
        n++;
      } catch (e) {
        if ((e as { statusCode?: number }).statusCode === 409) continue; // got added meanwhile
        errors.push(`${it.title}: ${(e as Error).message}`);
      }
    }
    const left = plan.add.length - todo.length;
    const result: ListResult = {
      ...base,
      added: added.slice(0, 30),
      errors: errors.slice(0, 10),
      wouldAdd: left > 0 ? would.slice(todo.length) : [],
    };
    db.prepare("UPDATE import_lists SET last_sync_at = ?, last_result = ?, confirmed = 1 WHERE id = ?").run(
      Date.now(),
      JSON.stringify(result),
      id,
    );
    if (n && !opts.quiet)
      logDecision("info", {
        why: `Import list "${l.name}": added ${n} ${n === 1 ? "show" : "shows"}${left > 0 ? `, ${left} more on the next sync` : ""}`,
      });
    return { list: getList(id), preview: false, added: n, wouldAdd: left, errors };
  } finally {
    running.delete(id);
  }
}

/** The background job: lists that are due (every `lists.intervalHours`); an unconfirmed list only gets its first preview. */
export async function importListsTick(now = Date.now(), deps: ListDeps = realListDeps) {
  const every = getSettings().lists.intervalHours * 3_600_000;
  for (const l of listLists()) {
    if (!l.enabled || running.has(l.id)) continue;
    if (!(l.lastSyncAt === null || (l.confirmed && now - l.lastSyncAt >= every))) continue;
    try {
      await syncList(l.id, { deps });
    } catch (e) {
      logDecision("fail", { why: `Import list "${l.name}" failed: ${(e as Error).message}` });
    }
  }
}
