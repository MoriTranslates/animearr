import { getSettings, type ClientCfg, type Settings } from "../settings.js";
import { nzbgetDriver, transmissionDriver } from "./moreClients.js";
import { delugeDriver, rtorrentDriver } from "./torrentClients.js";
import { blackholeDriver, isBlackhole } from "./blackhole.js";
import { mappedPath } from "../paths.js";

/**
 * Download clients. AnimeArr sends its grabs with its own category ("animearr" by default), so Sonarr's own
 * completed-download handling ignores them and AnimeArr imports them explicitly.
 */

export interface ClientJob {
  /** SABnzbd nzo_id, NZBGet NZBID, or a torrent's info-hash. */
  ref: string;
  /** "sabnzbd" / "qbittorrent" (the primary slots) or an added client's id. */
  client: string;
  /** Added stopped (paused) for file selection: must be started once the unwanted files are skipped. */
  paused?: boolean;
  /** Freshly added for file selection (never set for a torrent the client already had: its files are left alone). */
  select?: boolean;
}

/** One file of a torrent, as its client lists it (index = the client's file index). */
export interface ClientFile { index: number; name: string; size: number }
export interface AddTorrentOpts { seedRatio?: number | null; seedTimeMin?: number | null; /** Add it stopped (only clients that can select files honour this). */ paused?: boolean }

type ExtraType = ClientCfg["type"];
export type ClientType = "sabnzbd" | "qbittorrent" | ExtraType;
export interface ResolvedClient { id: string; type: ClientType; name: string; protocol: "usenet" | "torrent"; priority: number; enabled: boolean; configured: boolean; category: string; cfg: ClientCfg | null }
export const PROTOCOL: Record<ClientType, "usenet" | "torrent"> = { sabnzbd: "usenet", nzbget: "usenet", qbittorrent: "torrent", transmission: "torrent", deluge: "torrent", rtorrent: "torrent", "blackhole-usenet": "usenet", "blackhole-torrent": "torrent" };
/** A client is set up: an address, or a blackhole's two folders. */
export const clientConfigured = (c: ClientCfg) => (isBlackhole(c.type) ? !!(c.watchFolder && c.completedFolder) : !!c.url);

/** Every download client: the SABnzbd/qBittorrent slots and the added ones, with priority and enabled. */
export function clientList(s: Settings = getSettings()): ResolvedClient[] {
  const pref = (id: string) => s.clientPrefs?.[id] ?? { priority: 1, enabled: true };
  return [
    { id: "sabnzbd", type: "sabnzbd" as const, name: "SABnzbd", protocol: "usenet" as const, ...pref("sabnzbd"), configured: !!(s.sabnzbd.url && s.sabnzbd.apiKey), category: s.sabnzbd.category, cfg: null },
    { id: "qbittorrent", type: "qbittorrent" as const, name: "qBittorrent", protocol: "torrent" as const, ...pref("qbittorrent"), configured: !!s.qbittorrent.url, category: s.qbittorrent.category, cfg: null },
    ...(s.extraClients ?? []).map((c) => ({ id: c.id, type: c.type, name: c.name, protocol: PROTOCOL[c.type], priority: c.priority, enabled: c.enabled, configured: clientConfigured(c), category: c.category, cfg: c })),
  ];
}

/**
 * The clients a grab of this protocol goes to, best first (priority, then the order they were added). A blackhole is
 * never picked while a real client of the protocol is enabled, unless it is the preferred one (a better priority than
 * every real client).
 */
export function clientsFor(protocol: "usenet" | "torrent", s: Settings = getSettings()) {
  const list = clientList(s)
    .filter((c) => c.protocol === protocol && c.enabled && c.configured)
    .sort((a, b) => a.priority - b.priority);
  const real = list.filter((c) => !isBlackhole(c.type));
  if (!real.length) return list;
  const best = Math.min(...real.map((c) => c.priority));
  return list.filter((c) => !isBlackhole(c.type) || c.priority < best);
}
const byId = (id: string) => clientList().find((c) => c.id === id) ?? null;
/** A torrent client's job (seeding: imports copy/hardlink instead of moving; archives may need unpacking). */
export const isTorrentClient = (id: string | null | undefined) => !!id && (byId(id)?.protocol ?? (id === "qbittorrent" ? "torrent" : "usenet")) === "torrent";
/** The client's display name ("NZBGet", "Transmission", …). */
export const clientName = (id: string | null | undefined) => (id ? (byId(id)?.name ?? id) : "");
export interface ClientStatus {
  /** queued = waiting, paused or post-processing in the client (not stalling); error = the client needs a look. */
  state: "queued" | "downloading" | "completed" | "failed" | "missing" | "error";
  progress: number;
  /** Folder or file path as the client sees it, once completed. */
  path?: string;
  message?: string;
  /** Live details for the Queue page (when the client reports them). */
  etaSec?: number | null;
  speed?: number | null;
  sizeBytes?: number | null;
  clientStatus?: string;
  seeders?: number | null;
}

/** Narrow interface so the pipeline can be tested with a mock. */
export interface DownloadClients {
  addNzb(data: Buffer, name: string): Promise<ClientJob>;
  addTorrent(src: { data?: Buffer; magnet?: string }, name: string, opts?: AddTorrentOpts): Promise<ClientJob>;
  status(job: ClientJob): Promise<ClientStatus>;
  /** Removes the job from the client and deletes its downloaded data (never library files). */
  remove(job: ClientJob): Promise<void>;
  /**
   * Optional capability: partial downloads (skip some files of a torrent). Clients without it download whole batches;
   * the import then takes only the wanted files. canSelectFiles says whether the client holding the job has it.
   */
  canSelectFiles?(job: ClientJob): boolean;
  /** The torrent's files; null while it has no metadata yet (a magnet). */
  listFiles?(job: ClientJob): Promise<ClientFile[] | null>;
  /** Wanted files download, skipped ones don't (priority 0 / unwanted). */
  selectFiles?(job: ClientJob, wanted: number[], skipped: number[]): Promise<void>;
  /** Starts a job that was added stopped. */
  start?(job: ClientJob): Promise<void>;
}

// ---------------------------------------------------------------- SABnzbd

async function sab<T>(params: Record<string, string>, conn = getSettings().sabnzbd, form?: FormData): Promise<T> {
  if (!conn.url || !conn.apiKey) throw new Error("SABnzbd is not configured");
  const qs = new URLSearchParams({ ...params, output: "json", apikey: conn.apiKey });
  let res: Response;
  try {
    res = await fetch(`${conn.url}/api?${qs}`, { method: form ? "POST" : "GET", body: form, signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    throw new Error(`SABnzbd unreachable (${(e as Error).message})`);
  }
  if (!res.ok) throw new Error(`SABnzbd ${params.mode} failed (HTTP ${res.status})`);
  const j = (await res.json()) as T & { status?: boolean; error?: string };
  if (j && typeof j === "object" && j.status === false) throw new Error(`SABnzbd: ${j.error ?? "error"}`);
  return j;
}

export async function testSab(conn: { url: string; apiKey: string; category: string }) {
  const v = await sab<{ version: string }>({ mode: "version" }, { ...conn });
  const cats = await sab<{ categories: string[] }>({ mode: "get_cats" }, { ...conn });
  return { version: v.version, categoryExists: cats.categories.includes(conn.category), categories: cats.categories };
}

// ---------------------------------------------------------------- qBittorrent

let qbitCookie: { url: string; sid: string } | null = null;

async function qbit(path: string, init: RequestInit = {}, conn = getSettings().qbittorrent): Promise<Response> {
  if (!conn.url) throw new Error("qBittorrent is not configured");
  const doFetch = () =>
    fetch(`${conn.url}/api/v2${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Referer: conn.url, ...(qbitCookie?.url === conn.url ? { Cookie: `SID=${qbitCookie.sid}` } : {}) },
      signal: AbortSignal.timeout(60_000),
    });
  let res = await doFetch();
  if (res.status === 403 && conn.username) {
    const login = await fetch(`${conn.url}/api/v2/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: conn.url },
      body: new URLSearchParams({ username: conn.username, password: conn.password }),
      signal: AbortSignal.timeout(30_000),
    });
    const sid = /SID=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1];
    if (!login.ok || !sid) throw new Error("qBittorrent login failed (check username/password)");
    qbitCookie = { url: conn.url, sid };
    res = await doFetch();
  }
  if (!res.ok) throw new Error(`qBittorrent ${path} failed (HTTP ${res.status})`);
  return res;
}

export async function testQbit(conn: { url: string; username: string; password: string; category: string }) {
  const version = await (await qbit("/app/version", {}, { ...conn })).text();
  const cats = (await (await qbit("/torrents/categories", {}, { ...conn })).json()) as Record<string, unknown>;
  return { version, categoryExists: conn.category in cats, categories: Object.keys(cats) };
}

function infoHash(src: { data?: Buffer; magnet?: string }): string | null {
  const m = src.magnet?.match(/xt=urn:btih:([a-z0-9]{32,40})/i);
  if (m) return m[1].toLowerCase();
  return null; // computed by qBittorrent; we look it up by name/tag afterwards
}

// ---------------------------------------------------------------- real implementation

const primary = {
  async addNzb(data: Buffer, name: string): Promise<ClientJob> {
    const form = new FormData();
    form.append("name", new Blob([new Uint8Array(data)], { type: "application/x-nzb" }), `${name.replace(/[\\/:*?"<>|]/g, "_")}.nzb`);
    const s = getSettings().sabnzbd;
    const r = await sab<{ nzo_ids: string[] }>({ mode: "addfile", cat: s.category, nzbname: name }, s, form);
    if (!r.nzo_ids?.[0]) throw new Error("SABnzbd did not accept the NZB");
    return { client: "sabnzbd", ref: r.nzo_ids[0] };
  },
  async addTorrent(src: { data?: Buffer; magnet?: string }, name: string, opts: AddTorrentOpts = {}): Promise<ClientJob> {
    const s = getSettings().qbittorrent;
    const tag = `animearr-${Date.now().toString(36)}`;
    const form = new FormData();
    form.append("category", s.category);
    // The category's own save path, explicitly: with Automatic Torrent Management off, qBittorrent ignores it and
    // saves into its default folder (outside AnimeArr's category folder).
    try {
      const cats = (await (await qbit("/torrents/categories")).json()) as Record<string, { savePath?: string; save_path?: string }>;
      const savePath = cats[s.category]?.savePath ?? cats[s.category]?.save_path ?? "";
      if (savePath) {
        form.append("savepath", savePath);
        form.append("autoTMM", "false");
      } else form.append("autoTMM", "true");
    } catch {
      form.append("autoTMM", "true");
    }
    form.append("tags", tag);
    form.append("rename", name);
    if (src.magnet) form.append("urls", src.magnet);
    else if (src.data) form.append("torrents", new Blob([new Uint8Array(src.data)], { type: "application/x-bittorrent" }), `${name.replace(/[\\/:*?"<>|]/g, "_")}.torrent`);
    else throw new Error("Nothing to send to qBittorrent");
    if (opts.seedRatio != null) form.append("ratioLimit", String(opts.seedRatio));
    if (opts.seedTimeMin != null) form.append("seedingTimeLimit", String(opts.seedTimeMin));
    if (opts.paused) {
      if (src.magnet) {
        // A stopped magnet never fetches its metadata: let it run until the metadata is in, then qBittorrent stops it
        // (stopCondition, qBittorrent 4.5+; older versions keep going and the files are skipped as soon as listed).
        form.append("stopCondition", "MetadataReceived");
      } else {
        form.append("paused", "true"); // qBittorrent 4.x
        form.append("stopped", "true"); // qBittorrent 5.x
      }
    }
    await qbit("/torrents/add", { method: "POST", body: form });
    const known = infoHash(src);
    const extra = opts.paused ? { paused: true, select: true } : {};
    if (known) return { client: "qbittorrent", ref: known, ...extra };
    for (let i = 0; i < 10; i++) {
      const list = (await (await qbit(`/torrents/info?tag=${encodeURIComponent(tag)}`)).json()) as { hash: string }[];
      if (list[0]) return { client: "qbittorrent", ref: list[0].hash, ...extra };
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error("qBittorrent accepted the torrent but it did not appear");
  },
  async status(job: ClientJob): Promise<ClientStatus> {
    if (job.client === "sabnzbd") {
      const q = await sab<{ queue: { kbpersec?: string; slots: { nzo_id: string; percentage: string; status: string; timeleft?: string; mb?: string; mbleft?: string }[] } }>({ mode: "queue", nzo_ids: job.ref });
      const slot = q.queue.slots.find((x) => x.nzo_id === job.ref);
      if (slot) {
        // timeleft is [d:]hh:mm:ss; read it from the right.
        const parts = (slot.timeleft ?? "").split(":").map(Number).reverse();
        const eta = parts.length >= 3 && parts.every(Number.isFinite) ? parts[0] + parts[1] * 60 + parts[2] * 3600 + (parts[3] ?? 0) * 86400 : null;
        return {
          state: slot.status === "Queued" || slot.status === "Paused" ? "queued" : "downloading",
          progress: Number(slot.percentage) / 100,
          etaSec: eta,
          // SABnzbd only reports its total speed; show it only while this job is the one downloading.
          speed: slot.status === "Downloading" && q.queue.kbpersec ? Number(q.queue.kbpersec) * 1024 : null,
          sizeBytes: slot.mb ? Number(slot.mb) * 1024 * 1024 : null,
          clientStatus: slot.status,
        };
      }
      const h = await sab<{ history: { slots: { nzo_id: string; status: string; storage: string; fail_message: string }[] } }>({ mode: "history", nzo_ids: job.ref });
      const hs = h.history.slots.find((x) => x.nzo_id === job.ref);
      if (!hs) return { state: "missing", progress: 0 };
      if (hs.status === "Completed") return { state: "completed", progress: 1, path: hs.storage };
      if (hs.status === "Failed") return { state: "failed", progress: 0, message: hs.fail_message };
      // Post-processing (Queued, Verifying, Repairing, Extracting, Moving…): busy, not stalled.
      return { state: "queued", progress: 0.99, message: hs.status, clientStatus: `post-processing: ${hs.status}` };
    }
    const list = (await (await qbit(`/torrents/info?hashes=${job.ref}`)).json()) as { hash: string; progress: number; state: string; content_path: string; eta: number; dlspeed: number; size: number; num_seeds: number }[];
    const t = list[0];
    if (!t) return { state: "missing", progress: 0 };
    const live = { etaSec: t.eta >= 8640000 ? null : t.eta, speed: t.dlspeed, sizeBytes: t.size, clientStatus: t.state, seeders: t.num_seeds };
    // error/missingFiles are often transient (disk full, permissions, a missing save path): the user should look.
    if (/error|missingFiles/.test(t.state)) return { state: "error", progress: t.progress, message: `qBittorrent reports "${t.state}"`, ...live };
    if (t.progress >= 1) return { state: "completed", progress: 1, path: t.content_path, ...live };
    return { state: /queued|metaDL|checking|^paused|^stopped|moving/i.test(t.state) ? "queued" : "downloading", progress: t.progress, ...live };
  },
  async remove(job: ClientJob): Promise<void> {
    // Only ever AnimeArr's own jobs: the job must still be in AnimeArr's category. Not found = already gone (fine).
    if (job.client === "sabnzbd") {
      const cat = getSettings().sabnzbd.category;
      const q = await sab<{ queue: { slots: { nzo_id: string; cat: string }[] } }>({ mode: "queue", nzo_ids: job.ref });
      const slot = q.queue.slots.find((x) => x.nzo_id === job.ref);
      if (slot) {
        if (slot.cat !== cat) throw new Error(`that SABnzbd job is in category "${slot.cat}", not "${cat}"; leaving it alone`);
        await sab({ mode: "queue", name: "delete", value: job.ref, del_files: "1" });
        return;
      }
      const h = await sab<{ history: { slots: { nzo_id: string; category: string; storage?: string }[] } }>({ mode: "history", nzo_ids: job.ref });
      const hs = h.history.slots.find((x) => x.nzo_id === job.ref);
      if (!hs) return;
      if (hs.category !== cat) throw new Error(`that SABnzbd job is in category "${hs.category}", not "${cat}"; leaving it alone`);
      await sab({ mode: "history", name: "delete", value: job.ref, del_files: "1" });
      // A finished job's files survive del_files: AnimeArr removes the job's folder itself (same rules as the clean-up).
      if (hs.storage) await import("../downloads.js").then((m) => m.removeJobFolder(hs.storage)).catch(() => undefined);
      return;
    }
    const cat = getSettings().qbittorrent.category;
    const list = (await (await qbit(`/torrents/info?hashes=${job.ref}`)).json()) as { hash: string; category: string }[];
    const tor = list[0];
    if (!tor) return;
    if (tor.category !== cat) throw new Error(`that torrent is in category "${tor.category}", not "${cat}"; leaving it alone`);
    await qbit("/torrents/delete", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ hashes: job.ref, deleteFiles: "true" }) });
  },
};

const formBody = (o: Record<string, string>) => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o) });

/** qBittorrent's file selection (partial downloads): /torrents/files, /torrents/filePrio (0 = do not download), start. */
export const qbitFiles = {
  async list(ref: string): Promise<ClientFile[] | null> {
    const files = (await (await qbit(`/torrents/files?hash=${encodeURIComponent(ref)}`)).json()) as { index?: number; name: string; size: number }[];
    // No metadata yet (a magnet): an empty list.
    if (!Array.isArray(files) || !files.length) return null;
    return files.map((f, i) => ({ index: f.index ?? i, name: f.name, size: f.size }));
  },
  async select(ref: string, wanted: number[], skipped: number[]) {
    if (skipped.length) await qbit("/torrents/filePrio", formBody({ hash: ref, id: skipped.join("|"), priority: "0" }));
    // Wanted ones keep (or get back) normal priority.
    if (wanted.length) await qbit("/torrents/filePrio", formBody({ hash: ref, id: wanted.join("|"), priority: "1" })).catch(() => undefined);
  },
  async start(ref: string) {
    try {
      await qbit("/torrents/start", formBody({ hashes: ref })); // qBittorrent 5.x
    } catch (e) {
      if (!/HTTP 404/.test((e as Error).message)) throw e;
      await qbit("/torrents/resume", formBody({ hashes: ref })); // qBittorrent 4.x
    }
  },
};

/**
 * Try the next client only when this one certainly didn't take the job (refused, unreachable before sending, not set
 * up). A timeout or "accepted but did not appear" may have queued it: no second copy elsewhere.
 */
const fallBack = (e: unknown) => {
  const m = String((e as Error)?.message ?? "");
  return !/timeout|aborted|did not appear|returned no hash/i.test(m) && /unreachable|not configured|wrong username|login failed|refused|HTTP (4\d\d|5\d\d)|did not accept/i.test(m);
};

const bh = blackholeDriver({ local: mappedPath, sourceRoots: () => getSettings().importer.sourceRoots ?? [], now: Date.now });

/** What an added ("+ Add") client's driver offers; the file-selection trio is the optional partial-download capability. */
interface Driver {
  test(c: ClientCfg): Promise<{ version: string; categoryExists?: boolean; categories?: string[] }>;
  status(c: ClientCfg, ref: string): Promise<ClientStatus>;
  remove(c: ClientCfg, ref: string): Promise<void>;
  addNzb?(c: ClientCfg, data: Buffer, name: string): Promise<string>;
  addTorrent?(c: ClientCfg, src: { data?: Buffer; magnet?: string }, name: string, opts: AddTorrentOpts): Promise<{ ref: string; paused?: boolean; select?: boolean }>;
  listFiles?(c: ClientCfg, ref: string): Promise<ClientFile[] | null>;
  selectFiles?(c: ClientCfg, ref: string, wanted: number[], skipped: number[]): Promise<void>;
  start?(c: ClientCfg, ref: string): Promise<void>;
}
const DRIVERS: Record<ExtraType, Driver> = {
  nzbget: { ...nzbgetDriver, addNzb: (c, data, name) => nzbgetDriver.add(c, data, name) },
  transmission: { ...transmissionDriver, addTorrent: (c, src, _n, o) => transmissionDriver.add(c, src, o) },
  deluge: { ...delugeDriver, remove: (c, ref) => delugeDriver.remove(c, ref, true), addTorrent: (c, src, _n, o) => delugeDriver.add(c, src, o) },
  rtorrent: { ...rtorrentDriver, remove: (c, ref) => rtorrentDriver.remove(c, ref, true), addTorrent: (c, src, _n, o) => rtorrentDriver.add(c, src, o) },
  "blackhole-usenet": bh,
  "blackhole-torrent": bh,
};
const driver = (c: ResolvedClient) => DRIVERS[c.type as ExtraType];

/**
 * The download clients as the pipeline sees them: a grab goes to the best client of its protocol (priority); if that
 * one refuses, the next one is tried. Status and removal go to the client that has the job.
 */
export const realClients: DownloadClients = {
  async addNzb(data, name) {
    const list = clientsFor("usenet");
    if (!list.length) throw new Error("No Usenet download client is set up (Settings → Download clients)");
    let last: Error | null = null;
    for (const c of list) {
      try {
        if (c.type === "sabnzbd") return await primary.addNzb(data, name);
        return { client: c.id, ref: await driver(c).addNzb!(c.cfg!, data, name) };
      } catch (e) {
        last = e as Error;
        if (!fallBack(e)) break;
      }
    }
    throw last!;
  },
  async addTorrent(src, name, opts) {
    const list = clientsFor("torrent");
    if (!list.length) throw new Error("No torrent download client is set up (Settings → Download clients)");
    let last: Error | null = null;
    for (const c of list) {
      try {
        if (c.type === "qbittorrent") return await primary.addTorrent(src, name, opts);
        return { client: c.id, ...(await driver(c).addTorrent!(c.cfg!, src, name, opts ?? {})) };
      } catch (e) {
        last = e as Error;
        if (!fallBack(e)) break;
      }
    }
    throw last!;
  },
  async status(job) {
    if (job.client === "sabnzbd" || job.client === "qbittorrent") return primary.status(job);
    const c = byId(job.client);
    if (!c?.cfg) return { state: "error", progress: 0, message: `the download client "${job.client}" was removed from Settings` };
    return driver(c).status(c.cfg, job.ref);
  },
  async remove(job) {
    if (job.client === "sabnzbd" || job.client === "qbittorrent") return primary.remove(job);
    const c = byId(job.client);
    // The client was removed from Settings: nothing AnimeArr can remove there any more (treated as gone).
    if (!c?.cfg) return;
    return driver(c).remove(c.cfg, job.ref);
  },
  canSelectFiles(job) {
    if (job.client === "qbittorrent") return true;
    return !!fileDriver(job);
  },
  async listFiles(job) {
    if (job.client === "qbittorrent") return qbitFiles.list(job.ref);
    const f = fileDriver(job);
    if (!f) throw new Error("this download client can't select files");
    return f.d.listFiles(f.cfg, job.ref);
  },
  async selectFiles(job, wanted, skipped) {
    if (job.client === "qbittorrent") return qbitFiles.select(job.ref, wanted, skipped);
    const f = fileDriver(job);
    if (!f) throw new Error("this download client can't select files");
    return f.d.selectFiles(f.cfg, job.ref, wanted, skipped);
  },
  async start(job) {
    if (job.client === "qbittorrent") return qbitFiles.start(job.ref);
    const f = fileDriver(job);
    if (f) await f.d.start(f.cfg, job.ref);
  },
};

/** The added client holding a job, when it has the file-selection capability. */
interface FileCapable { listFiles(c: ClientCfg, ref: string): Promise<ClientFile[] | null>; selectFiles(c: ClientCfg, ref: string, wanted: number[], skipped: number[]): Promise<void>; start(c: ClientCfg, ref: string): Promise<void> }
function fileDriver(job: ClientJob): { d: FileCapable; cfg: ClientCfg } | null {
  const c = byId(job.client);
  if (!c?.cfg) return null;
  const d = driver(c) as Partial<FileCapable> | undefined;
  if (!d) return null;
  return d.listFiles && d.selectFiles && d.start ? { d: d as FileCapable, cfg: c.cfg } : null;
}

/** Connection test for an added client (before or after saving). */
export async function testClient(c: ClientCfg) {
  const d = DRIVERS[c.type as ExtraType];
  if (!d) throw new Error(`Unknown download client type "${c.type}"`);
  return d.test(c);
}

/** Which client types can download only some files of a batch (the partial-download capability). */
export const partialCapable = (type: ClientType) => type === "qbittorrent" || !!(DRIVERS[type as ExtraType]?.listFiles && DRIVERS[type as ExtraType]?.selectFiles && DRIVERS[type as ExtraType]?.start);

/** AnimeArr's own torrents (its category only), with what the folder rules and the clean-up need. Read-only. */
export interface OwnTorrent { hash: string; name: string; contentPath: string; savePath: string; size: number; state: string; ratio: number; seedingTimeSec: number; completedOn: number | null; ratioLimit: number; seedingTimeLimitMin: number }
export async function ownTorrents(): Promise<OwnTorrent[]> {
  const s = getSettings().qbittorrent;
  if (!s.url) return [];
  const list = (await (await qbit(`/torrents/info?category=${encodeURIComponent(s.category)}`)).json()) as { hash: string; name: string; content_path: string; save_path: string; size: number; state: string; ratio: number; seeding_time?: number; completion_on?: number; ratio_limit?: number; seeding_time_limit?: number; category: string }[];
  return list
    .filter((t) => t.category === s.category)
    .map((t) => ({ hash: t.hash, name: t.name, contentPath: t.content_path, savePath: t.save_path, size: t.size, state: t.state, ratio: t.ratio, seedingTimeSec: t.seeding_time ?? 0, completedOn: t.completion_on && t.completion_on > 0 ? t.completion_on * 1000 : null, ratioLimit: t.ratio_limit ?? -2, seedingTimeLimitMin: t.seeding_time_limit ?? -2 }));
}

/** AnimeArr's own SABnzbd history (its category only): where each finished job was stored. Read-only. */
export async function ownSabHistory(): Promise<{ nzoId: string; storage: string; status: string }[]> {
  const s = getSettings().sabnzbd;
  if (!s.url || !s.apiKey) return [];
  const h = await sab<{ history: { slots: { nzo_id: string; storage: string; status: string; category: string }[] } }>({ mode: "history", category: s.category, limit: "2000" });
  return h.history.slots.filter((x) => x.category === s.category).map((x) => ({ nzoId: x.nzo_id, storage: x.storage, status: x.status }));
}
