/**
 * Stage 1 (FIND): score a release before downloading it, against the language profile.
 *
 * The core number is P(profile subtitle language) — the chance the file carries subtitles the viewer can read. It comes
 * from explicit title hints, then the learned per-(group, source) language table (backfilled from the user's library and
 * updated by every verification), then seed knowledge of well-known groups. Preference points (Usenet, uncensored,
 * resolution, size sanity) and penalties (burn-in) order the accepted releases. Hard rejections: raws, Chinese-only,
 * foreign-only, Japanese-market releases without the profile language.
 */
import { EN_GROUPS, type ParsedRelease } from "./parser.js";

export interface Profile {
  subLangs: string[];
  audioLangs: string[];
  softOnly: boolean;
  preferUncensored: boolean;
  protocolOrder: ("usenet" | "torrent")[];
  resolution: number;
}

export interface ReleaseInfo {
  protocol: "usenet" | "torrent";
  size: number;
  seeders?: number | null;
  indexer?: string;
  /** Number of episodes the release covers (for size sanity). */
  episodeCount: number;
}

export interface LearnedLang {
  total: number;
  subs: Record<string, number>;
  /** "library" (backfilled from your files) or "verify" (checked after download) or both. */
  origin: string;
}

/** Things known about this exact release or season from the user's library and confirmed facts. */
export interface Known {
  /** User confirmed this season has burned-in subs in this language (e.g. a donghua with only hardsubbed English). */
  burnedIn?: { lang: string; resolution: string | null; note: string };
  /** The release name equals a file already in the library (its scene name). */
  inLibrary?: boolean;
  blocklisted?: string | null;
}

export type Tone = "good" | "bad" | "warn" | "info";
export interface Flag {
  key: string;
  label: string;
  tone: Tone;
}

export interface Ranked {
  accept: boolean;
  score: number;
  /** P(best profile subtitle language), 0..1. */
  langProb: number;
  lang: string;
  langSource: string;
  flags: Flag[];
  /** Human-readable reason, e.g. "97% English (SubsPlease, 41/41 verified), Usenet". */
  why: string;
  reject: string | null;
}

const LANG_NAMES: Record<string, string> = { en: "English", es: "Spanish", pt: "Portuguese", fr: "French", de: "German", it: "Italian", ru: "Russian", ar: "Arabic", zh: "Chinese", ja: "Japanese", id: "Indonesian", vi: "Vietnamese", th: "Thai", pl: "Polish", tr: "Turkish", ko: "Korean" };
export const langName = (l: string) => LANG_NAMES[l] ?? l;
/** Languages a "Multi-Subs" release (CR/Netflix/Amazon rip) usually includes. */
const MULTI_SET = new Set(["en", "es", "pt", "fr", "de", "it", "ar", "ru"]);

/** Beta(1,1)-smoothed share of observed files that had `lang`. */
function learnedProb(l: LearnedLang, lang: string) {
  return ((l.subs[lang] ?? 0) + 1) / (l.total + 2);
}

export function rankRelease(p: ParsedRelease, info: ReleaseInfo, profile: Profile, learned: LearnedLang | null, known: Known = {}): Ranked {
  const flags: Flag[] = [];
  const h = p.hints;
  const group = (p.group ?? "").toLowerCase();
  const wanted = profile.subLangs.length ? profile.subLangs : ["en"];
  const primary = wanted[0];

  flags.push(info.protocol === "usenet" ? { key: "usenet", label: "Usenet", tone: "info" } : { key: "torrent", label: `Torrent${info.seeders != null ? ` · ${info.seeders} seeders` : ""}`, tone: info.seeders === 0 ? "warn" : "info" });

  // ---- P(profile language)
  let best = { lang: primary, p: 0.35, src: "no language info in the name" };
  const consider = (lang: string, prob: number, src: string) => {
    // A higher-ranked profile language wins ties; otherwise the higher probability.
    if (prob > best.p + 0.001 || (Math.abs(prob - best.p) < 0.001 && wanted.indexOf(lang) < wanted.indexOf(best.lang))) best = { lang, p: prob, src };
  };
  const explicitOther = h.subs.filter((l) => !wanted.includes(l));
  for (const lang of wanted) {
    if (h.subs.includes(lang)) consider(lang, h.hardsub && h.hardsubLang === lang ? 0.92 : 0.97, "named in the title");
    else if (h.multiSubs) consider(lang, MULTI_SET.has(lang) ? 0.9 : 0.45, "Multi-Subs");
    if (learned && learned.total >= 3) consider(lang, learnedProb(learned, lang), `${p.group ?? "no group"}${p.platform ? ` ${p.platform}` : ""}: ${learned.subs[lang] ?? 0}/${learned.total} ${learned.origin}`);
    if (lang === "en" && EN_GROUPS.includes(group) && !h.jpMarket && !explicitOther.length) consider(lang, 0.88, `${p.group} usually has English subs`);
    if (lang === "en" && h.dualAudio && !h.jpMarket) consider(lang, 0.85, "dual audio (usually with English subs)");
    if (known.burnedIn && known.burnedIn.lang === lang && !h.subs.length && !h.multiSubs) consider(lang, 0.9, `burned in (${known.burnedIn.note})`);
  }
  // Negative evidence lowers the estimate unless the title names a profile language.
  const namedWanted = wanted.some((l) => h.subs.includes(l)) || h.multiSubs;
  let reject: string | null = null;
  if (h.raw && !namedWanted) {
    best = { lang: primary, p: 0.02, src: "raw (no subtitles)" };
    reject = "raw release (no subtitles)";
    flags.push({ key: "raw", label: "Raw", tone: "bad" });
  }
  if (h.jpMarket && !namedWanted && !wanted.includes("ja")) {
    best = { lang: primary, p: 0.03, src: "Japanese-market release" };
    reject ??= `Japanese-market release, no ${langName(primary)} subtitles`;
    flags.push({ key: "jpMarket", label: `JP market · no ${langName(primary)}`, tone: "bad" });
  }
  if (h.subs.includes("zh") && !namedWanted && !wanted.includes("zh") && explicitOther.every((l) => l === "zh" || l === "ja")) {
    best = { lang: primary, p: Math.min(best.p, 0.05), src: "Chinese subtitles only" };
    reject ??= "Chinese subtitles only";
    flags.push({ key: "chinese", label: "Chinese subs", tone: "bad" });
  } else if (explicitOther.length && !namedWanted && !h.hardsub) {
    best = { lang: primary, p: Math.min(best.p, 0.05), src: `${explicitOther.map(langName).join("/")} subtitles only` };
    reject ??= `foreign subtitles only (${explicitOther.map(langName).join(", ")})`;
    flags.push({ key: "foreign", label: `${explicitOther.map(langName).join("/")} only`, tone: "bad" });
  }
  // Sub-only watch mode: a dub without the original audio is not wanted.
  const dubOnly = h.audio.length > 0 && !h.dualAudio && !h.audio.some((a) => profile.audioLangs.includes(a)) && h.audio.every((a) => a !== "ja");
  if (dubOnly) {
    reject ??= `${h.audio.map(langName).join("/")} dub without the original audio`;
    flags.push({ key: "dub", label: `${h.audio.map(langName).join("/")} dub`, tone: "bad" });
  }
  if (known.blocklisted) {
    reject = `blocklisted: ${known.blocklisted}`;
    flags.push({ key: "blocklisted", label: "Blocklisted", tone: "bad" });
  }

  const pct = Math.round(best.p * 100);
  const L = langName(best.lang);
  if (!reject) {
    if (best.p >= 0.8) flags.push({ key: "lang", label: `${L} ${pct}%`, tone: "good" });
    else if (best.p >= 0.5) flags.push({ key: "lang", label: `${L} likely (${pct}%)`, tone: "warn" });
    else flags.push({ key: "lang", label: `${L} unknown (${pct}%)`, tone: "warn" });
  }

  // ---- burn-in
  const burned = (h.hardsub && (h.hardsubLang === null || wanted.includes(h.hardsubLang))) || !!known.burnedIn;
  if (burned) {
    const res = known.burnedIn?.resolution ?? (p.resolution ? `${p.resolution}p` : null);
    const lang = langName(known.burnedIn?.lang ?? h.hardsubLang ?? best.lang);
    flags.push({ key: "burnIn", label: `${lang} burned-in${res ? ` (${res})` : ""}`, tone: "warn" });
  }

  // ---- preference points
  let score = pct;
  const why: string[] = [`${pct}% ${L} (${best.src})`];
  if (info.protocol === profile.protocolOrder[0]) {
    score += 15;
    why.push(info.protocol === "usenet" ? "Usenet" : "torrent");
  } else why.push(info.protocol === "usenet" ? "Usenet" : `torrent${info.seeders != null ? `, ${info.seeders} seeders` : ""}`);
  if (burned && profile.softOnly) {
    score -= 40;
    why.push(`burned-in subs${known.burnedIn ? ` (${known.burnedIn.note})` : h.hardsubWhy ? ` (${h.hardsubWhy})` : ""}`);
  }
  if (h.uncensored) {
    flags.push({ key: "uncensored", label: "Uncensored", tone: "good" });
    if (profile.preferUncensored) {
      score += 8;
      why.push("uncensored");
    }
  } else if (h.censored && profile.preferUncensored) {
    score -= 8;
    flags.push({ key: "censored", label: "Censored", tone: "warn" });
  }
  if (h.dualAudio) {
    flags.push({ key: "dual", label: "Dual audio", tone: "info" });
    score += 2;
  }
  if (p.resolution) {
    if (p.resolution === profile.resolution) score += 10;
    else if (p.resolution < profile.resolution) score -= p.resolution >= 720 ? 8 : 20;
    else score -= 3;
  }
  if (p.version > 1) score += 2;
  const perEp = info.size / Math.max(1, info.episodeCount);
  if (info.size > 0 && perEp < 90e6) {
    score -= 30;
    flags.push({ key: "small", label: "Very small (sample?)", tone: "bad" });
    why.push("very small file");
  } else if (perEp > 8e9) score -= 10;
  if (info.protocol === "torrent" && info.seeders === 0) {
    score -= 25;
    why.push("no seeders");
  }
  if (known.inLibrary) flags.push({ key: "inLibrary", label: "Same as your library copy", tone: "info" });
  if (p.batch) flags.push({ key: "batch", label: "Batch", tone: "info" });

  return { accept: !reject, score: reject ? -1000 + score : score, langProb: best.p, lang: best.lang, langSource: best.src, flags, why: reject ? `skipped: ${reject}` : why.join(", "), reject };
}

/** Sort: accepted before rejected, then score; stable for equal scores. */
export function compareRanked<T extends { rank: Ranked }>(a: T, b: T) {
  return Number(b.rank.accept) - Number(a.rank.accept) || b.rank.score - a.rank.score;
}
