/**
 * Appearance (per device): the font (Inter by default, System, or Comic mode) and the manga exclamations on toasts.
 * Comic Neue is only loaded when Comic mode is picked (phones and Linux have no Comic Sans).
 */
import { store } from "./api";
import { applySeason } from "./season";

export type FontChoice = "inter" | "system" | "comic";
export type Exclaim = "off" | "sometimes" | "always";

let comicLoaded = false;
export function applyFont(f: string) {
  const v: FontChoice = f === "comic" || f === "system" ? f : "inter";
  document.documentElement.dataset.font = v;
  if (v === "comic" && !comicLoaded) {
    comicLoaded = true;
    void import("@fontsource/comic-neue/400.css");
    void import("@fontsource/comic-neue/700.css");
  }
}

/** How often toasts get a manga exclamation: Comic mode always; otherwise the setting ("sometimes" ≈ 1 in 5). */
export function exclaimMode(): Exclaim {
  if (store.get<string>("font", "inter") === "comic") return "always";
  const v = store.get<string>("exclaim", "sometimes");
  return v === "off" || v === "always" ? v : "sometimes";
}

/** Text size steps: Small 90 %, Default 100 %, Large 112.5 %, Extra large 125 %. */
export const TEXT_SCALES = [
  { key: "sm", scale: 0.9 },
  { key: "md", scale: 1 },
  { key: "lg", scale: 1.125 },
  { key: "xl", scale: 1.25 },
] as const;
export type TextScale = (typeof TEXT_SCALES)[number]["key"];
export function applyTextScale(k: string | null | undefined) {
  const s = TEXT_SCALES.find((x) => x.key === k)?.scale ?? 1;
  document.documentElement.style.setProperty("--text-scale", String(s));
}

export function applyTheme(theme: string) {
  document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
  // The browser chrome (address bar, PWA title bar) follows the theme; the root color-scheme comes from the CSS.
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#f5f6fa" : "#0b0d14");
  applySeason(theme === "light" ? "light" : "dark");
  // The Merry palette (Appearance): caramel wood, sea blue, sail white, instead of the season's accent.
  document.documentElement.dataset.palette = store.get<string>("palette", "season") === "merry" ? "merry" : "season";
  applyFont(store.get<string>("font", "inter"));
  // The device's own text size; without one, the saved default (applied when the status arrives).
  const ts = store.get<string | null>("textScale", null);
  if (ts) applyTextScale(ts);
  // Manga speech-bubble toasts are the default; "standard" is the opt-out (Settings → Appearance).
  document.documentElement.dataset.toasts = store.get<string>("toastStyle", "bubble") === "standard" ? "standard" : "bubble";
}
