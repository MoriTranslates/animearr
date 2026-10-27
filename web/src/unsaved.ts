import { useEffect, useRef } from "react";
import { t } from "./i18n";

/**
 * Unsaved changes, app-wide. A form with edits registers itself (useUnsaved); leaving the page asks first
 * (confirmLeave, called by navigate()), closing the tab gets the browser's own warning, and the setup wizard saves
 * every registered form before Next (saveAllUnsaved), staying put when a save fails.
 */
interface Entry { dirty: () => boolean; save?: () => Promise<boolean> }
const entries = new Set<Entry>();

export function useUnsaved(dirty: boolean, save?: () => Promise<boolean>) {
  const latest = useRef({ dirty, save });
  latest.current = { dirty, save };
  useEffect(() => {
    const e: Entry = { dirty: () => latest.current.dirty, save: () => (latest.current.save ? latest.current.save() : Promise.resolve(false)) };
    entries.add(e);
    return () => void entries.delete(e);
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (ev: BeforeUnloadEvent) => {
      ev.preventDefault();
      ev.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty]);
}

export const anyUnsaved = () => [...entries].some((e) => e.dirty());

/** True when it's fine to leave (nothing unsaved, or the user said to drop the changes). */
export function confirmLeave() {
  return !anyUnsaved() || window.confirm(t("settings.unsavedLeave"));
}

/** Saves every form with unsaved changes; false when one failed (it shows its own error), so the caller stays. */
export async function saveAllUnsaved() {
  for (const e of [...entries]) {
    if (!e.dirty()) continue;
    if (!(await e.save!())) return false;
  }
  return true;
}
