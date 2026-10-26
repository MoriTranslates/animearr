/**
 * NZBGet and Transmission (the "+ Add" download clients beyond the primary SABnzbd/qBittorrent slots).
 * Same contract as the primary ones: AnimeArr sends with its own category (NZBGet category; Transmission label and a
 * category sub-folder), reads progress, and removes only its own jobs.
 */
import type { ClientCfg } from "../settings.js";
import { redactUrl } from "./http.js";
import type { ClientStatus } from "./clients.js";

const trim = (u: string) => u.replace(/\/+$/, "");
const mapPath = (p: string, c: ClientCfg) => {
  for (const m of c.pathMappings ?? []) if (m.from && (p === m.from || p.startsWith(`${m.from.replace(/\/+$/, "")}/`))) return m.to.replace(/\/+$/, "") + p.slice(m.from.replace(/\/+$/, "").length);
  return p;
};

// ---------------------------------------------------------------- NZBGet (JSON-RPC)

async function nzbget<T>(c: ClientCfg, method: string, params: unknown[] = []): Promise<T> {
  if (!c.url) throw new Error(`${c.name} is not configured`);
  let res: Response;
  try {
    res = await fetch(`${trim(c.url)}/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(c.username ? { Authorization: `Basic ${Buffer.from(`${c.username}:${c.password}`).toString("base64")}` } : {}) },
      body: JSON.stringify({ method, params, id: 1 }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new Error(`${c.name} unreachable (${redactUrl((e as Error).message)})`);
  }
  if (res.status === 401) throw new Error(`${c.name}: wrong username or password`);
  if (!res.ok) throw new Error(`${c.name} ${method} failed (HTTP ${res.status})`);
  const j = (await res.json()) as { result?: T; error?: { message?: string } | null };
  if (j.error) throw new Error(`${c.name}: ${j.error.message ?? "error"}`);
  return j.result as T;
}

export const nzbgetDriver = {
  async test(c: ClientCfg) {
    const version = await nzbget<string>(c, "version");
    const cfg = await nzbget<{ Name: string; Value: string }[]>(c, "config");
    const cats = cfg.filter((x) => /^Category\d+\.Name$/.test(x.Name)).map((x) => x.Value);
    return { version, categoryExists: cats.includes(c.category), categories: cats };
  },
  async add(c: ClientCfg, data: Buffer, name: string) {
    const id = await nzbget<number>(c, "append", [`${name.replace(/[\\/:*?"<>|]/g, "_")}.nzb`, data.toString("base64"), c.category, 0, false, false, "", 0, "SCORE", []]);
    if (!id || id <= 0) throw new Error(`${c.name} did not accept the NZB`);
    return String(id);
  },
  async status(c: ClientCfg, ref: string): Promise<ClientStatus> {
    const id = Number(ref);
    const groups = await nzbget<{ NZBID: number; Status: string; FileSizeMB: number; RemainingSizeMB: number; DownloadRate?: number }[]>(c, "listgroups", [0]);
    const g = groups.find((x) => x.NZBID === id);
    if (g) {
      const progress = g.FileSizeMB ? Math.max(0, Math.min(1, 1 - g.RemainingSizeMB / g.FileSizeMB)) : 0;
      const busy = /^(PP_|LOADING_PARS|VERIFYING|REPAIRING|UNPACKING|MOVING|EXECUTING|RENAMING)/.test(g.Status);
      return { state: /QUEUED|PAUSED/.test(g.Status) ? "queued" : busy ? "queued" : "downloading", progress: busy ? 0.99 : progress, sizeBytes: g.FileSizeMB * 1024 * 1024, clientStatus: g.Status };
    }
    const hist = await nzbget<{ NZBID: number; Status: string; DestDir: string; FinalDir?: string }[]>(c, "history", [false]);
    const h = hist.find((x) => x.NZBID === id);
    if (!h) return { state: "missing", progress: 0 };
    if (h.Status.startsWith("SUCCESS")) return { state: "completed", progress: 1, path: mapPath(h.FinalDir || h.DestDir, c) };
    if (h.Status.startsWith("FAILURE")) return { state: "failed", progress: 0, message: `${c.name}: ${h.Status}` };
    if (h.Status.startsWith("DELETED")) return { state: "missing", progress: 0 };
    return { state: "error", progress: 1, message: `${c.name} reports ${h.Status}` };
  },
  async remove(c: ClientCfg, ref: string) {
    const id = Number(ref);
    const groups = await nzbget<{ NZBID: number; Category: string }[]>(c, "listgroups", [0]);
    const g = groups.find((x) => x.NZBID === id);
    if (g) {
      if (g.Category !== c.category) throw new Error(`that ${c.name} job is in category "${g.Category}", not "${c.category}"; leaving it alone`);
      await nzbget(c, "editqueue", ["GroupFinalDelete", "", [id]]);
      return;
    }
    const hist = await nzbget<{ NZBID: number; Category: string }[]>(c, "history", [false]);
    const h = hist.find((x) => x.NZBID === id);
    if (!h) return;
    if (h.Category !== c.category) throw new Error(`that ${c.name} job is in category "${h.Category}", not "${c.category}"; leaving it alone`);
    await nzbget(c, "editqueue", ["HistoryFinalDelete", "", [id]]);
  },
};

// ---------------------------------------------------------------- Transmission (RPC with a session id)

const sessions = new Map<string, string>();
const rpcUrl = (c: ClientCfg) => (/\/rpc$/.test(trim(c.url)) ? trim(c.url) : `${trim(c.url)}/transmission/rpc`);

async function transmission<T>(c: ClientCfg, method: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!c.url) throw new Error(`${c.name} is not configured`);
  const url = rpcUrl(c);
  const call = () =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(sessions.get(url) ? { "X-Transmission-Session-Id": sessions.get(url)! } : {}), ...(c.username ? { Authorization: `Basic ${Buffer.from(`${c.username}:${c.password}`).toString("base64")}` } : {}) },
      body: JSON.stringify({ method, arguments: args }),
      signal: AbortSignal.timeout(60_000),
    });
  let res: Response;
  try {
    res = await call();
    if (res.status === 409) {
      sessions.set(url, res.headers.get("X-Transmission-Session-Id") ?? "");
      res = await call();
    }
  } catch (e) {
    throw new Error(`${c.name} unreachable (${redactUrl((e as Error).message)})`);
  }
  if (res.status === 401) throw new Error(`${c.name}: wrong username or password`);
  if (!res.ok) throw new Error(`${c.name} ${method} failed (HTTP ${res.status})`);
  const j = (await res.json()) as { result: string; arguments: T };
  if (j.result !== "success") throw new Error(`${c.name}: ${j.result}`);
  return j.arguments;
}

interface TrTorrent { hashString: string; name: string; percentDone: number; status: number; downloadDir: string; eta: number; rateDownload: number; totalSize: number; peersSendingToUs: number; error: number; errorString: string; labels?: string[] }
const TR_FIELDS = ["hashString", "name", "percentDone", "status", "downloadDir", "eta", "rateDownload", "totalSize", "peersSendingToUs", "error", "errorString", "labels"];
const ours = (t: TrTorrent, c: ClientCfg) => (t.labels ?? []).includes(c.category) || t.downloadDir.replace(/\/+$/, "").endsWith(`/${c.category}`);

export const transmissionDriver = {
  async test(c: ClientCfg) {
    const s = await transmission<{ version: string; "download-dir": string }>(c, "session-get", { fields: ["version", "download-dir"] });
    return { version: s.version, categoryExists: true, categories: [] as string[], downloadDir: s["download-dir"] };
  },
  async add(c: ClientCfg, src: { data?: Buffer; magnet?: string }, opts: { seedRatio?: number | null; seedTimeMin?: number | null } = {}) {
    const s = await transmission<{ "download-dir": string }>(c, "session-get", { fields: ["download-dir"] });
    const args: Record<string, unknown> = { "download-dir": `${s["download-dir"].replace(/\/+$/, "")}/${c.category}`, labels: [c.category] };
    if (src.magnet) args.filename = src.magnet;
    else if (src.data) args.metainfo = src.data.toString("base64");
    else throw new Error(`Nothing to send to ${c.name}`);
    const r = await transmission<{ "torrent-added"?: { hashString: string }; "torrent-duplicate"?: { hashString: string } }>(c, "torrent-add", args);
    const hash = r["torrent-added"]?.hashString ?? r["torrent-duplicate"]?.hashString;
    if (!hash) throw new Error(`${c.name} accepted the torrent but returned no hash`);
    // Transmission has a ratio limit but no "seed for N minutes" (only an idle limit): the ratio applies here.
    if (opts.seedRatio != null) await transmission(c, "torrent-set", { ids: [hash], seedRatioLimit: opts.seedRatio, seedRatioMode: 1 }).catch(() => undefined);
    return hash.toLowerCase();
  },
  async status(c: ClientCfg, ref: string): Promise<ClientStatus> {
    const r = await transmission<{ torrents: TrTorrent[] }>(c, "torrent-get", { ids: [ref], fields: TR_FIELDS });
    const t = r.torrents[0];
    if (!t) return { state: "missing", progress: 0 };
    const live = { etaSec: t.eta >= 0 ? t.eta : null, speed: t.rateDownload, sizeBytes: t.totalSize, clientStatus: String(t.status), seeders: t.peersSendingToUs };
    // 1/2 are tracker warnings/errors (routine); 3 is a local error (disk, permissions) that needs a look.
    if (t.error === 3) return { state: "error", progress: t.percentDone, message: `${c.name}: ${t.errorString}`, ...live };
    if (t.percentDone >= 1) return { state: "completed", progress: 1, path: mapPath(`${t.downloadDir.replace(/\/+$/, "")}/${t.name}`, c), ...live };
    return { state: t.status === 4 ? "downloading" : "queued", progress: t.percentDone, ...live };
  },
  async remove(c: ClientCfg, ref: string) {
    const r = await transmission<{ torrents: TrTorrent[] }>(c, "torrent-get", { ids: [ref], fields: TR_FIELDS });
    const t = r.torrents[0];
    if (!t) return;
    if (!ours(t, c)) throw new Error(`that torrent isn't in AnimeArr's "${c.category}" label/folder; leaving it alone`);
    await transmission(c, "torrent-remove", { ids: [ref], "delete-local-data": true });
  },
};
