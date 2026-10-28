/**
 * "Check for updates": asks GitHub which AnimeArr release is newest (read-only, nothing is downloaded or installed).
 * Offline or rate-limited, it says so instead of failing. The answer is kept for an hour.
 */
import { VERSION } from "./version.js";

const REPO = "MoriTranslates/animearr";
export interface UpdateInfo { current: string; latest: string | null; newer: boolean; url: string | null; offline: boolean; checkedAt: number }

/** -1 / 0 / 1 for "0.9.0-beta" vs "v0.9.1" (numbers first; a release beats its own pre-release). */
export function compareVersions(a: string, b: string) {
  const p = (v: string) => {
    const [main, pre = ""] = v.replace(/^v/i, "").split("-", 2);
    return { nums: main.split(".").map((x) => Number(x) || 0), pre };
  };
  const x = p(a);
  const y = p(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

let memo: UpdateInfo | null = null;

export async function checkForUpdates(fetchFn: typeof fetch = fetch, now = Date.now(), current = VERSION): Promise<UpdateInfo> {
  if (memo && now - memo.checkedAt < 3_600_000 && memo.current === current && !memo.offline) return memo;
  try {
    const res = await fetchFn(`https://api.github.com/repos/${REPO}/releases?per_page=10`, { headers: { Accept: "application/vnd.github+json", "User-Agent": `AnimeArr/${current}` }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = (await res.json()) as { tag_name: string; html_url: string; draft: boolean; prerelease: boolean }[];
    // A beta user also hears about newer betas; a stable user only about stable releases.
    const usable = list.filter((r) => !r.draft && (!r.prerelease || current.includes("-")));
    const best = usable.sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0] ?? null;
    memo = { current, latest: best ? best.tag_name.replace(/^v/i, "") : null, newer: !!best && compareVersions(best.tag_name, current) > 0, url: best?.html_url ?? null, offline: false, checkedAt: now };
  } catch {
    memo = { current, latest: null, newer: false, url: null, offline: true, checkedAt: now };
  }
  return memo;
}
