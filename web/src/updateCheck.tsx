/**
 * A tab that stays open across an update keeps running the old build. Every few minutes and when the tab regains focus,
 * AnimeArr asks the server which build it serves; when it differs from the loaded one, a toast offers to reload. It never
 * reloads by itself, and asks first when a form on the page has unsaved changes.
 */
import { useEffect, useRef } from "react";
import { api } from "./api";
import { t } from "./i18n";
import { useToast } from "./ui";

/** The loaded build: the hashed name of the entry script (absent in the dev server). */
export function loadedBuild(doc: Document = document): string | null {
  const src = doc.querySelector<HTMLScriptElement>('script[type="module"][src*="assets/index-"]')?.getAttribute("src") ?? "";
  return /assets\/index-([\w-]+)\.js/.exec(src)?.[1] ?? null;
}

const EVERY = 5 * 60_000;

export function UpdateCheck() {
  const toast = useToast();
  const dirty = useRef(false);
  const told = useRef<string | null>(null);
  useEffect(() => {
    const mine = loadedBuild();
    if (!mine) return;
    // Typing into a form marks the page dirty until the next navigation.
    const onInput = (e: Event) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea, select")) dirty.current = true;
    };
    const onNav = () => (dirty.current = false);
    let last = 0;
    const check = async () => {
      if (Date.now() - last < 30_000 || document.visibilityState === "hidden") return;
      last = Date.now();
      try {
        const s = await api<{ version: string; build?: string | null }>("/status");
        if (!s.build || s.build === mine || told.current === s.build) return;
        told.current = s.build;
        toast(t("update.available", { version: s.version }), false, {
          label: t("update.reload"),
          run: () => {
            if (dirty.current && !window.confirm(t("update.dirty"))) return;
            window.location.reload();
          },
        });
      } catch {
        /* offline or restarting: try again later */
      }
    };
    const timer = setInterval(() => void check(), EVERY);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    document.addEventListener("input", onInput, true);
    window.addEventListener("popstate", onNav);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      document.removeEventListener("input", onInput, true);
      window.removeEventListener("popstate", onNav);
    };
  }, [toast]);
  return null;
}
