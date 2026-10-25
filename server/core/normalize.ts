/**
 * Title normalisation for the alias index (PROPOSAL §6.2).
 *
 * Every title gets a "compact key": NFKC, lowercase, diacritics stripped, punctuation and spaces removed. That makes
 * `Quanzhi Fashi` = `Quan Zhi Fa Shi` = `Quan.Zhi.Fa.Shi` = `quanzhifashi`. A trailing season marker (`VII`, `2nd Season`,
 * `S7`, `Season 7`, `Part 2`, `第7季`) is split off so the base title and the season can be looked up separately.
 */

const ROMAN: Record<string, number> = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 };

/** NFKC + lowercase + strip diacritics + "&" → "and", punctuation → space, collapsed. Keeps CJK characters. */
export function normalizeTitle(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .normalize("NFC")
    .replace(/[’'`´]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Spaceless key: `Quan.Zhi.Fa.Shi` → `quanzhifashi`. */
export function compactKey(s: string): string {
  return normalizeTitle(s).replace(/ /g, "");
}

export interface SeasonSplit {
  /** Normalised base title without the season marker. */
  base: string;
  season: number | null;
  /** "part" for Part N / Cour N (a split cour of one TVDB season), "season" otherwise. */
  kind: "season" | "part" | null;
}

/**
 * Splits a trailing season marker off a title. Works on the normalised form, so callers can pass raw titles.
 * Only clear markers are taken: a bare trailing number (`Series Title 2`) is ambiguous (`86`, `Mob Psycho 100`) and is
 * returned as `season: null` here; the alias index stores that variant separately.
 */
export function splitSeason(title: string): SeasonSplit {
  // CJK markers before normalising (normalisation keeps the characters but the digit forms vary).
  const cjk = title.normalize("NFKC").match(/^(.*?)\s*第\s*([0-9一二三四五六七八九十]+)\s*[季期部]\s*$/);
  if (cjk) return { base: normalizeTitle(cjk[1]), season: cjkNumber(cjk[2]), kind: "season" };
  const n = normalizeTitle(title);
  let m = n.match(/^(.*\S)\s+(\d{1,2})(?:st|nd|rd|th)\s+season$/);
  if (m) return { base: m[1], season: Number(m[2]), kind: "season" };
  m = n.match(/^(.*\S)\s+season\s+(\d{1,2})$/);
  if (m) return { base: m[1], season: Number(m[2]), kind: "season" };
  m = n.match(/^(.*\S)\s+s(\d{1,2})$/);
  if (m) return { base: m[1], season: Number(m[2]), kind: "season" };
  m = n.match(/^(.*\S)\s+(?:part|cour)\s+(\d{1,2}|ii|iii|iv)$/);
  if (m) return { base: m[1], season: /^\d+$/.test(m[2]) ? Number(m[2]) : ROMAN[m[2]], kind: "part" };
  m = n.match(/^(.*\S)\s+(ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii)$/);
  // Single-letter "v"/"x" endings are usually words or titles ("Dragon Ball X"?) only when the base is long enough.
  if (m && (m[2].length > 1 || m[1].length >= 6)) return { base: m[1], season: ROMAN[m[2]], kind: "season" };
  m = n.match(/^(.*\S)\s+(second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+season$/);
  if (m) return { base: m[1], season: ["second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"].indexOf(m[2]) + 2, kind: "season" };
  return { base: n, season: null, kind: null };
}

function cjkNumber(s: string): number {
  if (/^\d+$/.test(s)) return Number(s);
  const d = "一二三四五六七八九";
  if (s === "十") return 10;
  if (s.startsWith("十")) return 10 + d.indexOf(s[1]) + 1;
  if (s.endsWith("十")) return (d.indexOf(s[0]) + 1) * 10;
  if (s.includes("十")) return (d.indexOf(s[0]) + 1) * 10 + d.indexOf(s[2]) + 1;
  return d.indexOf(s) + 1;
}

/** Trailing "(2014)" / " 2014" year, removed for an extra lookup key. */
export function stripYear(title: string): string {
  return title.replace(/\s*[([]?(19[5-9]\d|20[0-4]\d)[)\]]?\s*$/, "").trim();
}

/** All lookup keys for a title: the full compact key, without year, and the season-split base (with its season). */
export function lookupKeys(title: string): { key: string; season: number | null }[] {
  const out = new Map<string, number | null>();
  const add = (k: string, season: number | null) => {
    if (k && !out.has(k)) out.set(k, season);
  };
  add(compactKey(title), null);
  const noYear = stripYear(title);
  if (noYear !== title) add(compactKey(noYear), null);
  const split = splitSeason(noYear);
  if (split.season !== null) add(split.base.replace(/ /g, ""), split.season);
  return [...out].map(([key, season]) => ({ key, season }));
}
