/**
 * The user's subtitle-track corrections (track_overrides), memoized. A leaf under mediafiles.ts (which applies them to
 * every record it reads) and detection.ts (which edits them).
 */
import { db } from "../system/db.js";
import { keyOf } from "../system/paths.js";

export interface TrackOverride {
  id: number;
  path: string;
  trackIndex: number;
  lang: string | null;
  forced: boolean;
  at: number;
}

let memo: Map<string, TrackOverride[]> | null = null;
const load = () => {
  if (memo) return memo;
  memo = new Map();
  for (const r of db.prepare("SELECT id, path, track_index, lang, forced, at FROM track_overrides").all() as {
    id: number;
    path: string;
    track_index: number;
    lang: string | null;
    forced: number;
    at: number;
  }[]) {
    const o = { id: r.id, path: r.path, trackIndex: r.track_index, lang: r.lang, forced: !!r.forced, at: r.at };
    memo.set(r.path, [...(memo.get(r.path) ?? []), o]);
  }
  return memo;
};
/** Forget the memo after a change (setTrackLanguage, deleteOverrides). */
export const invalidateOverrides = () => void (memo = null);

/** The user's corrections for a file's subtitle tracks (applied wherever the file's tracks are read). */
export function overridesFor(p: string) {
  return load().get(keyOf(p)) ?? [];
}

/** Applies overrides to a record's subtitle tracks (language, signs-only). */
export function applyOverrides<T extends { index: number; lang: string | null; partial: boolean; forced: boolean }>(
  p: string,
  subs: T[],
): T[] {
  const os = overridesFor(p);
  if (!os.length) return subs;
  return subs.map((s) => {
    const o = os.find((x) => x.trackIndex === s.index);
    return o ? { ...s, lang: o.lang, partial: o.forced, forced: o.forced || s.forced, overridden: true } : s;
  });
}
