/**
 * Poster thumbnails: covers come from AniList, TMDB and TVDB at full size (TMDB "original" posters are ~300 KB each,
 * AniList "large" ~100–260 KB), which made poster-heavy pages slow. The web app asks for a size; this picks the
 * provider's own smaller rendition and serves it from a disk cache on the LAN with a long Cache-Control and ETag.
 * Only known image hosts (no open proxy), only images, size-capped.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "./db.js";

export type ThumbSize = "sm" | "md" | "lg" | "xl";
const HOSTS = new Set(["s4.anilist.co", "image.tmdb.org", "artworks.thetvdb.com", "thetvdb.com"]);
const DIR = path.join(CONFIG_DIR, "imgcache");
const MAX_BYTES = 3_000_000;
const MAX_CACHE = 600 * 1024 * 1024; // pruned (oldest first) above this

/** The provider's rendition for a size: AniList medium/large/extraLarge, TMDB w154/w342/w500/w780. */
export function sizedUrl(u: string, size: ThumbSize): string {
  if (/s4\.anilist\.co\/.*\/cover\/(?:small|medium|large|extraLarge)\//i.test(u)) return u.replace(/\/cover\/(?:small|medium|large|extraLarge)\//i, `/cover/${size === "sm" || size === "md" ? "medium" : size === "lg" ? "large" : "extraLarge"}/`);
  if (/image\.tmdb\.org\/t\/p\/(?:original|w\d+)\//.test(u)) return u.replace(/\/t\/p\/(?:original|w\d+)\//, `/t/p/${size === "sm" ? "w154" : size === "md" ? "w185" : size === "lg" ? "w342" : "w500"}/`);
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

/** The cached file for a cover at a size (fetched once; concurrent requests share the fetch). */
export async function thumb(u: string, size: ThumbSize, deps = { fetch }): Promise<{ file: string; type: string; etag: string } | null> {
  if (!allowedImage(u)) return null;
  const src = sizedUrl(u, size);
  const key = crypto.createHash("sha1").update(src).digest("hex");
  const file = path.join(DIR, key.slice(0, 2), key);
  const meta = `${file}.type`;
  if (fs.existsSync(file) && fs.existsSync(meta)) return { file, type: fs.readFileSync(meta, "utf8"), etag: `"${key}"` };
  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      let res = await deps.fetch(src, { signal: AbortSignal.timeout(15_000) });
      // A rendition the provider doesn't have: fall back to the original URL.
      if (!res.ok && src !== u) res = await deps.fetch(u, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return null;
      const type = res.headers.get("content-type") ?? "";
      if (!/^image\//.test(type)) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES) return null;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, buf);
      fs.renameSync(`${file}.tmp`, file);
      fs.writeFileSync(meta, type);
      pruneSoon();
      return { file, type };
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  const r = await p.catch(() => null);
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
