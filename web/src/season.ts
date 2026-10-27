/**
 * The anime season drives the default accent (Direction C): Winter (yuki), Spring (sakura), Summer (ramune),
 * Fall (momiji). A show's own AniList cover colour (Direction A) takes over on its pages, clamped for contrast.
 */
export type SeasonKey = "winter" | "spring" | "summer" | "fall";

export interface Season { key: SeasonKey; kanji: string; name: string; year: number; week: number; weeks: number; start: number }

const KANJI: Record<SeasonKey, string> = { winter: "冬", spring: "春", summer: "夏", fall: "秋" };
const NAME: Record<SeasonKey, string> = { winter: "Winter", spring: "Spring", summer: "Summer", fall: "Fall" };

export function seasonOf(ms = Date.now()): Season {
  const d = new Date(ms);
  const q = Math.floor(d.getMonth() / 3);
  const key = (["winter", "spring", "summer", "fall"] as SeasonKey[])[q];
  const start = new Date(d.getFullYear(), q * 3, 1).getTime();
  const week = Math.min(13, Math.max(1, Math.floor((ms - start) / (7 * 86_400_000)) + 1));
  return { key, kanji: KANJI[key], name: NAME[key], year: d.getFullYear(), week, weeks: 13, start };
}

/** Accent sets per season: [accent, accent-2 (lighter, for text on dark), ink on accent, deep (gradient end)]. */
const PALETTE: Record<SeasonKey, { dark: [string, string, string, string]; light: [string, string, string, string] }> = {
  fall: { dark: ["#ef8354", "#f6a77f", "#200c03", "#c9a227"], light: ["#b44d24", "#a8461f", "#ffffff", "#9b7a12"] },
  winter: { dark: ["#8fb8ff", "#b9d2ff", "#06101f", "#c8b6ff"], light: ["#3566c4", "#2f5bb0", "#ffffff", "#6a55c9"] },
  spring: { dark: ["#f49ac1", "#f8bdd7", "#2a0716", "#b8e0d2"], light: ["#b33f73", "#a63a6a", "#ffffff", "#3f9b80"] },
  summer: { dark: ["#39c5cf", "#7fdde3", "#03191b", "#ffe08a"], light: ["#117880", "#0f6f76", "#ffffff", "#b38a14"] },
};

/** Sets the season accent on the page (the light theme gets darker variants for contrast). */
const MERRY: { dark: [string, string, string, string]; light: [string, string, string, string] } = { dark: ["#e0a15a", "#f0c48c", "#2a1605", "#4aa3d8"], light: ["#9a5b1e", "#7d4813", "#ffffff", "#1f6fa3"] };

export function applySeason(theme: "dark" | "light", ms = Date.now()) {
  const s = seasonOf(ms);
  const merry = (() => {
    try {
      return localStorage.getItem("animearr.palette") === '"merry"';
    } catch {
      return false;
    }
  })();
  const [a, a2, ink, deep] = merry ? MERRY[theme] : PALETTE[s.key][theme];
  const st = document.documentElement.style;
  st.setProperty("--accent", a);
  st.setProperty("--accent-2", a2);
  st.setProperty("--accent-ink", ink);
  st.setProperty("--accent-deep", deep);
  document.documentElement.dataset.season = s.key;
  return s;
}

// ---------------------------------------------------------------- per-show colour with a contrast guard

const hex2rgb = (h: string) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => x / 255);
};
const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLin = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function rgbToOklch([r, g, b]: number[]) {
  const [lr, lg, lb] = [toLin(r), toLin(g), toLin(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}
function oklchToRgb([L, C, H]: number[]) {
  const A = C * Math.cos(H);
  const B = C * Math.sin(H);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [r, g, b].map((x) => Math.round(Math.min(1, Math.max(0, fromLin(x))) * 255));
}

/**
 * A show colour that's always usable: lightness clamped to 0.62–0.78 and chroma ≤ 0.16 (OKLCH), so it glows on the
 * dark background and dark text on it stays readable (≥ 4.5:1). Null when there's no colour.
 */
export function safeShowColor(hex: string | null | undefined): string | null {
  const rgb = hex ? hex2rgb(hex) : null;
  if (!rgb) return null;
  const [L, C, H] = rgbToOklch(rgb);
  const [r, g, b] = oklchToRgb([Math.min(0.78, Math.max(0.62, L)), Math.min(0.16, C), H]);
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** Inline style for an element that should take a show's colour (or fall back to the season accent). */
export const showVars = (hex: string | null | undefined): React.CSSProperties => {
  const c = safeShowColor(hex);
  // A clamped show colour is light enough for dark text in both themes.
  return c ? ({ "--show": c, "--show-ink": "#0b0d14" } as React.CSSProperties) : {};
};
