/**
 * Settings → Indexers / Download clients: add, edit, test and remove the direct indexers and the added download
 * clients. Secrets are masked on the way out and kept when the browser sends the mask back (like /api/settings).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getSettings, isMasked, MASK, patchSettings, type ClientCfg, type IndexerCfg } from "./settings.js";
import { clientList, testClient } from "./arr/clients.js";
import { hostOf, indexerNumId, lastErrors, searchIndexer } from "./indexers.js";
import { db } from "./db.js";
import { redactUrl } from "./arr/http.js";
import { logDecision } from "./activity.js";

const bad = (msg: string) => Object.assign(new Error(msg), { statusCode: 400 });
const httpUrl = (v: unknown, what: string, allowTemplate = false) => {
  const s = String(v ?? "").trim().replace(/\/+$/, "");
  try {
    const u = new URL(allowTemplate ? s.replace("{q}", "x") : s);
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || /^(169\.254\.|0\.|\[?fe80:)/i.test(u.hostname) || u.hostname === "metadata.google.internal") throw new Error();
  } catch {
    throw bad(`${what}: enter an http(s) address`);
  }
  return s;
};
const int = (v: unknown, min: number, max: number, d: number) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.round(Number(v)))) : d);
const numOrNull = (v: unknown, min: number, max: number) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Math.min(max, Math.max(min, Number(v))));
const newId = (p: string) => `${p}-${crypto.randomBytes(4).toString("hex")}`;

// ---------------------------------------------------------------- catalogue

let catalogCache: { at: number; v: Catalog } | null = null;
interface CatalogEntry { id: string; name: string; kind: IndexerCfg["kind"]; protocol: "usenet" | "torrent"; url: string; apiPath: string; categories: number[]; needsKey: boolean; access: string; visibility: string; language: string; goodFor: string; recommended: boolean; addable?: boolean; viaProwlarr?: boolean; checked: { date: string; status: string; note: string } }
interface Catalog { version: number; updated: string; entries: CatalogEntry[] }

/** The curated catalogue (catalog/indexers.json next to the app; editable without a code change). */
export function indexerCatalog(): Catalog {
  if (catalogCache && Date.now() - catalogCache.at < 60_000) return catalogCache.v;
  const file = [path.join(process.cwd(), "catalog", "indexers.json"), path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..", "catalog", "indexers.json")].find((f) => fs.existsSync(f));
  const v = file ? (JSON.parse(fs.readFileSync(file, "utf8")) as Catalog) : { version: 0, updated: "", entries: [] };
  catalogCache = { at: Date.now(), v };
  return v;
}

// ---------------------------------------------------------------- indexers

const maskIx = (ix: IndexerCfg) => ({ ...ix, apiKey: ix.apiKey ? MASK : "" });

export function listIndexers() {
  const since = Date.now() - 3 * 86_400_000;
  return (getSettings().indexers ?? []).map((ix) => {
    const nid = indexerNumId(ix.id);
    const f = db.prepare("SELECT COUNT(*) AS n, (SELECT why FROM indexer_failures WHERE indexer_id = ? ORDER BY at DESC LIMIT 1) AS last FROM indexer_failures WHERE indexer_id = ? AND at > ?").get(nid, nid, since) as { n: number; last: string | null };
    const grabs = (db.prepare("SELECT COUNT(*) AS n FROM grabs WHERE indexer_id = ? AND client_ref IS NOT NULL AND dry_run = 0").get(nid) as { n: number }).n;
    const searchErr = lastErrors.get(ix.id);
    return { ...maskIx(ix), numId: nid, grabs, failures: f.n, lastError: f.n ? f.last : searchErr && Date.now() - searchErr.at < 86_400_000 ? searchErr.why : null };
  });
}

function cleanIndexer(input: Record<string, unknown>, cur: IndexerCfg | null): IndexerCfg {
  const kind = (["newznab", "torznab", "nyaa", "rss", "subsplease"] as const).find((k) => k === input.kind) ?? cur?.kind;
  if (!kind) throw bad("Pick the indexer type");
  const protocol = kind === "newznab" ? "usenet" : "torrent";
  const name = String(input.name ?? cur?.name ?? "").trim().slice(0, 60);
  if (!name) throw bad("Give the indexer a name");
  const key = input.apiKey === undefined || isMasked(input.apiKey) ? (cur?.apiKey ?? "") : String(input.apiKey).trim();
  const url = httpUrl(input.url ?? cur?.url, "URL", kind === "rss");
  if (kind === "rss" && !url.includes("{q}")) throw bad("An RSS search URL needs {q} where the search words go");
  return {
    id: cur?.id ?? newId("ix"),
    kind,
    protocol,
    name,
    url,
    apiPath: kind === "newznab" || kind === "torznab" ? String(input.apiPath ?? cur?.apiPath ?? "/api").trim() || "/api" : "",
    // A key saved for one address isn't sent to another.
    apiKey: cur && cur.url !== url && (input.apiKey === undefined || isMasked(input.apiKey)) ? "" : key,
    categories: Array.isArray(input.categories) ? [...new Set(input.categories.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 100_000))].slice(0, 20) : (cur?.categories ?? (kind === "newznab" || kind === "torznab" ? [5070, 5000, 2000] : [])),
    priority: int(input.priority, 1, 50, cur?.priority ?? 25),
    enabled: typeof input.enabled === "boolean" ? input.enabled : (cur?.enabled ?? true),
    seedRatio: protocol === "torrent" ? numOrNull(input.seedRatio !== undefined ? input.seedRatio : cur?.seedRatio, 0, 100) : null,
    seedTimeMin: protocol === "torrent" ? numOrNull(input.seedTimeMin !== undefined ? input.seedTimeMin : cur?.seedTimeMin, 0, 525_600) : null,
    tags: Array.isArray(input.tags) ? input.tags.map((t) => String(t).trim().slice(0, 30)).filter(Boolean).slice(0, 10) : (cur?.tags ?? []),
    catalogId: typeof input.catalogId === "string" ? input.catalogId.slice(0, 60) : (cur?.catalogId ?? null),
  };
}

export function saveIndexer(id: string | null, input: Record<string, unknown>) {
  const list = getSettings().indexers ?? [];
  const cur = id ? (list.find((x) => x.id === id) ?? null) : null;
  if (id && !cur) throw Object.assign(new Error("No such indexer"), { statusCode: 404 });
  const ix = cleanIndexer(input, cur);
  patchSettings((s) => ({ ...s, indexers: cur ? (s.indexers ?? []).map((x) => (x.id === ix.id ? ix : x)) : [...(s.indexers ?? []), ix] }));
  logDecision("info", { why: `${cur ? "Changed" : "Added"} the indexer ${ix.name} (${ix.kind}, ${ix.protocol})` });
  return maskIx(ix);
}

export function deleteIndexer(id: string) {
  const ix = (getSettings().indexers ?? []).find((x) => x.id === id);
  if (!ix) throw Object.assign(new Error("No such indexer"), { statusCode: 404 });
  patchSettings((s) => ({ ...s, indexers: (s.indexers ?? []).filter((x) => x.id !== id) }));
  logDecision("info", { why: `Removed the indexer ${ix.name}` });
}

/** A sample search with what's in the form (the saved key when the form sends the mask). */
export async function testIndexer(input: Record<string, unknown>) {
  const cur = typeof input.id === "string" ? ((getSettings().indexers ?? []).find((x) => x.id === input.id) ?? null) : null;
  const ix = cleanIndexer(input, cur);
  const q = String(input.query ?? "one piece").slice(0, 80);
  const t0 = Date.now();
  const rows = await searchIndexer(ix, q, { limit: 25 });
  return { query: q, found: rows.length, ms: Date.now() - t0, sample: rows.slice(0, 5).map((r) => ({ title: r.title, size: r.size, seeders: r.seeders ?? null })) };
}

/** Same site twice (direct twice, or direct + one of Prowlarr's indexers by name): suggest keeping one. */
export function indexerDuplicates(prowlarrNames: string[]) {
  const list = getSettings().indexers ?? [];
  const out: { id: string; name: string; with: string }[] = [];
  const norm = (s: string) => s.toLowerCase().replace(/\(.*?\)|[^a-z0-9]/g, "");
  for (const ix of list) {
    const twin = list.find((o) => o.id !== ix.id && o.protocol === ix.protocol && hostOf(o.url) === hostOf(ix.url));
    if (twin) out.push({ id: ix.id, name: ix.name, with: twin.name });
    const viaP = prowlarrNames.find((n) => norm(n) && (norm(n).includes(norm(ix.name)) || norm(ix.name).includes(norm(n))));
    if (viaP) out.push({ id: ix.id, name: ix.name, with: `${viaP} (via Prowlarr)` });
  }
  return out;
}

// ---------------------------------------------------------------- download clients

const maskClient = (c: ClientCfg) => ({ ...c, password: c.password ? MASK : "" });

export function listClients() {
  return clientList().map((c) => ({ id: c.id, type: c.type, name: c.name, protocol: c.protocol, priority: c.priority, enabled: c.enabled, configured: c.configured, category: c.category, cfg: c.cfg ? maskClient(c.cfg) : null }));
}

function cleanClient(input: Record<string, unknown>, cur: ClientCfg | null): ClientCfg {
  const type = (["nzbget", "transmission"] as const).find((k) => k === input.type) ?? cur?.type;
  if (!type) throw bad("Pick the client type");
  const url = httpUrl(input.url ?? cur?.url, "URL");
  const pw = input.password === undefined || isMasked(input.password) ? (cur && cur.url !== url ? "" : (cur?.password ?? "")) : String(input.password);
  const maps = Array.isArray(input.pathMappings) ? input.pathMappings : (cur?.pathMappings ?? []);
  return {
    id: cur?.id ?? newId(type),
    type,
    name: String(input.name ?? cur?.name ?? (type === "nzbget" ? "NZBGet" : "Transmission")).trim().slice(0, 60) || type,
    url,
    username: String(input.username ?? cur?.username ?? "").trim().slice(0, 100),
    password: pw,
    category: String(input.category ?? cur?.category ?? "animearr").trim().replace(/[\\/]/g, "").slice(0, 60) || "animearr",
    priority: int(input.priority, 1, 50, cur?.priority ?? 1),
    enabled: typeof input.enabled === "boolean" ? input.enabled : (cur?.enabled ?? true),
    removeCompleted: typeof input.removeCompleted === "boolean" ? input.removeCompleted : (cur?.removeCompleted ?? true),
    pathMappings: (maps as unknown[])
      .filter((x) => x && typeof x === "object")
      .map((x) => ({ from: String((x as { from?: unknown }).from ?? "").trim(), to: String((x as { to?: unknown }).to ?? "").trim() }))
      .filter((x) => x.from && x.to)
      .slice(0, 10),
  };
}

export function saveClient(id: string | null, input: Record<string, unknown>) {
  const list = getSettings().extraClients ?? [];
  const cur = id ? (list.find((x) => x.id === id) ?? null) : null;
  if (id && !cur) throw Object.assign(new Error("No such download client"), { statusCode: 404 });
  const c = cleanClient(input, cur);
  patchSettings((s) => ({ ...s, extraClients: cur ? (s.extraClients ?? []).map((x) => (x.id === c.id ? c : x)) : [...(s.extraClients ?? []), c] }));
  logDecision("info", { why: `${cur ? "Changed" : "Added"} the download client ${c.name} (${c.type})` });
  return maskClient(c);
}

export function deleteClient(id: string) {
  const c = (getSettings().extraClients ?? []).find((x) => x.id === id);
  if (!c) throw Object.assign(new Error("No such download client"), { statusCode: 404 });
  const busy = (db.prepare("SELECT COUNT(*) AS n FROM grabs WHERE client = ? AND state IN ('sending', 'downloading', 'importing', 'needs-attention')").get(id) as { n: number }).n;
  if (busy) throw Object.assign(new Error(`${c.name} still has ${busy} download${busy === 1 ? "" : "s"} in AnimeArr's queue; let them finish or remove them first`), { statusCode: 409 });
  patchSettings((s) => ({ ...s, extraClients: (s.extraClients ?? []).filter((x) => x.id !== id) }));
  logDecision("info", { why: `Removed the download client ${c.name}` });
}

/** Priority / enabled for the SABnzbd and qBittorrent slots. */
export function setClientPrefs(id: string, input: Record<string, unknown>) {
  if (id !== "sabnzbd" && id !== "qbittorrent") throw Object.assign(new Error("No such download client"), { statusCode: 404 });
  const cur = getSettings().clientPrefs?.[id] ?? { priority: 1, enabled: true };
  const next = { priority: int(input.priority, 1, 50, cur.priority), enabled: typeof input.enabled === "boolean" ? input.enabled : cur.enabled };
  patchSettings((s) => ({ ...s, clientPrefs: { ...(s.clientPrefs ?? {}), [id]: next } }));
  return next;
}

export async function testExtraClient(input: Record<string, unknown>) {
  const cur = typeof input.id === "string" ? ((getSettings().extraClients ?? []).find((x) => x.id === input.id) ?? null) : null;
  return testClient(cleanClient(input, cur));
}

// ---------------------------------------------------------------- Jackett (its trackers become Torznab indexers)

/** Jackett's configured trackers, each with the Torznab feed AnimeArr can add in one click. */
export async function jackettTrackers(input: Record<string, unknown>) {
  const url = httpUrl(input.url, "Jackett URL");
  const key = String(input.apiKey ?? "").trim();
  if (!key) throw bad("Enter Jackett's API key (top right of its dashboard)");
  let res: Response;
  try {
    res = await fetch(`${url}/api/v2.0/indexers?configured=true&apikey=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw bad(`Jackett unreachable (${redactUrl((e as Error).message)})`);
  }
  if (res.status === 401 || res.status === 403) throw bad("Jackett refused the API key");
  if (!res.ok) throw bad(`Jackett answered HTTP ${res.status}`);
  const list = (await res.json()) as { id: string; name: string; type?: string; configured?: boolean; language?: string }[];
  const have = new Set((getSettings().indexers ?? []).map((x) => x.url));
  return list
    .filter((x) => x.configured !== false)
    .map((x) => {
      const feed = `${url}/api/v2.0/indexers/${encodeURIComponent(x.id)}/results/torznab`;
      return { id: x.id, name: x.name, type: x.type ?? "public", language: x.language ?? "", feed, added: have.has(feed) };
    });
}

/** Adds one Jackett tracker as a Torznab indexer (the key stays server-side). */
export function addJackettTracker(input: Record<string, unknown>) {
  return saveIndexer(null, { kind: "torznab", name: `${String(input.name ?? "Tracker")} (Jackett)`, url: input.feed, apiPath: "/api", apiKey: input.apiKey, categories: [5070, 5000, 2000], tags: ["jackett"] });
}
