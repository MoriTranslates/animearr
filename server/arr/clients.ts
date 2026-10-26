import { getSettings } from "../settings.js";

/**
 * Download clients. AnimeArr sends its grabs with its own category ("animearr" by default), so Sonarr's own
 * completed-download handling ignores them and AnimeArr imports them explicitly.
 */

export interface ClientJob {
  /** SABnzbd nzo_id or qBittorrent info-hash. */
  ref: string;
  client: "sabnzbd" | "qbittorrent";
}
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
  addTorrent(src: { data?: Buffer; magnet?: string }, name: string): Promise<ClientJob>;
  status(job: ClientJob): Promise<ClientStatus>;
  /** Removes the job from the client and deletes its downloaded data (never library files). */
  remove(job: ClientJob): Promise<void>;
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

export const realClients: DownloadClients = {
  async addNzb(data, name) {
    const form = new FormData();
    form.append("name", new Blob([new Uint8Array(data)], { type: "application/x-nzb" }), `${name.replace(/[\\/:*?"<>|]/g, "_")}.nzb`);
    const s = getSettings().sabnzbd;
    const r = await sab<{ nzo_ids: string[] }>({ mode: "addfile", cat: s.category, nzbname: name }, s, form);
    if (!r.nzo_ids?.[0]) throw new Error("SABnzbd did not accept the NZB");
    return { client: "sabnzbd", ref: r.nzo_ids[0] };
  },
  async addTorrent(src, name) {
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
    await qbit("/torrents/add", { method: "POST", body: form });
    const known = infoHash(src);
    if (known) return { client: "qbittorrent", ref: known };
    for (let i = 0; i < 10; i++) {
      const list = (await (await qbit(`/torrents/info?tag=${encodeURIComponent(tag)}`)).json()) as { hash: string }[];
      if (list[0]) return { client: "qbittorrent", ref: list[0].hash };
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error("qBittorrent accepted the torrent but it did not appear");
  },
  async status(job) {
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
  async remove(job) {
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
      const h = await sab<{ history: { slots: { nzo_id: string; category: string }[] } }>({ mode: "history", nzo_ids: job.ref });
      const hs = h.history.slots.find((x) => x.nzo_id === job.ref);
      if (!hs) return;
      if (hs.category !== cat) throw new Error(`that SABnzbd job is in category "${hs.category}", not "${cat}"; leaving it alone`);
      await sab({ mode: "history", name: "delete", value: job.ref, del_files: "1" });
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
