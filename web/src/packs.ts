/**
 * Release search results split into season packs and single episodes, packs ranked for Replace season, and each
 * release's quality compared with what the library has now. No DOM here (unit-tested).
 */

/** A release's (or a file's) quality as the parser reads it: source, resolution, remux. */
export interface Quality { source: string | null; resolution: number | string | null; remux?: boolean }
export type Verdict = "up" | "same" | "down" | "unknown";

/** Plain source ladder: TV < WEB < Blu-ray encode < Blu-ray remux. */
const STEP: Record<string, number> = { hdtv: 1, tv: 1, dvd: 1, web: 2, bluray: 3 };
const NAME = ["", "TV", "WEB-DL", "Blu-ray", "Blu-ray remux"];

/** The source's step on the ladder (0 = unknown). Accepts the parser's keys or the library's labels ("BluRay"). */
export function step(q: Quality): number {
  const s = STEP[(q.source ?? "").toLowerCase().replace(/[^a-z]/g, "")] ?? 0;
  return s === 3 && q.remux ? 4 : s;
}

/** Height in lines from 1080, "1080p", "1920x1036" or Sonarr's "WEBDL-1080p" (cropped widescreen counts by width). */
export function height(r: Quality["resolution"]): number | null {
  if (typeof r === "number") return r || null;
  if (!r) return null;
  const wh = /(\d{3,4})\s*x\s*(\d{3,4})/i.exec(r);
  if (wh) {
    const w = Number(wh[1]);
    return w >= 3800 ? 2160 : w >= 1800 ? 1080 : w >= 1200 ? 720 : w >= 900 ? 576 : 480;
  }
  const p = /(\d{3,4})[pi]\b/i.exec(r) ?? /^(\d{3,4})$/.exec(r.trim());
  return p ? Number(p[1]) : null;
}

export function qualityName(q: Quality, withRes = true): string {
  const s = NAME[step(q)] || "?";
  const h = height(q.resolution);
  return withRes && h ? `${s} ${h}p` : s;
}

export interface LibraryQuality { main: Quality; files: number; /** Per source, most files first (more than one = mixed). */ bySource: { name: string; n: number }[] }

/** What the season has now: the most common source × resolution, and the per-source counts. */
export function libraryQuality(rows: (Quality & { n: number })[]): LibraryQuality | null {
  const known = rows.filter((r) => step(r) > 0);
  if (!known.length) return null;
  const merged = new Map<string, { q: Quality; n: number }>();
  for (const r of known) {
    const k = `${step(r)}|${height(r.resolution)}`;
    merged.set(k, { q: merged.get(k)?.q ?? r, n: (merged.get(k)?.n ?? 0) + r.n });
  }
  const main = [...merged.values()].sort((a, b) => b.n - a.n || step(a.q) - step(b.q))[0].q;
  const bySource = new Map<string, number>();
  for (const r of known) bySource.set(qualityName(r, false), (bySource.get(qualityName(r, false)) ?? 0) + r.n);
  return { main, files: known.reduce((a, r) => a + r.n, 0), bySource: [...bySource.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n) };
}

/** Better, same or lower than what you have: source first, then resolution. */
export function compareQuality(release: Quality | null | undefined, have: Quality | null | undefined): { verdict: Verdict; from: string; to: string } {
  if (!release || !have || !step(release) || !step(have)) return { verdict: "unknown", from: "", to: "" };
  const a = step(release);
  const b = step(have);
  const ha = height(release.resolution);
  const hb = height(have.resolution);
  const d = a !== b ? a - b : ha && hb ? ha - hb : 0;
  // Same source: the resolution is the difference, so name it.
  const res = a === b;
  return { verdict: d > 0 ? "up" : d < 0 ? "down" : "same", from: qualityName(have, res || d === 0), to: qualityName(release, res || d === 0) };
}

interface Result { episodeIds: number[]; quality?: Quality }
export interface Pack<T> { r: T; covered: number; total: number; whole: boolean; /** Episode numbers covered, as ranges ("1–6, 8"). */ episodes: string }

/** "1–6, 8, 10–12" */
export function ranges(nums: number[]): string {
  const s = [...new Set(nums)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(j > i ? `${s[i]}–${s[j]}` : `${s[i]}`);
    i = j;
  }
  return out.join(", ");
}

const ORDER: Record<Verdict, number> = { up: 0, same: 1, unknown: 1, down: 2 };

/**
 * Season packs (2+ of the asked-for episodes; for a one-episode search, any multi-episode release) and single episodes.
 * Packs: whole season first, then upgrades before same before lower quality, then the server's order (accept, score).
 */
export function splitPacks<T extends Result>(results: T[], targets: { id: number; episode: number }[], have?: Quality | null): { packs: Pack<T>[]; singles: T[] } {
  const num = new Map(targets.map((x) => [x.id, x.episode]));
  const packs: (Pack<T> & { i: number; v: number })[] = [];
  const singles: T[] = [];
  results.forEach((r, i) => {
    const mine = r.episodeIds.filter((id) => num.has(id));
    if (mine.length >= 2 || (targets.length === 1 && r.episodeIds.length >= 2))
      packs.push({ r, covered: mine.length, total: targets.length, whole: mine.length === targets.length, episodes: ranges(mine.map((id) => num.get(id)!)), i, v: ORDER[compareQuality(r.quality, have).verdict] });
    else singles.push(r);
  });
  packs.sort((a, b) => b.covered - a.covered || a.v - b.v || a.i - b.i);
  return { packs: packs.map(({ i: _i, v: _v, ...p }) => p), singles };
}
