/**
 * Quality categories, group tiers and SeaDex: "standard names, anime reality".
 *
 * Users see Sonarr's quality names (WEBDL-1080p, Bluray-1080p Remux...), grouped into categories the way the TRaSH
 * Guides anime profile groups them: Bluray 1080p (incl. Remux) › WEB 1080p (WEB-DL, WEBRip and HDTV) › Bluray-720p ›
 * WEB 720p › Bluray-480p › WEB 480p › DVD › SDTV. 2160p categories exist but sit above the ladder's normal goals.
 *
 * The anime rebase:
 * - WEB-DL vs WEBRip doesn't matter (the same stream); one category.
 * - HDTV is a TV capture (logos, censorship, ad breaks): inside the WEB category, with a score penalty.
 * - Most "4K" anime is an upscale: 2160p counts as 1080p unless it's a real UHD Blu-ray (UHD or Remux).
 * - A name without a source but with a resolution ("[SubsPlease] X - 01 (1080p)") is a WEB release.
 * - Inside a category the group matters more than the source: SeaDex picks first, then TRaSH's anime BD/Web tiers;
 *   low-quality groups rank last.
 *
 * SeaDex (releases.moe) is part of the ranking itself: its "best" pick for a show is the top score, an "alt" just
 * below. Dual and Either watch modes prefer the dual-audio picks.
 */
import { parseRelease, type ParsedRelease, type Source } from "./parser.js";

export type Category = "unknown" | "sdtv" | "dvd" | "web-480" | "bluray-480" | "web-720" | "bluray-720" | "web-1080" | "bluray-1080" | "web-2160" | "bluray-2160";

/** Worst → best. */
export const LADDER: Category[] = ["unknown", "sdtv", "dvd", "web-480", "bluray-480", "web-720", "bluray-720", "web-1080", "bluray-1080", "web-2160", "bluray-2160"];
export const ladderRank = (c: Category) => LADDER.indexOf(c);

export const CATEGORY_NAME: Record<Category, string> = {
  unknown: "Unknown",
  sdtv: "SDTV",
  dvd: "DVD",
  "web-480": "WEB 480p",
  "bluray-480": "Bluray-480p",
  "web-720": "WEB 720p",
  "bluray-720": "Bluray-720p",
  "web-1080": "WEB 1080p",
  "bluray-1080": "Bluray 1080p",
  "web-2160": "WEB 2160p",
  "bluray-2160": "Bluray 2160p",
};
/** The Sonarr quality names each category holds (shown in the Sonarr API's quality profile). */
export const CATEGORY_QUALITIES: Record<Category, string[]> = {
  unknown: ["Unknown"],
  sdtv: ["SDTV"],
  dvd: ["DVD"],
  "web-480": ["WEBDL-480p", "WEBRip-480p"],
  "bluray-480": ["Bluray-480p"],
  "web-720": ["WEBDL-720p", "WEBRip-720p", "HDTV-720p"],
  "bluray-720": ["Bluray-720p"],
  "web-1080": ["WEBDL-1080p", "WEBRip-1080p", "HDTV-1080p"],
  "bluray-1080": ["Bluray-1080p Remux", "Bluray-1080p"],
  "web-2160": ["WEBDL-2160p", "WEBRip-2160p", "HDTV-2160p"],
  "bluray-2160": ["Bluray-2160p Remux", "Bluray-2160p"],
};

const resOf = (p: ParsedRelease, height: number | null) => p.resolution ?? (height ? (height >= 2000 ? 2160 : height >= 1000 ? 1080 : height >= 700 ? 720 : 480) : null);

/** Sonarr-style quality name from a release name / probe ("WEBDL-1080p", "Bluray-1080p Remux"). */
export function sonarrQualityName(release: string, height: number | null) {
  const p = parseRelease(release);
  const res = resOf(p, height);
  const r = res ? `${res}p` : "";
  if (/remux/i.test(release)) return `Bluray-${r || "1080p"} Remux`;
  if (p.source === "bluray") return `Bluray-${r}`.replace(/-$/, "");
  if (p.source === "web") return /webrip/i.test(release) ? `WEBRip-${r}` : `WEBDL-${r}`;
  if (p.source === "hdtv") return `HDTV-${r}`;
  if (p.source === "dvd") return "DVD";
  return r ? `WEBDL-${r}` : "Unknown";
}

export interface QualityInfo {
  category: Category;
  /** Sonarr's quality name. */
  name: string;
  remux: boolean;
  /** A TV capture (penalised inside the WEB category). */
  hdtv: boolean;
  /** Named 2160p but not a real UHD Blu-ray: counted as 1080p. */
  upscale: boolean;
}

const bucket = (res: number | null, top: 1080 | 2160 = 1080) => (res === null ? null : res >= 2000 && top === 2160 ? 2160 : res >= 1000 ? 1080 : res >= 700 ? 720 : 480);

/** The category of a release name (or a file's original release name), with the anime rebase applied. */
export function qualityOf(release: string | ParsedRelease, height: number | null = null): QualityInfo {
  const p = typeof release === "string" ? parseRelease(release) : release;
  const raw = p.raw;
  const res = resOf(p, height);
  const remux = /\bremux\b/i.test(raw);
  const name = sonarrQualityName(raw, height);
  const out = (category: Category, extra: Partial<QualityInfo> = {}): QualityInfo => ({ category, name, remux, hdtv: false, upscale: false, ...extra });
  const upscale = res !== null && res >= 2000;
  if (p.source === "bluray") {
    if (upscale && (remux || /\bUHD\b/i.test(raw))) return out("bluray-2160");
    const b = bucket(res);
    return out(b === null || b === 1080 ? "bluray-1080" : b === 720 ? "bluray-720" : "bluray-480", { upscale });
  }
  if (p.source === "dvd") return out("dvd");
  if (p.source === "hdtv") {
    const b = bucket(res);
    return out(b === 1080 ? "web-1080" : b === 720 ? "web-720" : "sdtv", { hdtv: true, upscale });
  }
  // WEB, or no source named but a resolution (fansub/WEB rips usually only say "1080p").
  const b = bucket(res);
  if (b === null) return out(p.source === "web" ? "web-1080" : "unknown");
  return out(b === 1080 ? "web-1080" : b === 720 ? "web-720" : "web-480", { upscale });
}

// ---------------------------------------------------------------- goals

export type GoalId = "good" | "high" | "collector";
export const GOAL_IDS: GoalId[] = ["good", "high", "collector"];
export const GOALS: Record<GoalId, { name: string; category: Category; seadex: boolean; help: string }> = {
  good: { name: "Good enough", category: "web-1080", seadex: false, help: "WEB 1080p: smaller files, what streaming services give you" },
  high: { name: "Aim high", category: "bluray-1080", seadex: false, help: "Blu-ray 1080p when it comes out (usually 3–6 months after airing)" },
  collector: { name: "Collector", category: "bluray-1080", seadex: true, help: "Whatever SeaDex rates best for the show: the largest files" },
};
export const goalLabel = (g: GoalId) => `${GOALS[g].name} (${g === "collector" ? "SeaDex best" : CATEGORY_NAME[GOALS[g].category]})`;
export const isGoal = (x: unknown): x is GoalId => GOAL_IDS.includes(x as GoalId);

/** A profile's preferred resolution caps the goal (a 720p profile doesn't chase 1080p Blu-rays). */
export function goalCategory(goal: GoalId, profileResolution = 1080, cap: Category | null = null): Category {
  let c = GOALS[goal].category;
  if (profileResolution <= 720 && ladderRank(c) > ladderRank(c.startsWith("bluray") ? "bluray-720" : "web-720")) c = c.startsWith("bluray") ? "bluray-720" : "web-720";
  if (profileResolution <= 480 && ladderRank(c) > ladderRank(c.startsWith("bluray") ? "bluray-480" : "web-480")) c = c.startsWith("bluray") ? "bluray-480" : "web-480";
  // No Blu-ray exists for the show (a DVD-era show, or nothing BD ever seen): aim for the best that exists.
  if (cap && ladderRank(cap) < ladderRank(c)) c = cap;
  return c;
}

// ---------------------------------------------------------------- group tiers (TRaSH Guides anime CFs)

export interface TierTable { version?: string; bd: Record<string, string[]>; web: Record<string, string[]>; lq: string[] }
export interface CompiledTiers { version: string; bd: { tier: number; re: RegExp[] }[]; web: { tier: number; re: RegExp[] }[]; lq: RegExp[] }

const compile = (pats: string[]) =>
  pats.flatMap((x) => {
    try {
      return [new RegExp(x, "i")];
    } catch {
      return [];
    }
  });
export function compileTiers(t: TierTable): CompiledTiers {
  const side = (o: Record<string, string[]>) =>
    Object.entries(o)
      .map(([k, v]) => ({ tier: Number(k), re: compile(v) }))
      .sort((a, b) => a.tier - b.tier);
  return { version: t.version ?? "", bd: side(t.bd), web: side(t.web), lq: compile(t.lq) };
}

export type TierMatch = { kind: "bd" | "web"; tier: number } | { kind: "lq" };
/** The TRaSH tier of a release: BD tiers for Blu-ray categories, Web tiers for the rest; low-quality groups anywhere. */
export function tierOf(release: string, category: Category, tiers: CompiledTiers | null | undefined): TierMatch | null {
  if (!tiers) return null;
  if (tiers.lq.some((r) => r.test(release))) return { kind: "lq" };
  const side = category.startsWith("bluray") ? "bd" : category === "dvd" || category === "sdtv" || category === "unknown" ? null : "web";
  if (!side) return null;
  for (const t of tiers[side]) if (t.re.some((r) => r.test(release))) return { kind: side, tier: t.tier };
  return null;
}

// ---------------------------------------------------------------- SeaDex

export interface SeadexTorrent { group: string; tracker: string; best: boolean; dualAudio: boolean; tags: string[] }
export interface SeadexEntry { incomplete: boolean; torrents: SeadexTorrent[] }

const groupKey = (g: string | null | undefined) => (g ?? "").toLowerCase().replace(/[^a-z0-9&]+/g, "");

/**
 * The source of a SeaDex torrent: its tags (and tracker) when they say so, else Blu-ray: SeaDex is a list of the best
 * Blu-ray releases, and a pick only counts as WEB/DVD/TV when it is tagged that way.
 */
export function seadexSource(t: Pick<SeadexTorrent, "tags" | "tracker">): NonNullable<Source> {
  const text = [...t.tags, t.tracker].join(" ").toLowerCase();
  if (/\b(bd|blu-?ray|remux|bdmv)\b/.test(text)) return "bluray";
  if (/\bweb(?:[ ._-]?(?:dl|rip))?\b/.test(text)) return "web";
  if (/\b(hdtv|tv ?raw|tvrip)\b/.test(text)) return "hdtv";
  if (/\bdvd(?:rip)?\b/.test(text)) return "dvd";
  return "bluray";
}

/** A release shares a SeaDex pick's source (a release that names none is given the benefit of the doubt). */
export const sourceMatches = (pick: NonNullable<Source>, release: Source) => release === null || release === pick;

/** Sort key of a SeaDex torrent for a watch mode (lower is better): dual audio first in Dual/Either, then "best". */
const seadexKey = (mode: "sub" | "dub" | "dual" | "either") => (t: SeadexTorrent) => ((mode === "dual" || mode === "either") && !t.dualAudio ? 2 : 0) + (t.best ? 0 : 1);

/** SeaDex's top pick for a watch mode. */
export const seadexTop = (entry: SeadexEntry, mode: "sub" | "dub" | "dual" | "either" = "sub"): SeadexTorrent | null => [...entry.torrents].sort((a, b) => seadexKey(mode)(a) - seadexKey(mode)(b))[0] ?? null;

/**
 * Whether a release is SeaDex's pick for the show: "best" (the top pick for this watch mode) or "alt". The group has
 * to match AND the release's source be compatible with the pick's: a SeaDex Blu-ray pick doesn't bless that group's
 * HDTV, TV raw or WEB release. Dual and Either watch modes rank dual-audio picks above the rest; Sub mode ignores the flag.
 */
export function seadexPick(group: string | null, entry: SeadexEntry | null | undefined, mode: "sub" | "dub" | "dual" | "either" = "sub", source: Source = null): { level: "best" | "alt"; torrent: SeadexTorrent } | null {
  if (!entry || !group || !entry.torrents.length) return null;
  const key = seadexKey(mode);
  const top = Math.min(...entry.torrents.map(key));
  const g = groupKey(group);
  const mine = entry.torrents.filter((t) => groupKey(t.group) === g && sourceMatches(seadexSource(t), source)).sort((a, b) => key(a) - key(b))[0];
  if (!mine) return null;
  return { level: key(mine) === top ? "best" : "alt", torrent: mine };
}

// ---------------------------------------------------------------- scoring

export interface QualityContext {
  tiers?: CompiledTiers | null;
  seadex?: SeadexEntry | null;
  mode?: "sub" | "dub" | "dual" | "either";
  goal?: GoalId;
}
export interface QualityScore {
  info: QualityInfo;
  tier: TierMatch | null;
  seadex: "best" | "alt" | null;
  /** SeaDex + tier points (the part of the score that says how good the release is inside its category). */
  points: number;
  why: string[];
  flags: { key: string; label: string; tone: "good" | "bad" | "warn" | "info" }[];
}

export const SEADEX_BEST = 60;
export const SEADEX_ALT = 40;
/** BD tier 1 → 31 … tier 8 → 10; Web tier 1 → 25 … tier 6 → 10. */
export const tierPoints = (t: TierMatch | null) => (!t ? 0 : t.kind === "lq" ? -40 : t.kind === "bd" ? 34 - 3 * t.tier : 28 - 3 * t.tier);

/** How good a release is beyond its language fit: SeaDex first, then group tiers, plus the anime rebase penalties. */
export function qualityScore(release: string | ParsedRelease, ctx: QualityContext, height: number | null = null): QualityScore {
  const p = typeof release === "string" ? parseRelease(release) : release;
  const info = qualityOf(p, height);
  const why: string[] = [];
  const flags: QualityScore["flags"] = [];
  let points = 0;
  let extra = 0;
  const pick = seadexPick(p.group, ctx.seadex, ctx.mode, p.source);
  if (pick) {
    points += pick.level === "best" ? SEADEX_BEST : SEADEX_ALT;
    const dual = pick.torrent.dualAudio ? ", dual audio" : "";
    why.push(`SeaDex ${pick.level === "best" ? "best" : "alt"} release (${pick.torrent.group}${dual})`);
    flags.push({ key: "seadex", label: `SeaDex ${pick.level}`, tone: "good" });
  }
  const tier = tierOf(p.raw, info.category, ctx.tiers);
  if (tier) {
    points += tierPoints(tier);
    if (tier.kind === "lq") {
      why.push("a low-quality group (TRaSH list)");
      flags.push({ key: "lq", label: "Low-quality group", tone: "bad" });
    } else if (!pick) why.push(`${tier.kind === "bd" ? "BD" : "Web"} tier ${tier.tier} group`);
  }
  if (info.hdtv) {
    extra -= 12;
    why.push("a TV capture (HDTV)");
    flags.push({ key: "hdtv", label: "TV capture", tone: "warn" });
  }
  if (info.upscale) {
    extra -= 5;
    flags.push({ key: "upscale", label: "4K (likely an upscale)", tone: "warn" });
  }
  // Goals that aim for Blu-ray lean towards BD sources at grab time too.
  if ((ctx.goal === "high" || ctx.goal === "collector") && info.category.startsWith("bluray")) extra += 6;
  return { info, tier, seadex: pick?.level ?? null, points: points + extra, why, flags };
}

/** The current file is already its category's best: a SeaDex pick, or a tier-1 group of its kind. */
export const isCategoryBest = (s: Pick<QualityScore, "seadex" | "tier">) => !!s.seadex || (!!s.tier && s.tier.kind !== "lq" && s.tier.tier === 1);

/**
 * Does a candidate qualify as an upgrade of the current file? Judged by quality category ("best in its quality
 * category", the owner's no-churn rule):
 * - a higher category always qualifies;
 * - in the same category, only when the current file isn't already that category's best and the candidate scores
 *   higher on SeaDex/tiers (a SeaDex pick moving between two equally good releases never re-downloads).
 */
export function beatsCurrent(cand: QualityScore, cur: QualityScore): { ok: boolean; why: string } {
  const a = ladderRank(cand.info.category);
  const b = ladderRank(cur.info.category);
  const cn = CATEGORY_NAME[cand.info.category];
  const un = CATEGORY_NAME[cur.info.category];
  if (a > b) return { ok: true, why: `${cn} beats your ${un}` };
  if (a < b) return { ok: false, why: `${cn} is below your ${un}` };
  if (isCategoryBest(cur)) return { ok: false, why: `your ${un} file is already the best of its category` };
  if (cand.points > cur.points) return { ok: true, why: `a better ${cn} release (${cand.why[0] ?? "higher group tier"})` };
  return { ok: false, why: `not better than your ${un} file` };
}

/** Is the current file at the goal? Collector also needs the SeaDex pick (when SeaDex knows the show). */
export function meetsGoal(cur: QualityScore, goal: GoalId, opts: { profileResolution?: number; cap?: Category | null; seadexKnown?: boolean } = {}): boolean {
  const target = goalCategory(goal, opts.profileResolution ?? 1080, opts.cap ?? null);
  if (ladderRank(cur.info.category) < ladderRank(target)) return false;
  if (goal !== "collector") return true;
  if (opts.cap) return true; // nothing better exists than what the cap allows
  return opts.seadexKnown ? cur.seadex === "best" : isCategoryBest(cur);
}

/** File names carrying a lock: the user's own `[Remaster]` convention and AnimeArr's `[Keep]` tag. */
export const LOCK_TAG = /\[(keep|remaster)\]/i;
