/**
 * Poster thumbnails: covers come from AniList, TMDB and TVDB at full size (TMDB "original" posters are ~300 KB each,
 * AniList "large" ~100–260 KB), which made poster-heavy pages slow. The web app asks for a size; this picks the
 * provider's own smaller rendition and serves it from a disk cache on the LAN with a long Cache-Control and ETag.
 * Only known image hosts (no open proxy), only images, size-capped.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "./db.js";

export type ThumbSize = "sm" | "md" | "lg" | "xl";
/** Pixel widths per size (sharp on 3× phones: a 48 px slot gets 144 px). */
export const WIDTH: Record<ThumbSize, number> = { sm: 144, md: 300, lg: 480, xl: 960 };

/** Resizes to WebP with ffmpeg (already in the image for ffprobe); null when that isn't possible (then the original is kept). */
export function ffmpegResize(buf: Buffer, width: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-protocol_whitelist", "pipe", "-f", "image2pipe", "-i", "pipe:0", "-vf", `scale='min(${width},iw)':-2`, "-frames:v", "1", "-c:v", "libwebp", "-quality", "78", "-f", "webp", "pipe:1"], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return resolve(null);
    }
    const out: Buffer[] = [];
    const timer = setTimeout(() => p.kill("SIGKILL"), 15_000);
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.on("error", () => (clearTimeout(timer), resolve(null)));
    p.on("close", (code) => {
      clearTimeout(timer);
      const b = Buffer.concat(out);
      resolve(code === 0 && b.length > 0 ? b : null);
    });
    p.stdin.on("error", () => undefined);
    p.stdin.end(buf);
  });
}
const HOSTS = new Set(["s4.anilist.co", "image.tmdb.org", "artworks.thetvdb.com", "thetvdb.com"]);
const DIR = path.join(CONFIG_DIR, "imgcache");
const MAX_BYTES = 3_000_000;
const MAX_CACHE = 600 * 1024 * 1024; // pruned (oldest first) above this

/** The provider's rendition for a size: AniList medium/large/extraLarge, TMDB w154/w342/w500/w780. */
export function sizedUrl(u: string, size: ThumbSize): string {
  if (/s4\.anilist\.co\/.*\/cover\/(?:small|medium|large|extraLarge)\//i.test(u)) return u.replace(/\/cover\/(?:small|medium|large|extraLarge)\//i, `/cover/${size === "sm" || size === "md" ? "medium" : size === "lg" ? "large" : "extraLarge"}/`);
  if (/image\.tmdb\.org\/t\/p\/(?:original|w\d+)\//.test(u)) return u.replace(/\/t\/p\/(?:original|w\d+)\//, `/t/p/${size === "sm" ? "w154" : size === "md" ? "w185" : size === "lg" ? "w342" : "w500"}/`);
  // TVDB keeps a ~340 px "_t" thumbnail next to each artwork.
  if ((size === "sm" || size === "md") && /artworks\.thetvdb\.com\/banners\/.+(?<!_t)\.(?:jpg|png)$/i.test(u)) return u.replace(/\.(jpg|png)$/i, "_t.$1");
  return u;
}

export function allowedImage(u: string) {
  try {
    const x = new URL(u);
    return x.protocol === "https:" && HOSTS.has(x.hostname);
  } catch {
    return false;
  }
}

const inflight = new Map<string, Promise<{ file: string; type: string } | null>>();
/** Raster types only (an SVG could carry script and would be served from AnimeArr's origin). */
const TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
/** Recent failures aren't refetched for 10 minutes. */
const failed = new Map<string, number>();
/** At most 4 fetch+resize jobs at once (a cold poster grid asks for hundreds). */
let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 4) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** Fetches without following redirects off the allowed hosts; reads at most MAX_BYTES. */
async function fetchImage(url: string, f: typeof fetch): Promise<{ type: string; buf: Buffer } | null> {
  let cur = url;
  for (let hop = 0; hop < 4; hop++) {
    if (!allowedImage(cur)) return null;
    const res = await f(cur, { signal: AbortSignal.timeout(15_000), redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return null;
      cur = new URL(loc, cur).href;
      continue;
    }
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!TYPES.has(type)) return null;
    if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) return null;
    if (!res.body) return { type, buf: Buffer.from(await res.arrayBuffer()) };
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
      n += c.length;
      if (n > MAX_BYTES) return null;
      chunks.push(Buffer.from(c));
    }
    return { type, buf: Buffer.concat(chunks) };
  }
  return null;
}

/** The cached file for a cover at a size (fetched once; concurrent requests share the fetch). */
export async function thumb(u: string, size: ThumbSize, deps: { fetch: typeof fetch; resize?: (b: Buffer, w: number) => Promise<Buffer | null> } = { fetch, resize: ffmpegResize }): Promise<{ file: string; type: string; etag: string } | null> {
  if (!allowedImage(u)) return null;
  const src = sizedUrl(u, size);
  const key = crypto.createHash("sha1").update(`${src}|${WIDTH[size]}`).digest("hex");
  const file = path.join(DIR, key.slice(0, 2), key);
  const meta = `${file}.type`;
  if (fs.existsSync(file) && fs.existsSync(meta)) return { file, type: fs.readFileSync(meta, "utf8"), etag: `"${key}"` };
  if ((failed.get(key) ?? 0) > Date.now()) return null;
  let p = inflight.get(key);
  if (!p) {
    p = slot(async () => {
      // A rendition the provider doesn't have: fall back to the original URL.
      const got = (await fetchImage(src, deps.fetch)) ?? (src !== u ? await fetchImage(u, deps.fetch) : null);
      if (!got) return null;
      let { type, buf } = got;
      // Shrunk to the slot's width as WebP (AniList's covers are PNG/JPG of 100–260 KB even at "medium").
      const small = deps.resize ? await deps.resize(buf, WIDTH[size]) : null;
      if (small && small.length < buf.length) (buf = small), (type = "image/webp");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, buf);
      fs.renameSync(`${file}.tmp`, file);
      fs.writeFileSync(meta, type);
      pruneSoon();
      return { file, type };
    })
      .catch(() => null)
      .then((r) => {
        if (!r) {
          failed.set(key, Date.now() + 10 * 60_000);
          if (failed.size > 5000) failed.clear();
        }
        return r;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  const r = await p;
  return r ? { ...r, etag: `"${key}"` } : null;
}

let pruneTimer: NodeJS.Timeout | null = null;
function pruneSoon() {
  if (pruneTimer) return;
  pruneTimer = setTimeout(() => {
    pruneTimer = null;
    try {
      const files: { f: string; size: number; at: number }[] = [];
      for (const d of fs.readdirSync(DIR)) for (const f of fs.readdirSync(path.join(DIR, d))) {
        if (f.endsWith(".type") || f.endsWith(".tmp")) continue;
        const st = fs.statSync(path.join(DIR, d, f));
        files.push({ f: path.join(DIR, d, f), size: st.size, at: st.atimeMs });
      }
      let total = files.reduce((n, x) => n + x.size, 0);
      for (const x of files.sort((a, b) => a.at - b.at)) {
        if (total <= MAX_CACHE) break;
        fs.rmSync(x.f, { force: true });
        fs.rmSync(`${x.f}.type`, { force: true });
        total -= x.size;
      }
    } catch {
      /* best effort */
    }
  }, 60_000);
  pruneTimer.unref?.();
}
