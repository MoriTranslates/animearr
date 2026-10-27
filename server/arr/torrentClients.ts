/**
 * Deluge and rTorrent (added with "+ Add", like NZBGet/Transmission). Same contract as the other torrent clients:
 * AnimeArr's torrents get its label (Deluge's Label plugin; rTorrent's d.custom1, the ruTorrent convention) and a
 * sub-folder of the client's download folder named after it; progress, ratio and seeding are read back; only
 * AnimeArr's own torrents are removed; batches can skip files (partial downloads).
 *
 * Deluge: the Web UI's JSON-RPC (/json): auth.login with the Web UI password, then web.connected / web.connect to the
 * first daemon host if the Web UI isn't connected yet. Deluge 2.x is the target; 1.3 differences are handled where
 * the method names differ (resume/pause take a list in 1.3, file priorities via set_torrent_file_priorities).
 *
 * rTorrent: XML-RPC over HTTP (ruTorrent's /RPC2, or the httprpc plugin's /plugins/httprpc/action.php), with optional
 * basic auth. rTorrent can't delete data itself: removing with data erases the torrent, then AnimeArr deletes its
 * folder under the clean-up's rules (inside AnimeArr's download folders only, deleting switched on).
 */
import { createHash } from "node:crypto";
import type { ClientCfg } from "../settings.js";
import { redactUrl } from "./http.js";
import type { ClientFile, ClientStatus } from "./clients.js";

const trim = (u: string) => u.replace(/\/+$/, "");
export const mapClientPath = (p: string, c: ClientCfg) => {
  for (const m of c.pathMappings ?? []) if (m.from && (p === m.from || p.startsWith(`${m.from.replace(/\/+$/, "")}/`))) return m.to.replace(/\/+$/, "") + p.slice(m.from.replace(/\/+$/, "").length);
  return p;
};
type AddOpts = { seedRatio?: number | null; seedTimeMin?: number | null; paused?: boolean };
type Added = { ref: string; paused?: boolean; select?: boolean };

// ---------------------------------------------------------------- info-hash (rTorrent's load doesn't return it)

/** The raw bytes of the torrent's "info" dictionary (bencode), for its SHA-1 info-hash. */
function infoSlice(buf: Buffer): Buffer | null {
  let i = 0;
  const skip = (): void => {
    const ch = buf[i];
    if (ch === 0x69) {
      // i...e
      i = buf.indexOf(0x65, i) + 1;
    } else if (ch === 0x6c || ch === 0x64) {
      i++;
      while (buf[i] !== 0x65) skip();
      i++;
    } else {
      const colon = buf.indexOf(0x3a, i);
      const len = Number(buf.subarray(i, colon).toString());
      i = colon + 1 + len;
    }
    if (i <= 0 || i > buf.length) throw new Error("bad torrent");
  };
  if (buf[0] !== 0x64) return null;
  i = 1;
  while (i < buf.length && buf[i] !== 0x65) {
    const colon = buf.indexOf(0x3a, i);
    const len = Number(buf.subarray(i, colon).toString());
    const key = buf.subarray(colon + 1, colon + 1 + len).toString();
    i = colon + 1 + len;
    const start = i;
    skip();
    if (key === "info") return buf.subarray(start, i);
  }
  return null;
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** Info-hash (lower-case hex) of a .torrent or a magnet link (hex or base32 btih). */
export function torrentHash(src: { data?: Buffer; magnet?: string }): string | null {
  if (src.magnet) {
    const m = /xt=urn:btih:([a-z0-9]+)/i.exec(src.magnet)?.[1];
    if (!m) return null;
    if (m.length === 40) return m.toLowerCase();
    if (m.length === 32) {
      let bits = "";
      for (const ch of m.toUpperCase()) bits += B32.indexOf(ch).toString(2).padStart(5, "0");
      return Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2))).toString("hex");
    }
    return null;
  }
  if (!src.data) return null;
  try {
    const info = infoSlice(src.data);
    return info ? createHash("sha1").update(info).digest("hex") : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Deluge (Web UI JSON-RPC)

const delugeCookies = new Map<string, string>();
let rpcId = 0;

async function delugeRaw<T>(c: ClientCfg, method: string, params: unknown[]): Promise<{ result: T; error: { message?: string; code?: number } | null; status: number }> {
  const url = /\/json$/.test(trim(c.url)) ? trim(c.url) : `${trim(c.url)}/json`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...(delugeCookies.get(url) ? { Cookie: delugeCookies.get(url)! } : {}) },
      body: JSON.stringify({ method, params, id: ++rpcId }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new Error(`${c.name} unreachable (${redactUrl((e as Error).message)})`);
  }
  const cookie = /_session_id=[^;]+/.exec(res.headers.get("set-cookie") ?? "")?.[0];
  if (cookie) delugeCookies.set(url, cookie);
  if (!res.ok) throw new Error(`${c.name} ${method} failed (HTTP ${res.status})`);
  const j = (await res.json()) as { result: T; error: { message?: string; code?: number } | null };
  return { ...j, status: res.status };
}

/** A Deluge call: logs in (and connects the Web UI to its daemon) when needed. */
async function deluge<T>(c: ClientCfg, method: string, params: unknown[] = []): Promise<T> {
  let r = await delugeRaw<T>(c, method, params);
  // Not logged in (error code 1, "Not authenticated"): log in, connect to the daemon, try again.
  if (r.error && (r.error.code === 1 || /not authenticated/i.test(r.error.message ?? ""))) {
    await delugeLogin(c);
    r = await delugeRaw<T>(c, method, params);
  }
  if (r.error) throw new Error(`${c.name}: ${r.error.message ?? "error"}`);
  return r.result;
}

async function delugeLogin(c: ClientCfg) {
  const ok = await delugeRaw<boolean>(c, "auth.login", [c.password]);
  if (ok.error || ok.result !== true) throw new Error(`${c.name}: wrong password (the Web UI password)`);
  const connected = await delugeRaw<boolean>(c, "web.connected", []);
  if (connected.result) return;
  // The Web UI isn't connected to a daemon yet: the first host it knows (usually the local one).
  const hosts = await delugeRaw<unknown[][]>(c, "web.get_hosts", []);
  const first = hosts.result?.[0]?.[0];
  if (!first) throw new Error(`${c.name}: the Web UI has no daemon to connect to (Connection Manager)`);
  const conn = await delugeRaw<unknown>(c, "web.connect", [first]);
  if (conn.error) throw new Error(`${c.name}: couldn't connect the Web UI to its daemon (${conn.error.message})`);
}

/** Deluge 2.x first, then the 1.3 name (methods that changed between the two). */
async function delugeEither<T>(c: ClientCfg, a: [string, unknown[]], b: [string, unknown[]]): Promise<T> {
  try {
    return await deluge<T>(c, a[0], a[1]);
  } catch (e) {
    if (!/unknown method|no such method|not found|attributeerror/i.test((e as Error).message)) throw e;
    return deluge<T>(c, b[0], b[1]);
  }
}

interface DelugeTorrent { name: string; progress: number; state: string; save_path: string; eta: number; download_payload_rate: number; total_wanted: number; num_seeds: number; ratio: number; label?: string; message?: string; is_finished?: boolean; files?: { index: number; path: string; size: number }[]; file_priorities?: number[]; seeding_time?: number }
const DELUGE_KEYS = ["name", "progress", "state", "save_path", "eta", "download_payload_rate", "total_wanted", "num_seeds", "ratio", "label", "message", "is_finished", "seeding_time"];

async function delugeTorrent(c: ClientCfg, ref: string, keys = DELUGE_KEYS): Promise<DelugeTorrent | null> {
  const r = await deluge<Record<string, DelugeTorrent>>(c, "core.get_torrents_status", [{ id: [ref] }, keys]);
  return r?.[ref] ?? r?.[ref.toLowerCase()] ?? null;
}

async function delugeHasLabel(c: ClientCfg) {
  try {
    const plugins = await deluge<string[]>(c, "core.get_enabled_plugins");
    return plugins.some((p) => /^label$/i.test(p));
  } catch {
    return false;
  }
}

export const delugeDriver = {
  async test(c: ClientCfg) {
    await delugeLogin(c);
    let version = "";
    try {
      version = await deluge<string>(c, "daemon.info");
    } catch {
      version = await deluge<string>(c, "daemon.get_version").catch(() => "Deluge");
    }
    const label = await delugeHasLabel(c);
    const labels = label ? await deluge<string[]>(c, "label.get_labels").catch(() => [] as string[]) : [];
    // Without the Label plugin AnimeArr still works (its torrents go to the category sub-folder); the label is a nicety.
    return { version, categoryExists: true, categories: labels, labelPlugin: label };
  },
  async add(c: ClientCfg, src: { data?: Buffer; magnet?: string }, opts: AddOpts = {}): Promise<Added> {
    const dir = await deluge<string>(c, "core.get_config_value", ["download_location"]);
    const paused = !!opts.paused && !src.magnet; // a paused magnet would never fetch its metadata
    const options: Record<string, unknown> = { add_paused: paused, download_location: `${dir.replace(/\/+$/, "")}/${c.category}` };
    if (opts.seedRatio != null) Object.assign(options, { stop_at_ratio: true, stop_ratio: opts.seedRatio });
    const known = torrentHash(src);
    let id: string | null;
    try {
      if (src.magnet) id = await deluge<string | null>(c, "core.add_torrent_magnet", [src.magnet, options]);
      else if (src.data) id = await deluge<string | null>(c, "core.add_torrent_file", ["animearr.torrent", src.data.toString("base64"), options]);
      else throw new Error(`Nothing to send to ${c.name}`);
    } catch (e) {
      // Deluge 2 raises "Torrent already in session"; 1.3 returns null. Either way: not freshly added.
      if (known && /already/i.test((e as Error).message)) return { ref: known };
      throw e;
    }
    const ref = (id ?? known ?? "").toLowerCase();
    if (!ref) throw new Error(`${c.name} accepted the torrent but returned no hash`);
    if (!id) return { ref }; // a duplicate: its files and state are left alone
    // Category = the Label plugin's label. Not enabled: fine (the sub-folder still keeps them apart).
    if (await delugeHasLabel(c)) {
      const label = c.category.toLowerCase();
      await deluge(c, "label.add", [label]).catch(() => undefined); // exists already: fine
      await deluge(c, "label.set_torrent", [ref, label]).catch(() => undefined);
    }
    return { ref, ...(opts.paused ? { select: true, paused } : {}) };
  },
  async status(c: ClientCfg, ref: string): Promise<ClientStatus> {
    const t = await delugeTorrent(c, ref);
    if (!t) return { state: "missing", progress: 0 };
    const progress = (t.progress ?? 0) / 100;
    const live = { etaSec: t.eta > 0 ? t.eta : null, speed: t.download_payload_rate, sizeBytes: t.total_wanted, clientStatus: t.state, seeders: t.num_seeds };
    if (t.state === "Error") return { state: "error", progress, message: `${c.name}: ${t.message || "error"}`, ...live };
    if (progress >= 1 || t.is_finished) return { state: "completed", progress: 1, path: mapClientPath(`${t.save_path.replace(/\/+$/, "")}/${t.name}`, c), ...live };
    return { state: /Downloading/i.test(t.state) ? "downloading" : "queued", progress, ...live };
  },
  async remove(c: ClientCfg, ref: string, withData = true) {
    const t = await delugeTorrent(c, ref, ["label", "save_path"]);
    if (!t) return;
    const ours = (t.label ?? "").toLowerCase() === c.category.toLowerCase() || t.save_path.replace(/\/+$/, "").endsWith(`/${c.category}`);
    if (!ours) throw new Error(`that torrent isn't in AnimeArr's "${c.category}" label/folder; leaving it alone`);
    await deluge(c, "core.remove_torrent", [ref, withData]);
  },
  async listFiles(c: ClientCfg, ref: string): Promise<ClientFile[] | null> {
    const t = await delugeTorrent(c, ref, ["files"]);
    if (!t) throw new Error(`the torrent is no longer in ${c.name}`);
    if (!t.files?.length) return null; // a magnet without its metadata yet
    return t.files.map((f) => ({ index: f.index, name: f.path, size: f.size }));
  },
  async selectFiles(c: ClientCfg, ref: string, wanted: number[], skipped: number[]) {
    const t = await delugeTorrent(c, ref, ["files"]);
    const n = t?.files?.length ?? 0;
    if (!n) throw new Error("no file list yet");
    const skip = new Set(skipped);
    const prios = Array.from({ length: n }, (_, i) => (skip.has(i) ? 0 : 1));
    void wanted;
    await delugeEither(c, ["core.set_torrent_options", [[ref], { file_priorities: prios }]], ["core.set_torrent_file_priorities", [ref, prios]]);
  },
  async start(c: ClientCfg, ref: string) {
    await delugeEither(c, ["core.resume_torrents", [[ref]]], ["core.resume_torrent", [[ref]]]);
  },
  async pause(c: ClientCfg, ref: string) {
    await delugeEither(c, ["core.pause_torrents", [[ref]]], ["core.pause_torrent", [[ref]]]);
  },
};

// ---------------------------------------------------------------- XML-RPC (rTorrent)

export type XmlValue = string | number | boolean | Buffer | XmlValue[] | { [k: string]: XmlValue } | null;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function encodeValue(v: XmlValue): string {
  if (v === null) return "<value><string></string></value>";
  if (Buffer.isBuffer(v)) return `<value><base64>${v.toString("base64")}</base64></value>`;
  if (typeof v === "number") return Number.isInteger(v) ? `<value><i8>${v}</i8></value>` : `<value><double>${v}</double></value>`;
  if (typeof v === "boolean") return `<value><boolean>${v ? 1 : 0}</boolean></value>`;
  if (typeof v === "string") return `<value><string>${esc(v)}</string></value>`;
  if (Array.isArray(v)) return `<value><array><data>${v.map(encodeValue).join("")}</data></array></value>`;
  return `<value><struct>${Object.entries(v).map(([k, x]) => `<member><name>${esc(k)}</name>${encodeValue(x)}</member>`).join("")}</struct></value>`;
}
export const encodeCall = (method: string, params: XmlValue[]) => `<?xml version="1.0"?><methodCall><methodName>${esc(method)}</methodName><params>${params.map((p) => `<param>${encodeValue(p)}</param>`).join("")}</params></methodCall>`;

const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d))).replace(/&amp;/g, "&");

/** A small XML-RPC response parser (the subset rTorrent sends). */
export function decodeResponse(xml: string): XmlValue {
  const tokens = xml.replace(/<\?xml[^>]*>/, "").match(/<[^>]+>|[^<]+/g) ?? [];
  let i = 0;
  const next = () => tokens[i++];
  const peek = () => tokens[i];
  const skipWs = () => {
    while (i < tokens.length && !tokens[i].startsWith("<") && !tokens[i].trim()) i++;
  };
  const text = (close: string) => {
    let s = "";
    while (i < tokens.length && tokens[i] !== close) s += tokens[i++];
    i++;
    return unesc(s);
  };
  const value = (): XmlValue => {
    skipWs();
    const open = next(); // <value> or <value/>
    if (open === "<value/>") return "";
    skipWs();
    const tag = peek();
    if (tag === "</value>") {
      i++;
      return "";
    }
    if (!tag.startsWith("<")) {
      const s = text("</value>");
      return s;
    }
    i++;
    let out: XmlValue;
    const name = /^<([a-z0-9.]+)\s*\/?>/i.exec(tag)?.[1] ?? "";
    if (tag.endsWith("/>")) out = name === "nil" ? null : name === "array" ? [] : name === "struct" ? {} : "";
    else if (name === "string") out = text("</string>");
    else if (name === "i4" || name === "i8" || name === "int" || name === "ex:i8" || name === "double") out = Number(text(`</${name}>`));
    else if (name === "boolean") out = text("</boolean>").trim() === "1";
    else if (name === "base64") out = Buffer.from(text("</base64>"), "base64");
    else if (name === "nil" || name === "ex:nil") (text(`</${name}>`), (out = null));
    else if (name === "array") {
      skipWs();
      const arr: XmlValue[] = [];
      if (peek() === "<data/>") i++;
      else {
        i++; // <data>
        skipWs();
        while (peek() !== "</data>") {
          arr.push(value());
          skipWs();
        }
        i++;
      }
      skipWs();
      i++; // </array>
      out = arr;
    } else if (name === "struct") {
      const obj: Record<string, XmlValue> = {};
      skipWs();
      while (peek() === "<member>") {
        i++;
        skipWs();
        i++; // <name>
        const k = text("</name>");
        obj[k] = value();
        skipWs();
        i++; // </member>
        skipWs();
      }
      i++; // </struct>
      out = obj;
    } else out = text(`</${name}>`);
    skipWs();
    if (peek() === "</value>") i++;
    return out;
  };
  // <methodResponse><params><param><value>… or <fault><value><struct>…
  while (i < tokens.length && peek() !== "<value>" && peek() !== "<fault>" && peek() !== "<value/>") i++;
  if (peek() === "<fault>") {
    i++;
    const f = value() as { faultString?: string; faultCode?: number };
    throw new Error(`fault ${f?.faultCode ?? ""}: ${f?.faultString ?? "error"}`);
  }
  return value();
}

async function rtorrent<T extends XmlValue>(c: ClientCfg, method: string, params: XmlValue[] = []): Promise<T> {
  if (!c.url) throw new Error(`${c.name} is not configured`);
  let res: Response;
  try {
    res = await fetch(trim(c.url), {
      method: "POST",
      headers: { "Content-Type": "text/xml", ...(c.username ? { Authorization: `Basic ${Buffer.from(`${c.username}:${c.password}`).toString("base64")}` } : {}) },
      body: encodeCall(method, params),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new Error(`${c.name} unreachable (${redactUrl((e as Error).message)})`);
  }
  if (res.status === 401) throw new Error(`${c.name}: wrong username or password`);
  if (!res.ok) throw new Error(`${c.name} ${method} failed (HTTP ${res.status})`);
  try {
    return decodeResponse(await res.text()) as T;
  } catch (e) {
    throw new Error(`${c.name}: ${(e as Error).message}`);
  }
}

const RT_FIELDS = ["d.hash=", "d.name=", "d.custom1=", "d.size_bytes=", "d.completed_bytes=", "d.down.rate=", "d.ratio=", "d.state=", "d.is_active=", "d.complete=", "d.base_path=", "d.directory=", "d.message=", "d.peers_complete=", "d.wanted_chunks=", "d.is_meta=", "d.left_bytes="];
interface RtTorrent { hash: string; name: string; label: string; size: number; done: number; rate: number; ratio: number; state: number; active: number; complete: number; basePath: string; directory: string; message: string; seeders: number; wantedChunks: number; meta: number; left: number }
const rtRow = (r: XmlValue[]): RtTorrent => {
  const [hash, name, label, size, done, rate, ratio, state, active, complete, basePath, directory, message, seeders, wantedChunks, meta, left] = r as (string | number)[];
  return { hash: String(hash).toLowerCase(), name: String(name), label: decodeURIComponent(String(label ?? "")), size: Number(size), done: Number(done), rate: Number(rate), ratio: Number(ratio) / 1000, state: Number(state), active: Number(active), complete: Number(complete), basePath: String(basePath ?? ""), directory: String(directory ?? ""), message: String(message ?? ""), seeders: Number(seeders), wantedChunks: Number(wantedChunks), meta: Number(meta), left: Number(left) };
};

async function rtTorrent(c: ClientCfg, ref: string): Promise<RtTorrent | null> {
  const rows = await rtorrent<XmlValue[][]>(c, "d.multicall2", ["", "main", ...RT_FIELDS]);
  return (rows ?? []).map(rtRow).find((t) => t.hash === ref.toLowerCase()) ?? null;
}

export const rtorrentDriver = {
  async test(c: ClientCfg) {
    const version = await rtorrent<string>(c, "system.client_version");
    const dir = await rtorrent<string>(c, "directory.default").catch(() => "");
    return { version: `rTorrent ${version}`, categoryExists: true, categories: [] as string[], downloadDir: dir };
  },
  async add(c: ClientCfg, src: { data?: Buffer; magnet?: string }, opts: AddOpts = {}): Promise<Added> {
    const hash = torrentHash(src);
    if (!hash) throw new Error(`${c.name}: couldn't read the torrent's info-hash`);
    const already = await rtTorrent(c, hash);
    if (already) return { ref: hash }; // a duplicate: left as it is
    const dir = await rtorrent<string>(c, "directory.default");
    const target = `${dir.replace(/\/+$/, "")}/${c.category}`.replace(/"/g, "");
    // rTorrent doesn't create missing parent folders (the torrent would sit "open but inactive"): mkdir -p it, the way
    // ruTorrent does. A setup that disables execute.* needs the folder to exist already.
    await rtorrent(c, "execute.throw", ["", "mkdir", "-p", target]).catch(() => undefined);
    // The label the ruTorrent way (d.custom1, URI-encoded); AnimeArr's own sub-folder of the download directory.
    const cmds = [`d.custom1.set=${encodeURIComponent(c.category)}`, `d.directory.set="${target}"`];
    // A stopped magnet never fetches its metadata: magnets start, and their files are skipped once listed.
    const paused = !!opts.paused && !src.magnet;
    if (src.magnet) await rtorrent(c, "load.start", ["", src.magnet, ...cmds]);
    else if (src.data) await rtorrent(c, paused ? "load.raw" : "load.raw_start", ["", src.data, ...cmds]);
    else throw new Error(`Nothing to send to ${c.name}`);
    for (let i = 0; i < 10; i++) {
      if (await rtTorrent(c, hash)) return { ref: hash, ...(opts.paused ? { select: true, paused } : {}) };
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`${c.name} accepted the torrent but it did not appear`);
  },
  async status(c: ClientCfg, ref: string): Promise<ClientStatus> {
    const t = await rtTorrent(c, ref);
    if (!t) return { state: "missing", progress: 0 };
    const progress = t.size > 0 ? Math.min(1, t.done / t.size) : 0;
    const live = { etaSec: t.rate > 0 ? Math.round(t.left / t.rate) : null, speed: t.rate, sizeBytes: t.size, clientStatus: t.meta ? "metaDL" : t.state === 0 ? "stopped" : t.complete ? "seeding" : t.active ? "downloading" : "paused", seeders: t.seeders };
    if (t.message && /error|failed|no space|permission/i.test(t.message) && !/tracker/i.test(t.message)) return { state: "error", progress, message: `${c.name}: ${t.message}`, ...live };
    // Complete = every wanted chunk is in (skipped files don't count).
    if (!t.meta && (t.complete === 1 || t.wantedChunks === 0) && t.size > 0) return { state: "completed", progress: 1, path: mapClientPath(t.basePath || `${t.directory.replace(/\/+$/, "")}/${t.name}`, c), ...live };
    return { state: t.state === 1 && t.active ? "downloading" : "queued", progress, ...live };
  },
  /** Erases the torrent; with data, AnimeArr then deletes its folder (rTorrent can't), under the clean-up's rules. */
  async remove(c: ClientCfg, ref: string, withData = true) {
    const t = await rtTorrent(c, ref);
    if (!t) return;
    const ours = t.label.toLowerCase() === c.category.toLowerCase() || t.directory.replace(/\/+$/, "").split("/").includes(c.category);
    if (!ours) throw new Error(`that torrent isn't in AnimeArr's "${c.category}" label/folder; leaving it alone`);
    const base = t.basePath || `${t.directory.replace(/\/+$/, "")}/${t.name}`;
    await rtorrent(c, "d.stop", [ref.toUpperCase()]).catch(() => undefined);
    await rtorrent(c, "d.close", [ref.toUpperCase()]).catch(() => undefined);
    await rtorrent(c, "d.erase", [ref.toUpperCase()]);
    if (withData && base) await import("../downloads.js").then((m) => m.removeDownloadPath(mapClientPath(base, c))).catch(() => undefined);
  },
  async listFiles(c: ClientCfg, ref: string): Promise<ClientFile[] | null> {
    const t = await rtTorrent(c, ref);
    if (!t) throw new Error(`the torrent is no longer in ${c.name}`);
    if (t.meta) return null; // a magnet still fetching its metadata
    const rows = await rtorrent<XmlValue[][]>(c, "f.multicall", [ref.toUpperCase(), "", "f.path=", "f.size_bytes="]);
    if (!rows?.length) return null;
    return rows.map((r, i) => ({ index: i, name: `${t.name}/${String(r[0])}`, size: Number(r[1]) }));
  },
  async selectFiles(c: ClientCfg, ref: string, wanted: number[], skipped: number[]) {
    for (const i of skipped) await rtorrent(c, "f.priority.set", [`${ref.toUpperCase()}:f${i}`, 0]);
    for (const i of wanted) await rtorrent(c, "f.priority.set", [`${ref.toUpperCase()}:f${i}`, 1]);
    await rtorrent(c, "d.update_priorities", [ref.toUpperCase()]);
  },
  async start(c: ClientCfg, ref: string) {
    await rtorrent(c, "d.open", [ref.toUpperCase()]).catch(() => undefined);
    await rtorrent(c, "d.start", [ref.toUpperCase()]);
  },
  async pause(c: ClientCfg, ref: string) {
    await rtorrent(c, "d.stop", [ref.toUpperCase()]);
  },
};
