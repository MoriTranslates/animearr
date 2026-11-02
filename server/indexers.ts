/**
 * Indexers AnimeArr searches itself (without Prowlarr): Newznab (Usenet), Torznab (torrents), and small adapters for
 * anime sites that only offer RSS or a JSON search (Nyaa, SubsPlease, generic RSS search feeds). Results come back in
 * the same shape as Prowlarr's, so search, ranking, health and grabbing don't care where a release came from.
 * Mixing with Prowlarr is fine; Prowlarr stays optional.
 */
import { ensureProwlarrSelection } from "./indexerPick.js";
import { describeFetchError, noteSeen, recordIndexerFailure, recordIndexerSuccess } from "./health.js";
import crypto from "node:crypto";
import { getSettings, type IndexerCfg } from "./system/settings.js";
import { prowlarrConfigured, prowlarrIndexers, prowlarrSearch, type ProwlarrRelease } from "./arr/prowlarr.js";
import { redactUrl } from "./arr/http.js";
import { cachedQuery, querySlot } from "./searchQueue.js";

/** A stable numeric id per direct indexer (health is tracked per numeric indexer id); far above Prowlarr's ids. */
export function indexerNumId(id: string) {
  return 1_000_000 + (crypto.createHash("sha1").update(id).digest().readUInt32BE(0) % 1_000_000);
}

const UA = "AnimeArr (+https://github.com/MoriTranslates/animearr)";
const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&")
    .trim();
const tag = (item: string, name: string) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(item);
  return m ? decode(m[1]) : null;
};
const attr = (item: string, name: string) => {
  const m =
    new RegExp(`<(?:newznab|torznab):attr[^>]*name="${name}"[^>]*value="([^"]*)"`, "i").exec(item) ??
    new RegExp(`<(?:newznab|torznab):attr[^>]*value="([^"]*)"[^>]*name="${name}"`, "i").exec(item);
  return m ? decode(m[1]) : null;
};
const enclosure = (item: string) => {
  const tagM = /<enclosure\b[^>]*>/i.exec(item);
  if (!tagM) return null;
  const url = /\burl="([^"]+)"/i.exec(tagM[0])?.[1];
  const length = /\blength="(\d+)"/i.exec(tagM[0])?.[1];
  return url ? { url: decode(url), length: length ? Number(length) || null : null } : null;
};
const items = (xml: string) => [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((m) => m[0]);
const ageMin = (pub: string | null) => {
  const t = pub ? Date.parse(pub) : NaN;
  return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 60_000)) : undefined;
};
/** "6.6 GiB", "350 MB", "1.2 GB" → bytes. */
export function parseSize(s: string | null | undefined): number {
  const m = /([\d.,]+)\s*([KMGT]i?B|B)/i.exec(s ?? "");
  if (!m) return 0;
  const n = Number(m[1].replace(",", "."));
  const u = m[2].toUpperCase();
  const pow = u.startsWith("K") ? 1 : u.startsWith("M") ? 2 : u.startsWith("G") ? 3 : u.startsWith("T") ? 4 : 0;
  return Math.round(n * (u.includes("I") ? 1024 : 1000) ** pow);
}
const num = (v: string | null | undefined) =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v);
const magnetIn = (s: string | null) => /magnet:\?xt=urn:btih:[^"'<\s]+/i.exec(s ?? "")?.[0]?.replace(/&amp;/g, "&") ?? null;

async function fetchText(url: string, timeout = 30_000) {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, application/json, text/xml" },
      signal: AbortSignal.timeout(timeout),
      redirect: "manual",
    });
    // One redirect, same scheme rules (sites moving to https or a new domain), never to link-local addresses.
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (loc) {
      const next = new URL(loc, url);
      if (!/^https?:$/.test(next.protocol) || /^(169\.254\.|0\.|\[?fe80:)/i.test(next.hostname))
        throw new Error("redirected somewhere not allowed");
      res = await fetch(next.href, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(timeout), redirect: "manual" });
    }
  } catch (e) {
    if ((e as Error).name === "TimeoutError") throw new Error(`timed out after ${Math.round(timeout / 1000)} s`);
    throw new Error(`unreachable (${redactUrl((e as Error).message)})`);
  }
  if (res.status === 401 || res.status === 403) throw new Error(`refused (HTTP ${res.status}: check the API key)`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** A guid that never carries credentials: a URL as guid (often the download link with a key) becomes a hash. */
const safeGuid = (g: string | null | undefined, title: string) => {
  const v = g ?? title;
  return /^https?:\/\//i.test(v) && /[?&][\w-]*(?:key|pass|auth|token)[\w-]*=|\/[0-9a-f]{20,}\//i.test(v)
    ? `aa:${crypto.createHash("sha1").update(v).digest("hex")}`
    : v;
};

const base = (ix: IndexerCfg, r: Partial<ProwlarrRelease> & { title: string }): ProwlarrRelease => ({
  guid: safeGuid(r.guid ?? r.downloadUrl ?? r.magnetUrl, r.title),
  size: 0,
  indexerId: indexerNumId(ix.id),
  indexer: ix.name,
  protocol: ix.protocol,
  ...r,
  ...(r.guid !== undefined ? { guid: safeGuid(r.guid, r.title) } : {}),
});

/** One search on one direct indexer. Empty query = its latest releases (RSS-style). */
export async function searchIndexer(
  ix: IndexerCfg,
  query: string,
  opts: { categories?: number[]; limit?: number; timeoutMs?: number } = {},
): Promise<ProwlarrRelease[]> {
  const q = query.trim();
  const get = (url: string) => fetchText(url, opts.timeoutMs || 30_000);
  if (ix.kind === "newznab" || ix.kind === "torznab") {
    const u = new URL(`${ix.url.replace(/\/+$/, "")}${ix.apiPath || "/api"}`);
    u.searchParams.set("t", "search");
    if (q) u.searchParams.set("q", q);
    const cats = opts.categories ?? ix.categories;
    if (cats.length) u.searchParams.set("cat", cats.join(","));
    u.searchParams.set("limit", String(opts.limit ?? 100));
    u.searchParams.set("extended", "1");
    if (ix.apiKey) u.searchParams.set("apikey", ix.apiKey);
    const xml = await get(u.toString());
    const err = /<error[^>]*description="([^"]*)"/i.exec(xml)?.[1];
    if (err) throw new Error(err);
    return items(xml).map((it) => {
      const enc = enclosure(it);
      const title = tag(it, "title") ?? "";
      const magnet = attr(it, "magneturl") ?? magnetIn(enc?.url ?? null);
      const link = enc?.url ?? tag(it, "link");
      const seeders = attr(it, "seeders");
      const peers = attr(it, "peers");
      return base(ix, {
        title,
        guid: tag(it, "guid") ?? link ?? title,
        size: Number(attr(it, "size") ?? enc?.length ?? 0) || parseSize(tag(it, "size")),
        downloadUrl: link && !link.startsWith("magnet:") ? link : undefined,
        magnetUrl: magnet ?? (link?.startsWith("magnet:") ? link : undefined),
        infoUrl: tag(it, "comments") ?? undefined,
        publishDate: tag(it, "pubDate") ?? undefined,
        ageMinutes: ageMin(tag(it, "pubDate")),
        seeders: num(seeders),
        leechers: num(peers) !== undefined && num(seeders) !== undefined ? Math.max(0, num(peers)! - num(seeders)!) : undefined,
        grabs: num(attr(it, "grabs")),
      });
    });
  }
  if (ix.kind === "nyaa") {
    // Nyaa: RSS search (c=1_0 = anime, f=0 = no filter); seeders, size and the info-hash are in its namespace.
    const u = new URL(ix.url.replace(/\/+$/, "") + "/");
    u.searchParams.set("page", "rss");
    if (q) u.searchParams.set("q", q);
    u.searchParams.set("c", "1_0");
    u.searchParams.set("f", "0");
    const xml = await get(u.toString());
    return items(xml).map((it) => {
      const hash = tag(it, "nyaa:infoHash");
      const title = tag(it, "title") ?? "";
      return base(ix, {
        title,
        guid: tag(it, "guid") ?? title,
        size: parseSize(tag(it, "nyaa:size")),
        downloadUrl: tag(it, "link") ?? undefined,
        // The .torrent carries the trackers; a hash-only magnet only when there's no link.
        magnetUrl:
          !tag(it, "link") && hash
            ? `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}&tr=${encodeURIComponent("http://nyaa.tracker.wf:7777/announce")}`
            : undefined,
        infoUrl: tag(it, "guid") ?? undefined,
        publishDate: tag(it, "pubDate") ?? undefined,
        ageMinutes: ageMin(tag(it, "pubDate")),
        seeders: num(tag(it, "nyaa:seeders")),
        leechers: num(tag(it, "nyaa:leechers")),
        grabs: num(tag(it, "nyaa:downloads")),
      });
    });
  }
  if (ix.kind === "subsplease") {
    // SubsPlease: its own JSON search; one release per resolution (magnet links). No sizes or seeders.
    const u = new URL(`${ix.url.replace(/\/+$/, "")}/api/`);
    u.searchParams.set("f", q ? "search" : "latest");
    u.searchParams.set("tz", "UTC");
    if (q) u.searchParams.set("s", q);
    const j = JSON.parse(await get(u.toString())) as
      Record<string, { show: string; episode: string; release_date?: string; downloads: { res: string; magnet: string }[] }> | unknown[];
    if (Array.isArray(j)) return [];
    return Object.values(j).flatMap((e) =>
      (e.downloads ?? []).map((d) =>
        base(ix, {
          title: `[SubsPlease] ${e.show} - ${e.episode} (${d.res}p)`,
          guid: d.magnet,
          magnetUrl: d.magnet,
          publishDate: e.release_date,
          ageMinutes: ageMin(e.release_date ?? null),
          seeders: undefined,
        }),
      ),
    );
  }
  // Generic RSS search feed: the URL has {q} where the search words go.
  const url = ix.url.replace("{q}", encodeURIComponent(q));
  const xml = await get(url);
  return items(xml).map((it) => {
    const enc = enclosure(it);
    const title = tag(it, "title") ?? "";
    const desc = tag(it, "description");
    const link = enc?.url ?? tag(it, "link");
    const magnet = magnetIn(desc) ?? (link?.startsWith("magnet:") ? link : null);
    return base(ix, {
      title,
      guid: tag(it, "guid") ?? link ?? title,
      size: enc?.length || parseSize(/(?:size|大小)\s*[:：]\s*([\d.,]+\s*[KMGT]i?B)/i.exec(desc ?? "")?.[1]),
      downloadUrl: link && !link.startsWith("magnet:") ? link : undefined,
      magnetUrl: magnet ?? undefined,
      publishDate: tag(it, "pubDate") ?? undefined,
      ageMinutes: ageMin(tag(it, "pubDate")),
    });
  });
}

/** Enabled direct indexers. */
export const directIndexers = () => (getSettings().indexers ?? []).filter((x) => x.enabled && x.url);

/** Something to search with: Prowlarr, or at least one direct indexer. */
export const searchConfigured = () => prowlarrConfigured() || directIndexers().length > 0;

/** The time limit for one indexer's answer to one query (Settings → search.indexerTimeoutSec; 0 = none). */
export const indexerTimeoutMs = () => Math.max(0, getSettings().search?.indexerTimeoutSec ?? 20) * 1000;

/** Prowlarr's enabled indexers, kept a few minutes (a per-indexer search asks for the list once per query). */
let ixList: { at: number; key: string; rows: Promise<{ id: number; name: string; enable: boolean }[]> } | null = null;
function prowlarrIndexerList() {
  const key = `${getSettings().prowlarr.url}`;
  if (!ixList || ixList.key !== key || Date.now() - ixList.at > 5 * 60_000) {
    const rows = prowlarrIndexers();
    ixList = { at: Date.now(), key, rows };
    rows.catch(() => (ixList = null));
  }
  return ixList.rows;
}

/**
 * Prowlarr's search once per used indexer (the selection in Settings, else every enabled one); one that fails is skipped.
 * Each answer has its own time limit: Prowlarr's combined search waits for its slowest indexer, so asking each one on its
 * own lets a slow one be left out after the limit instead of holding up the query. A failure (time-out included) counts
 * against that indexer's search health, but only when another indexer answered (Prowlarr itself down blames nobody).
 */
async function prowlarrPerIndexer(query: string, opts: { limit?: number; categories?: number[]; fresh?: boolean; timeoutMs?: number }) {
  const chosen = getSettings().prowlarr.indexerIds;
  let list: { id: number; name: string }[];
  try {
    list = (await prowlarrIndexerList()).filter((x) => x.enable && (!chosen.length || chosen.includes(x.id)));
  } catch {
    return prowlarrSearch(query, opts); // no indexer list: one combined search still works
  }
  const settled = await Promise.allSettled(list.map((x) => prowlarrSearch(query, { ...opts, indexerIds: [x.id] })));
  const ok = settled.filter((r): r is PromiseFulfilledResult<ProwlarrRelease[]> => r.status === "fulfilled");
  if (list.length && !ok.length) throw (settled[0] as PromiseRejectedResult).reason;
  if (query.trim())
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") recordIndexerSuccess(list[i].id, "search");
      else recordIndexerFailure(list[i].id, redactUrl((r.reason as Error).message), Date.now(), { name: list[i].name, kind: "search" });
    });
  return ok.flatMap((r) => r.value);
}

/**
 * Prowlarr's indexers and the direct ones, in parallel. A failing indexer doesn't fail the search (its error is
 * reported); only when every source fails does the search throw. With `perIndexer`, `limit` holds for each Prowlarr
 * indexer on its own (one request each), so a busy indexer can't push the others' newest releases out of the list.
 * Searches with words are also asked per Prowlarr indexer while there is a time limit (search.indexerTimeoutSec).
 *
 * Every call takes one slot of the app-wide query scheduler (server/searchQueue.ts), and identical searches within
 * 10 minutes reuse the answers per indexer (`fresh` asks again); the empty recent-releases poll is never cached.
 */
export async function searchAll(
  query: string,
  opts: {
    limit?: number;
    categories?: number[];
    fresh?: boolean;
    perIndexer?: boolean;
    /** Checked when the slot comes: true = not needed any more (answers nothing). */ skip?: () => boolean;
  } = {},
): Promise<ProwlarrRelease[]> {
  return querySlot(() => (opts.skip?.() ? Promise.resolve([]) : searchAllNow(query, opts)));
}

async function searchAllNow(
  query: string,
  opts: { limit?: number; categories?: number[]; fresh?: boolean; perIndexer?: boolean },
): Promise<ProwlarrRelease[]> {
  const jobs: Promise<ProwlarrRelease[]>[] = [];
  const timeoutMs = indexerTimeoutMs();
  if (prowlarrConfigured()) {
    await ensureProwlarrSelection();
    const o = { ...opts, ...(timeoutMs ? { timeoutMs } : {}) };
    jobs.push(opts.perIndexer || (timeoutMs && query.trim()) ? prowlarrPerIndexer(query, o) : prowlarrSearch(query, o));
  }
  for (const ix of directIndexers()) {
    // A search-URL template needs words; the empty "latest releases" poll skips it.
    if (ix.kind === "rss" && !query.trim()) continue;
    const o = {
      limit: opts.limit,
      categories: opts.categories && opts.categories.length ? opts.categories : undefined,
      ...(timeoutMs ? { timeoutMs } : {}),
    };
    const run = () => searchIndexer(ix, query, o);
    jobs.push(
      (query.trim()
        ? cachedQuery(`direct:${ix.id}:${ix.url}:${query.trim()}:${(o.categories ?? ix.categories).join(",")}:${o.limit ?? ""}`, run, {
            fresh: opts.fresh,
          })
        : run()
      ).then(
        (rows) => (lastErrors.delete(ix.id), recordIndexerSuccess(indexerNumId(ix.id), "search"), rows),
        (e) => {
          const why = redactUrl(describeFetchError(e));
          lastErrors.set(ix.id, { at: Date.now(), why: `${ix.name}: ${why}` });
          recordIndexerFailure(indexerNumId(ix.id), why, Date.now(), { name: ix.name, kind: "search" });
          return Promise.reject(new Error(`${ix.name}: ${why}`));
        },
      ),
    );
  }
  if (!jobs.length) throw new Error("No indexer is set up (Settings → Indexers)");
  const settled = await Promise.allSettled(jobs);
  const ok = settled.filter((r): r is PromiseFulfilledResult<ProwlarrRelease[]> => r.status === "fulfilled");
  if (!ok.length) throw (settled[0] as PromiseRejectedResult).reason;
  const all = ok.flatMap((r) => r.value);
  for (const r of all)
    noteSeen(r.indexerId, {
      guid: r.guid,
      title: r.title,
      protocol: r.protocol,
      downloadUrl: r.downloadUrl,
      magnetUrl: r.magnetUrl,
      size: r.size,
    });
  return all;
}

/** The last search error per direct indexer id (shown on its card; cleared by the next good search). */
export const lastErrors = new Map<string, { at: number; why: string }>();

/** Seed limits of the indexer a release came from (private trackers). */
export function seedLimitsFor(indexerId: number | null | undefined) {
  const ix = (getSettings().indexers ?? []).find((x) => indexerNumId(x.id) === indexerId);
  return ix ? { seedRatio: ix.seedRatio, seedTimeMin: ix.seedTimeMin } : {};
}

/** Two indexers that point at the same site (by host), e.g. one via Prowlarr and one direct. */
export function hostOf(url: string) {
  try {
    return new URL(url.replace("{q}", "x")).hostname.replace(/^(www|api|feed)\./, "");
  } catch {
    return "";
  }
}
