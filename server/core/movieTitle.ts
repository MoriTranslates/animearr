/**
 * Movie title normalisation and "which subtitle tells this movie apart" (shared by the movie search and the importer).
 *
 * A franchise movie or special ("Date A Live: Date to Date", "Date A Live Mayuri Judgement") shares its franchise name
 * with the TV series. A release or file that only carries the franchise name is most likely the series (a season batch);
 * one that names the subtitle is the movie.
 */
import { parseRelease } from "./parser.js";

const ROMAN: Record<string, string> = { i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10" };
export const MARKER = /\b(the movie|movie|gekijouban|gekijoban|eiga|film)\b|劇場版|映画/gi;

/** Lower-case, accents and punctuation removed, "the movie"/"gekijouban" dropped, roman numerals as digits. */
export function normTitle(t: string) {
  return t
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(MARKER, " ")
    .replace(/[^\p{L}\p{N}.]+/gu, " ")
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w === "part" ? "" : (ROMAN[w] ?? w)))
    .filter(Boolean)
    .join(" ");
}

/** A subtitle worth requiring: has a word of 2+ letters (not just a number or "the movie"). */
const meaningful = (s: string) => !!s && s.split(" ").some((w) => /\p{L}{2,}/u.test(w));

/**
 * The distinguishing subtitles of a movie, normalised: the part after ":" / " - " / "~" in any of its titles, and the
 * part after a franchise name (a linked series title) that a title starts with.
 * Empty = the movie has no subtitle (its title alone is the name).
 */
export function movieSubtitles(titles: string[], franchise: string[] = []): string[] {
  const out = new Set<string>();
  const heads = franchise.map(normTitle).filter(Boolean);
  for (const t of titles.filter(Boolean)) {
    const parts = t.split(/\s*[:：]\s*|\s+[-–—~～]\s+|\s*[～〜]\s*/u).filter((x) => normTitle(x));
    if (parts.length >= 2) {
      const sub = normTitle(parts.slice(1).join(" "));
      if (meaningful(sub)) out.add(sub);
    }
    const n = normTitle(t);
    for (const h of heads) {
      if (h === n || !n.startsWith(`${h} `)) continue;
      const sub = n.slice(h.length + 1);
      if (meaningful(sub)) out.add(sub);
    }
  }
  // Keep the shortest forms only ("date to date" covers "date to date special").
  const all = [...out];
  return all.filter((s) => !all.some((o) => o !== s && ` ${s} `.includes(` ${o} `)));
}

/** Does a name (a release title or a file name) carry one of the subtitles? */
export function namesSubtitle(name: string, subtitles: string[]) {
  const n = ` ${normTitle(name.replace(/[._]/g, " "))} `;
  return subtitles.some((s) => n.includes(` ${s} `));
}

/**
 * Several big files in a movie download: the one whose name carries the movie's subtitle (e.g. a season batch that
 * bundles the "Date to Date" special in Specials/). Null when no single file names it.
 */
export function fileForMovie<T extends { path: string }>(files: T[], subtitles: string[]): T | null {
  if (!subtitles.length) return null;
  const hits = files.filter((f) => namesSubtitle(f.path.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, ""), subtitles));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * The big files of a movie download look like numbered episodes of a series (3+ files with different episode numbers):
 * a season batch, not the movie.
 */
export function looksLikeEpisodes(files: { path: string }[]) {
  const nums = new Set<number>();
  let numbered = 0;
  for (const f of files) {
    const p = parseRelease(f.path.split(/[\\/]/).pop()!);
    const n = p.episodes[0] ?? p.absolute[0] ?? null;
    if (n === null) continue;
    numbered++;
    nums.add(n);
  }
  return numbered >= 3 && nums.size >= 3 && numbered >= files.length * 0.6;
}
