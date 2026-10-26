/**
 * Appearance (per device): the font (Inter by default, System, or Comic mode) and the manga exclamations on toasts.
 * Comic Neue is only loaded when Comic mode is picked (phones and Linux have no Comic Sans).
 */
import { store } from "./api";

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
