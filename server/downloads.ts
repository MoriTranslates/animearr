/**
 * Download-folder rules and clean-up (1.0 takeover).
 *
 * Rules watch AnimeArr's own download folders (its category folders only) and pause grabs when they get too full:
 * - user rules: a metric (size in GB or number of items) over a threshold → pause until under it, pause until
 *   cleared down to a resume-at value, or pause and clean up; scoped to shows, movies or both, and to all grabs or
 *   backlog grabs only (new episodes keep coming); the strictest rule wins;
 * - an always-on free-space rule: under N GB free on the download disk(s) pauses ALL grabs (N editable).
 * The size metric leaves out payloads that are imported and still seeding (toggle, on by default).
 *
 * Clean-up (a plan first; real deletions only when switched on):
 *   retry stuck imports (only when you run it) → remove leftovers of imported downloads (Usenet folders with no
 *   video left; torrents once seeding is done, through qBittorrent) → move unknown folders aside (never deleted).
 * Ownership is decided by the clients themselves (qBittorrent hash, SABnzbd history path), never by a name guess
 * for anything destructive. Torrent payloads are only ever removed through qBittorrent; when the clients can't be
 * read, nothing in their folder is touched.
 */
import fs from "node:fs";
import path from "node:path";
import { logDecision } from "./activity.js";
import { ownSabHistory, ownTorrents, realClients, type OwnTorrent } from "./arr/clients.js";
import { cache, db, dbState } from "./db.js";
import { clientToSonarr, mappedPath } from "./paths.js";
import { ACTIVE, retryImport } from "./pipeline.js";
import { getSettings } from "./settings.js";

export interface FolderRule {
  id: string;
  name: string;
  metric: "sizeGb" | "items";
  threshold: number;
  action: "pauseUntilUnder" | "pauseUntilCleared" | "pauseAndClean";
  resumeAt: number | null;
  scope: "shows" | "movies" | "both";
  applies: "all" | "backlog";
  enabled: boolean;
}

export const PRESETS: Record<string, Omit<FolderRule, "id">[]> = {
  gentle: [
    { name: "Gentle: items", metric: "items", threshold: 20, action: "pauseAndClean", resumeAt: null, scope: "both", applies: "all", enabled: true },
    { name: "Gentle: size", metric: "sizeGb", threshold: 100, action: "pauseAndClean", resumeAt: null, scope: "both", applies: "all", enabled: true },
  ],
  hardStop: [{ name: "Hard stop", metric: "sizeGb", threshold: 500, action: "pauseUntilCleared", resumeAt: 400, scope: "both", applies: "all", enabled: true }],
};

const GB = 1024 ** 3;
const NEW_MS = 14 * 86_400_000;
const VIDEO = /\.(mkv|mp4|m4v|avi|ts|webm)$/i;

type Client = "sabnzbd" | "qbittorrent";
interface Grab { id: number; release: string; client: string | null; client_ref: string | null; state: string; movie_id: number | null }
interface Item { name: string; local: string; arr: string; client: Client; size: number; mtime: number; kind: "show" | "movie" | "unknown"; grab: Grab | null; seeding: boolean; torrent: OwnTorrent | null }
export interface Measure {
  at: number;
  items: Item[];
  byScope: Record<"shows" | "movies" | "both", { sizeGb: number; items: number }>;
  /** The disk the free-space rule watches (label "cache" on Unraid), plus the share's own view (the array) when different. */
  disk: { totalGb: number; freeGb: number; animearrGb: number; otherGb: number; label: string; share: { freeGb: number; totalGb: number } | null } | null;
  errors: string[];
  unreadable: Client[];
}

/** Where /proc/mounts says a path lives: its mount point and filesystem type. */
export function mountOf(p: string, mounts: string): { point: string; type: string } | null {
  let best: { point: string; type: string } | null = null;
  for (const line of mounts.split("\n")) {
    const [, point, type] = line.split(" ");
    if (!point || !type) continue;
    const pt = point.replace(/\\(\d{3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8)));
    // The last mount at a point wins (as in the kernel). Any FUSE union counts as "not the real disk", which only
    // matters when a cache pool is mounted at /unraid/cache.
    if ((p === pt || p.startsWith(pt === "/" ? "/" : `${pt}/`)) && (!best || pt.length >= best.point.length)) best = { point: pt, type };
  }
  return best;
}

export const UNRAID_CACHE = "/unraid/cache";

/**
 * The path whose free space counts: the setting when given; else, when the download folder is on Unraid's FUSE
 * union (shfs) and the cache pool is mounted at /unraid/cache, the cache pool; else the download folder itself.
 */
export function freeSpaceTarget(local: string, mounts?: string, cachePath = UNRAID_CACHE): { path: string; label: string } | null {
  const set = getSettings().downloads.freeSpacePath.trim();
  if (set) return { path: set, label: path.posix.basename(set.replace(/\/+$/, "")) || set };
  if (!fs.existsSync(cachePath)) return null;
  let text = mounts;
  if (text === undefined) {
    try {
      text = fs.readFileSync("/proc/mounts", "utf8");
    } catch {
      return null;
    }
  }
  const m = mountOf(local, text);
  return m && /fuse|shfs/i.test(m.type) ? { path: cachePath, label: "cache" } : null;
}

/** Size of a file or folder, without blocking the server for long (async, a few at a time; symlinks not followed). */
async function sizeOf(p: string): Promise<number> {
  try {
    const st = await fs.promises.lstat(p);
    if (st.isSymbolicLink()) return 0;
    if (!st.isDirectory()) return st.size;
    let total = 0;
    const names = await fs.promises.readdir(p);
    for (let i = 0; i < names.length; i += 8) total += (await Promise.all(names.slice(i, i + 8).map((n) => sizeOf(path.join(p, n))))).reduce((a, b) => a + b, 0);
    return total;
  } catch {
    return 0;
  }
}

/** AnimeArr's category folders, each with its client; a root whose last folder isn't that client's category is skipped. */
function roots() {
  const s = getSettings();
  return (s.importer.sourceRoots ?? [])
    .map((r) => r.replace(/\/+$/, ""))
    .map((arr) => ({ arr, local: mappedPath(arr), client: (/qbittorrent|torrent/i.test(arr) ? "qbittorrent" : "sabnzbd") as Client }))
    .filter((r) => path.posix.basename(r.arr) === (r.client === "qbittorrent" ? s.qbittorrent.category : s.sabnzbd.category));
}

const under = (p: string, root: string) => p === root || p.startsWith(`${root}/`);

let last: Measure | null = null;

export interface MeasureDeps { torrents: typeof ownTorrents; sab: typeof ownSabHistory; mounts?: () => string }
const realDeps: MeasureDeps = { torrents: ownTorrents, sab: ownSabHistory };

/** What's in AnimeArr's download folders, by scope; the download disk's free space. Cached for a minute. */
export async function measure(opts: { fresh?: boolean } = {}, deps: MeasureDeps = realDeps): Promise<Measure> {
  if (!opts.fresh && last && Date.now() - last.at < 60_000) return last;
  const errors: string[] = [];
  const unreadable: Client[] = [];
  let torrents: OwnTorrent[] = [];
  let sab: Awaited<ReturnType<typeof ownSabHistory>> = [];
  try {
    torrents = await deps.torrents();
  } catch (e) {
    errors.push(`qBittorrent: ${(e as Error).message}`);
    unreadable.push("qbittorrent");
  }
  try {
    sab = await deps.sab();
  } catch (e) {
    errors.push(`SABnzbd: ${(e as Error).message}`);
    unreadable.push("sabnzbd");
  }
  const tPaths = torrents.map((t) => ({ t, p: clientToSonarr(t.contentPath).replace(/\/+$/, "") }));
  const sabPaths = sab.map((h) => ({ h, p: clientToSonarr(h.storage).replace(/\/+$/, "") }));
  const grabs = db.prepare("SELECT id, release, client, client_ref, state, movie_id FROM grabs WHERE dry_run = 0 ORDER BY id DESC LIMIT 5000").all() as unknown as Grab[];
  const byRef = new Map(grabs.filter((g) => g.client_ref).map((g) => [g.client_ref!.toLowerCase(), g]));
  const items: Item[] = [];
  for (const r of roots()) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(r.local).filter((n) => !n.startsWith(".animearr-"));
    } catch {
      continue;
    }
    for (const n of names) {
      const local = path.join(r.local, n);
      const arr = `${r.arr}/${n}`;
      let mtime = 0;
      try {
        mtime = fs.statSync(local).mtimeMs;
      } catch {
        continue;
      }
      // Ownership from the client: the torrent whose payload is this item (or inside it, or contains it); the SABnzbd job stored here.
      const t = r.client === "qbittorrent" ? (tPaths.find((x) => x.p === arr || under(x.p, arr) || under(arr, x.p))?.t ?? null) : null;
      const h = r.client === "sabnzbd" ? (sabPaths.find((x) => x.p === arr || under(x.p, arr))?.h ?? null) : null;
      const ref = t?.hash ?? h?.nzoId ?? null;
      const g = ref ? (byRef.get(ref.toLowerCase()) ?? null) : null;
      const size = t ? t.size : await sizeOf(local);
      const done = g?.state === "done";
      items.push({ name: n, local, arr, client: r.client, size, mtime, kind: g ? (g.movie_id ? "movie" : "show") : "unknown", grab: g, seeding: !!t && done && /UP$|uploading/i.test(t.state) && !seedingDone(t), torrent: t });
    }
  }
  const excl = getSettings().downloads.excludeSeeding;
  const counted = items.filter((i) => !(excl && i.seeding));
  const sum = (f: (i: Item) => boolean) => ({ sizeGb: counted.filter(f).reduce((a, i) => a + i.size, 0) / GB, items: counted.filter(f).length });
  // Free space: where downloads really land. On Unraid the download share is a FUSE union (shfs) that reports the
  // whole array; a cache-first share fills the cache pool first, so that's the one that counts.
  let disk: Measure["disk"] = null;
  const ours = items.reduce((a, i) => a + i.size, 0) / GB;
  const stat = (p: string) => {
    const st = fs.statfsSync(p);
    return { totalGb: (st.blocks * st.bsize) / GB, freeGb: (st.bavail * st.bsize) / GB };
  };
  for (const r of roots()) {
    if (!fs.existsSync(r.local)) continue;
    try {
      const share = stat(r.local);
      let target = freeSpaceTarget(r.local, deps.mounts?.());
      let at = share;
      if (target)
        try {
          at = stat(target.path);
        } catch (e) {
          errors.push(`free space at ${target.path}: ${(e as Error).message}; measuring the download folder instead`);
          target = null;
        }
      if (!disk || at.freeGb < disk.freeGb)
        disk = { totalGb: at.totalGb, freeGb: at.freeGb, animearrGb: ours, otherGb: Math.max(0, at.totalGb - at.freeGb - ours), label: target?.label ?? "download disk", share: target ? { freeGb: share.freeGb, totalGb: share.totalGb } : null };
    } catch (e) {
      errors.push(`free space: ${(e as Error).message}`);
    }
  }
  last = { at: Date.now(), items, byScope: { shows: sum((i) => i.kind !== "movie"), movies: sum((i) => i.kind === "movie"), both: sum(() => true) }, disk, errors, unreadable };
  return last;
}

// ---------------------------------------------------------------- rules → paused or not

interface RuleState { paused: boolean; since: number | null; value: number; name: string }
const ruleState = new Map<string, RuleState>();

/** Evaluates the rules against a measurement (pause-until-cleared keeps its pause until the resume-at value). */
export function evaluate(m: Measure, now = Date.now()) {
  const s = getSettings().downloads;
  const out: (RuleState & { id: string; rule: FolderRule | null })[] = [];
  const freeLow = !!m.disk && m.disk.freeGb < s.freeSpaceGb;
  out.push({ id: "free-space", name: `Free space under ${s.freeSpaceGb} GB`, rule: null, paused: freeLow, since: freeLow ? (ruleState.get("free-space")?.since ?? now) : null, value: m.disk?.freeGb ?? -1 });
  for (const r of s.rules) {
    if (!r.enabled) continue;
    const v = m.byScope[r.scope][r.metric];
    const prev = ruleState.get(r.id);
    let paused = v > r.threshold;
    if (!paused && r.action === "pauseUntilCleared" && prev?.paused) paused = v > (r.resumeAt ?? r.threshold);
    out.push({ id: r.id, name: r.name, rule: r, paused, since: paused ? (prev?.since ?? now) : null, value: v });
  }
  for (const o of out) {
    const prev = ruleState.get(o.id);
    if (!!prev?.paused !== o.paused)
      logDecision("info", { why: o.paused ? `Grabs paused by the download-folder rule "${o.name}" (now ${o.value.toFixed(o.rule?.metric === "items" ? 0 : 1)})` : `Download-folder rule "${o.name}" no longer pauses grabs` });
  }
  // Rules that were deleted or switched off don't linger.
  ruleState.clear();
  for (const o of out) ruleState.set(o.id, { paused: o.paused, since: o.since, value: o.value, name: o.name });
  return out;
}

/** After the settings changed: re-evaluate the last measurement at once. */
export function reevaluate() {
  if (last) evaluate(last);
}

export interface GateOpts { manual?: boolean }

/**
 * Is a new grab allowed? kind = show/movie; isNew = a recent episode/movie (backlog-only rules let those through).
 * The free-space rule applies to everything; a grab the user starts by hand may pass the folder rules.
 */
export function grabGate(kind: "show" | "movie", isNew: boolean, opts: GateOpts = {}): { paused: false } | { paused: true; why: string } {
  const s = getSettings().downloads;
  if (ruleState.get("free-space")?.paused) return { paused: true, why: `the download disk has under ${s.freeSpaceGb} GB free (all grabs wait until there's room)` };
  if (opts.manual) return { paused: false };
  for (const r of s.rules) {
    if (!r.enabled || !ruleState.get(r.id)?.paused) continue;
    if (r.scope !== "both" && r.scope !== (kind === "show" ? "shows" : "movies")) continue;
    if (r.applies === "backlog" && isNew) continue;
    return { paused: true, why: `the download-folder rule "${r.name}" pauses ${r.applies === "backlog" ? "backlog " : ""}grabs` };
  }
  return { paused: false };
}

/** Whether a grab for these episodes counts as "new" (every episode aired in the last 14 days). */
export function episodesAreNew(episodeIds: number[], now = Date.now()) {
  if (!episodeIds.length) return false;
  const rows = cache.prepare(`SELECT air_utc FROM episodes WHERE id IN (${episodeIds.map(() => "?").join(",")})`).all(...episodeIds) as { air_utc: number | null }[];
  return rows.length > 0 && rows.every((r) => r.air_utc !== null && now - r.air_utc < NEW_MS);
}

export class GrabsPausedError extends Error {
  statusCode = 409;
}

// ---------------------------------------------------------------- clean-up

export interface CleanupAction { step: "retry" | "leftover" | "quarantine"; target: string; why: string; bytes: number; grabId: number | null; client: Client; ref: string | null; destructive: boolean }

function seedingDone(t: OwnTorrent, now = Date.now()) {
  const s = getSettings().downloads;
  if (/^(pausedUP|stoppedUP)$/.test(t.state)) return true;
  const days = t.seedingTimeSec / 86400;
  return (t.ratio >= s.minRatio && days >= s.minSeedDays) || days >= s.maxSeedDays || (t.completedOn !== null && now - t.completedOn > s.maxSeedDays * 86_400_000);
}

const NOT_RETRYABLE = /paused for a review|restarted|outside the allowed|several large|couldn't tell|two files|can't reach|archive|not from AnimeArr|only a manual import/i;
const retried = new Set<number>();

/** The clean-up plan for AnimeArr's own download folders. Nothing is changed. */
export async function cleanupPlan(deps: MeasureDeps = realDeps, now = Date.now(), opts: { includeRetry?: boolean } = { includeRetry: true }): Promise<{ actions: CleanupAction[]; measure: Measure }> {
  const m = await measure({ fresh: true }, deps);
  const actions: CleanupAction[] = [];
  // 1. Stuck imports (only transient problems, once per grab, only when the user runs the clean-up).
  if (opts.includeRetry) {
    const stuck = db.prepare("SELECT id, release, updated_at, error FROM grabs WHERE state = 'needs-attention' AND dry_run = 0").all() as { id: number; release: string; updated_at: number; error: string | null }[];
    for (const g of stuck) {
      if (now - g.updated_at < 3_600_000 || retried.has(g.id) || NOT_RETRYABLE.test(g.error ?? "")) continue;
      const it = m.items.find((i) => i.grab?.id === g.id);
      if (it) actions.push({ step: "retry", target: g.release, why: `the import got stuck (${(g.error ?? "").slice(0, 80)}); try it once more`, bytes: 0, grabId: g.id, client: it.client, ref: null, destructive: false });
    }
  }
  // Pending grabs whose folder the clients don't account for: then unknown folders might be theirs; nothing is moved aside.
  const pending = db.prepare(`SELECT COUNT(*) AS n FROM grabs WHERE dry_run = 0 AND state IN (${[...ACTIVE, "needs-attention"].map(() => "?").join(",")})`).get(...ACTIVE, "needs-attention") as { n: number };
  for (const i of m.items) {
    if (m.unreadable.includes(i.client)) continue; // can't tell what's whose: hands off
    if (i.grab?.state === "done") {
      if (i.client === "qbittorrent") {
        if (i.torrent && seedingDone(i.torrent, now))
          actions.push({ step: "leftover", target: i.arr, why: `imported, and seeding is done (ratio ${i.torrent.ratio.toFixed(2)}, ${Math.round(i.torrent.seedingTimeSec / 86400)} days); removed through qBittorrent`, bytes: i.size, grabId: i.grab.id, client: "qbittorrent", ref: i.torrent.hash, destructive: true });
        continue;
      }
      // Usenet: only when no video is left (a pack's unimported extras stay for you to look at).
      const videos = listVideos(i.local);
      if (videos.length) continue;
      actions.push({ step: "leftover", target: i.arr, why: "imported; only leftovers (no video) remain", bytes: i.size, grabId: i.grab.id, client: "sabnzbd", ref: i.grab.client_ref, destructive: true });
      continue;
    }
    // Unknown to both clients and to AnimeArr: moved aside, never deleted — but never a torrent's data, never anything
    // recent or still being unpacked, and not while a grab is waiting whose folder the clients don't show.
    if (i.grab || i.torrent || i.client === "qbittorrent") continue;
    if (/^_(UNPACK|FAILED)_/i.test(i.name) || now - i.mtime < 86_400_000 || pending.n > 0) continue;
    actions.push({ step: "quarantine", target: i.arr, why: "neither SABnzbd nor AnimeArr knows this folder; moved aside (not deleted) for you to look at", bytes: i.size, grabId: null, client: i.client, ref: null, destructive: false });
  }
  return { actions, measure: m };
}

function listVideos(local: string, depth = 0): string[] {
  try {
    const st = fs.lstatSync(local);
    if (st.isSymbolicLink()) return [];
    if (!st.isDirectory()) return VIDEO.test(local) ? [local] : [];
    if (depth > 4) return [local]; // too deep to tell: treat as "has video"
    return fs.readdirSync(local).flatMap((n) => listVideos(path.join(local, n), depth + 1));
  } catch {
    return [local];
  }
}

/**
 * Carries out the clean-up. Deletions only when switched on (downloads.allowDelete); retries and moving aside
 * (no data lost) otherwise. Re-checks every step right before acting.
 */
export async function runCleanup(opts: { only?: CleanupAction["step"][]; userAsked?: boolean } = {}, deps: MeasureDeps & { remove: typeof realClients.remove } = { ...realDeps, remove: realClients.remove }) {
  if (dbState.corrupt) throw Object.assign(new Error("The database failed its integrity check"), { statusCode: 503 });
  const s = getSettings().downloads;
  const { actions } = await cleanupPlan(deps, Date.now(), { includeRetry: !!opts.userAsked });
  const rootsLocal = roots().map((r) => r.local);
  const inside = (local: string) => rootsLocal.some((r) => path.resolve(local).startsWith(path.resolve(r) + path.sep));
  const done: { action: CleanupAction; ok: boolean; why: string }[] = [];
  for (const a of actions) {
    if (opts.only && !opts.only.includes(a.step)) continue;
    if (a.destructive && !s.allowDelete) {
      done.push({ action: a, ok: false, why: "deleting isn't switched on (the first clean-up is being reviewed)" });
      continue;
    }
    try {
      const local = mappedPath(a.target);
      if (a.step !== "retry" && !inside(local)) throw new Error("outside AnimeArr's own download folders");
      if (a.grabId && a.step !== "retry") {
        const g = db.prepare("SELECT state FROM grabs WHERE id = ?").get(a.grabId) as { state: string } | undefined;
        if (g?.state !== "done") throw new Error("its grab isn't finished any more; left alone");
      }
      if (a.step === "retry") {
        retried.add(a.grabId!);
        retryImport(a.grabId!);
      } else if (a.step === "leftover" && a.client === "qbittorrent") await deps.remove({ client: "qbittorrent", ref: a.ref! });
      else if (a.step === "leftover") fs.rmSync(local, { recursive: true, force: true });
      else if (a.step === "quarantine") {
        const root = rootsLocal.find((r) => path.resolve(local).startsWith(path.resolve(r) + path.sep))!;
        const q = path.join(root, ".animearr-quarantine");
        fs.mkdirSync(q, { recursive: true });
        let target = path.join(q, path.basename(local));
        if (fs.existsSync(target)) target = `${target}.${new Date().toISOString().replace(/[:.]/g, "-")}`;
        fs.renameSync(local, target);
      }
      done.push({ action: a, ok: true, why: "done" });
    } catch (e) {
      done.push({ action: a, ok: false, why: (e as Error).message });
    }
  }
  const ok = done.filter((d) => d.ok);
  if (ok.length) logDecision("info", { why: `Download clean-up: ${ok.length} step(s) — ${ok.slice(0, 5).map((d) => `${d.action.step} ${path.posix.basename(d.action.target)}`).join(", ")}${ok.length > 5 ? "…" : ""} (${(ok.reduce((x, d) => x + d.action.bytes, 0) / GB).toFixed(1)} GB)` });
  last = null;
  return done;
}

/** Every few minutes: measure, evaluate; a pause-and-clean rule that fires runs the clean-up (as far as allowed). */
export async function downloadsTick() {
  if (dbState.corrupt) return;
  const m = await measure({ fresh: true });
  const states = evaluate(m);
  const s = getSettings().downloads;
  if (s.cleanup === "auto" && states.some((x) => x.paused && x.rule?.action === "pauseAndClean")) await runCleanup().catch(() => undefined);
}

export function downloadsStatus() {
  const g = grabGate("show", false);
  const gm = grabGate("movie", false);
  const why = g.paused ? g.why : gm.paused ? gm.why : null;
  return { measure: last ? { byScope: last.byScope, disk: last.disk, errors: last.errors } : null, rules: [...ruleState.entries()].map(([id, st]) => ({ id, ...st })), paused: !!why, why };
}
