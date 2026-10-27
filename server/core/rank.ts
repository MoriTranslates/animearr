/**
 * Stage 1 (FIND): score a release before downloading it, against the language profile and its watch mode.
 *
 * Two probabilities come from title hints, the learned per-(group, source) language table (backfilled from the user's
 * library and updated by every verification) and seed knowledge of well-known groups:
 * - P(sub): the file carries full subtitles in a profile subtitle language;
 * - P(dub): the file carries audio in a profile dub language.
 * The watch mode decides which matters: sub → P(sub) (a dub without the original audio is rejected); dub → P(dub);
 * dual → dual audio wanted, a sub-only release is a placeholder; either → whichever is higher.
 * Preference points (Usenet, uncensored, resolution, dual audio, size sanity) and penalties (burn-in) order the
 * accepted releases. Hard rejections: raws, Chinese-only, foreign-only and JP-market releases (in sub modes), dubs
 * without the original audio (sub mode), releases without a dub (dub mode).
 */
import { EN_GROUPS, type ParsedRelease } from "./parser.js";

export type WatchMode = "sub" | "dub" | "dual" | "either";

export interface Profile {
  subLangs: string[];
  /** Audio languages that count as a dub (dub/dual/either). */
  dubLangs?: string[];
  watchMode?: WatchMode;
  /** Original audio language(s) of the show (ja; zh for donghua). */
  originalLangs?: string[];
  softOnly: boolean;
  preferUncensored: boolean;
  protocolOrder: ("usenet" | "torrent")[];
  noProtocolPreference?: boolean;
  resolution: number;
  sizePreset?: "lean" | "balanced" | "best";
}

/** Lean's ceiling in MB per minute by resolution (1080p: ~2 GB per 24-minute episode). */
export const LEAN_MB_PER_MIN: Record<number, number> = { 2160: 170, 1080: 85, 720: 45, 480: 25 };
const LOSSLESS = /\b(flac|truehd|dts[ .-]?hd|dts[ .-]?ma|l?pcm)\b/i;
const MINI = /\b(mini|tiny|small(er)?[ .-]?size|reenc(ode)?)\b/i;

export interface ReleaseInfo {
  protocol: "usenet" | "torrent";
  size: number;
  seeders?: number | null;
  indexer?: string;
  /** Number of episodes the release covers (for size sanity). */
  episodeCount: number;
  /** Minutes per episode (or the movie's runtime / episodeCount), for the size preset; 24 when unknown. */
  runtimeMin?: number | null;
}

export interface LearnedLang {
  total: number;
  subs: Record<string, number>;
  audio?: Record<string, number>;
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
  /** Recent download-link failures of the release's indexer (learned; see health.ts). */
  indexerHealth?: { failures: number; ok: number; lastWhy: string; off?: boolean };
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
  /** P(the profile is met), 0..1: subtitles in sub mode, dub audio in dub mode, the better of both in either mode. */
  langProb: number;
  lang: string;
  langSource: string;
  flags: Flag[];
  /** Human-readable reason, e.g. "97% English (SubsPlease, 41/41 verified), Usenet". */
  why: string;
  reject: string | null;
}

const LANG_NAMES: Record<string, string> = { en: "English", es: "Spanish", pt: "Portuguese", "pt-br": "Portuguese (Brazil)", fr: "French", de: "German", it: "Italian", ru: "Russian", ar: "Arabic", zh: "Chinese", ja: "Japanese", id: "Indonesian", vi: "Vietnamese", th: "Thai", pl: "Polish", tr: "Turkish", ko: "Korean" };
export const langName = (l: string) => LANG_NAMES[l] ?? LANG_NAMES[l.split("-")[0]] ?? l;
/** Release-name hints are base languages ("pt"); a profile may say "pt-br". */
const base = (l: string) => l.split("-")[0];
/** Languages a "Multi-Subs" release (CR/Netflix/Amazon rip) usually includes. */
const MULTI_SET = new Set(["en", "es", "pt", "fr", "de", "it", "ar", "ru"]);

/** Beta(1,1)-smoothed share of observed files that had `lang`. */
function learnedProb(counts: Record<string, number> | undefined, total: number, lang: string) {
  return ((counts?.[lang] ?? 0) + 1) / (total + 2);
}

type Est = { lang: string; p: number; src: string };

export function rankRelease(p: ParsedRelease, info: ReleaseInfo, profile: Profile, learned: LearnedLang | null, known: Known = {}): Ranked {
  const flags: Flag[] = [];
  const h = p.hints;
  const group = (p.group ?? "").toLowerCase();
  const mode: WatchMode = profile.watchMode ?? "sub";
  const subWanted = (profile.subLangs.length ? profile.subLangs : ["en"]).map(base);
  const dubWanted = (profile.dubLangs ?? []).map(base);
  // Unknown original language → no original-audio check (never assume Japanese for a show we know nothing about).
  const original = (profile.originalLangs ?? ["ja"]).map(base);

  flags.push(info.protocol === "usenet" ? { key: "usenet", label: "Usenet", tone: "info" } : { key: "torrent", label: `Torrent${info.seeders != null ? ` · ${info.seeders} seeders` : ""}`, tone: info.seeders === 0 ? "warn" : "info" });

  // ---- P(sub)
  let sub: Est = { lang: subWanted[0], p: 0.35, src: "no language info in the name" };
  const considerSub = (lang: string, prob: number, src: string) => {
    if (prob > sub.p + 0.001 || (Math.abs(prob - sub.p) < 0.001 && subWanted.indexOf(lang) < subWanted.indexOf(sub.lang))) sub = { lang, p: prob, src };
  };
  const explicitOther = h.subs.filter((l) => !subWanted.includes(l));
  for (const lang of subWanted) {
    if (h.subs.includes(lang)) considerSub(lang, h.hardsub && h.hardsubLang === lang ? 0.92 : 0.97, "named in the title");
    else if (h.multiSubs) considerSub(lang, MULTI_SET.has(lang) ? 0.9 : 0.45, "Multi-Subs");
    if (learned && learned.total >= 3) considerSub(lang, learnedProb(learned.subs, learned.total, lang), `${p.group ?? "no group"}${p.platform ? ` ${p.platform}` : ""}: ${learned.subs[lang] ?? 0}/${learned.total} ${learned.origin}`);
    if (lang === "en" && EN_GROUPS.includes(group) && !h.jpMarket && !explicitOther.length) considerSub(lang, 0.88, `${p.group} usually has English subs`);
    if (lang === "en" && h.dualAudio && !h.jpMarket) considerSub(lang, 0.85, "dual audio (usually with English subs)");
    if (known.burnedIn && base(known.burnedIn.lang) === lang && !h.subs.length && !h.multiSubs) considerSub(lang, 0.9, `burned in (${known.burnedIn.note})`);
  }
  const namedWanted = subWanted.some((l) => h.subs.includes(l)) || h.multiSubs;
  let subReject: string | null = null;
  const subFlags: Flag[] = [];
  if (h.raw && !namedWanted) {
    sub = { lang: subWanted[0], p: 0.02, src: "raw (no subtitles)" };
    subReject = "raw release (no subtitles)";
    subFlags.push({ key: "raw", label: "Raw", tone: "bad" });
  }
  if (h.jpMarket && !namedWanted && !subWanted.includes("ja")) {
    sub = { lang: subWanted[0], p: 0.03, src: "Japanese-market release" };
    subReject ??= `Japanese-market release, no ${langName(subWanted[0])} subtitles`;
    subFlags.push({ key: "jpMarket", label: `JP market · no ${langName(subWanted[0])}`, tone: "bad" });
  }
  if (h.subs.includes("zh") && !namedWanted && !subWanted.includes("zh") && explicitOther.every((l) => l === "zh" || l === "ja")) {
    sub = { lang: subWanted[0], p: Math.min(sub.p, 0.05), src: "Chinese subtitles only" };
    subReject ??= "Chinese subtitles only";
    subFlags.push({ key: "chinese", label: "Chinese subs", tone: "bad" });
  } else if (explicitOther.length && !namedWanted && !h.hardsub) {
    sub = { lang: subWanted[0], p: Math.min(sub.p, 0.05), src: `${explicitOther.map(langName).join("/")} subtitles only` };
    subReject ??= `foreign subtitles only (${explicitOther.map(langName).join(", ")})`;
    subFlags.push({ key: "foreign", label: `${explicitOther.map(langName).join("/")} only`, tone: "bad" });
  }

  // ---- audio: original present? dub present?
  const hasOriginal = !h.audio.length || !original.length || h.audio.some((a) => original.includes(a)) || h.dualAudio;
  let dub: Est = { lang: dubWanted[0] ?? "en", p: 0.05, src: "no dub named in the title" };
  const considerDub = (lang: string, prob: number, src: string) => {
    if (prob > dub.p + 0.001) dub = { lang, p: prob, src };
  };
  for (const lang of dubWanted) {
    if (original.includes(lang)) continue;
    if (h.audio.includes(lang)) considerDub(lang, h.dualAudio && lang !== "en" ? 0.6 : 0.95, h.dualAudio ? "dual audio" : "dub named in the title");
    if (learned?.audio && learned.total >= 3) considerDub(lang, learnedProb(learned.audio, learned.total, lang), `${p.group ?? "no group"}: ${learned.audio[lang] ?? 0}/${learned.total} with ${langName(lang)} audio, ${learned.origin}`);
  }
  if (h.dualAudio) flags.push({ key: "dual", label: "Dual audio", tone: "info" });
  const dubOnly = h.audio.length > 0 && !hasOriginal;

  // ---- the watch mode decides what "meets the profile" means
  let best: Est;
  let reject: string | null = null;
  let placeholder = false;
  if (mode === "sub") {
    best = sub;
    reject = subReject ?? (dubOnly ? `${h.audio.map(langName).join("/")} dub without the original audio` : null);
    flags.push(...subFlags);
    if (dubOnly) flags.push({ key: "dub", label: `${h.audio.map(langName).join("/")} dub`, tone: "bad" });
  } else if (mode === "dub") {
    best = dub;
    if (dub.p < 0.2) reject = `no ${langName(dub.lang)} dub`;
  } else if (mode === "dual") {
    if ((h.dualAudio || hasOriginal) && dub.p >= 0.5) best = dub;
    else if (!subReject && !dubOnly) {
      best = { ...sub, p: sub.p * 0.7, src: `${sub.src}; sub only for now (a placeholder until a dual-audio release)` };
      placeholder = true;
    } else {
      best = dub;
      reject = subReject ?? `no ${langName(dub.lang)} dub`;
      flags.push(...subFlags);
    }
  } else {
    best = dub.p > sub.p ? dub : sub;
    if (subReject && dub.p < 0.2) reject = subReject;
    if (subReject && dub.p < 0.2) flags.push(...subFlags);
    // A dub in a language you didn't ask for, without the original audio, doesn't meet the profile either.
    if (!reject && dubOnly && dub.p < 0.2) {
      reject = `${h.audio.map(langName).join("/")} dub without the original audio`;
      flags.push({ key: "dub", label: `${h.audio.map(langName).join("/")} dub`, tone: "bad" });
    }
  }
  if (known.blocklisted) {
    reject = `blocklisted: ${known.blocklisted}`;
    flags.push({ key: "blocklisted", label: "Blocklisted", tone: "bad" });
  }

  const pct = Math.round(best.p * 100);
  const isDub = best === dub;
  const L = `${langName(best.lang)}${isDub ? " dub" : ""}`;
  if (!reject) {
    if (best.p >= 0.8) flags.push({ key: "lang", label: `${L} ${pct}%`, tone: "good" });
    else if (best.p >= 0.5) flags.push({ key: "lang", label: `${L} likely (${pct}%)`, tone: "warn" });
    else flags.push({ key: "lang", label: `${L} unknown (${pct}%)`, tone: "warn" });
    if (placeholder) flags.push({ key: "placeholder", label: "Sub only (placeholder)", tone: "warn" });
  }

  // ---- burn-in (only matters when subtitles are what's being watched)
  const burned = mode !== "dub" && ((h.hardsub && (h.hardsubLang === null || subWanted.includes(base(h.hardsubLang)))) || !!known.burnedIn);
  if (burned) {
    const res = known.burnedIn?.resolution ?? (p.resolution ? `${p.resolution}p` : null);
    const lang = langName(known.burnedIn?.lang ?? h.hardsubLang ?? sub.lang);
    flags.push({ key: "burnIn", label: `${lang} burned-in${res ? ` (${res})` : ""}`, tone: "warn" });
  }

  // ---- preference points
  let score = pct;
  const why: string[] = [`${pct}% ${L} (${best.src})`];
  if (!profile.noProtocolPreference && info.protocol === profile.protocolOrder[0]) {
    score += 15;
    why.push(info.protocol === "usenet" ? "Usenet (preferred)" : "torrent (preferred)");
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
  } else if (profile.preferUncensored && p.source === "bluray") score += 3; // BDs are usually the uncensored version
  // Dual audio is a bonus in every mode (never a penalty); in dual mode it's what's wanted.
  if (h.dualAudio) {
    score += mode === "dual" ? 20 : 2;
    if (mode === "dual") why.push("dual audio");
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
  } else if (perEp > 8e9 && profile.sizePreset !== "best") score -= 10;
  // ---- size preset (MB per minute, like Sonarr's quality definitions)
  if (info.size > 0 && perEp >= 90e6) {
    const preset = profile.sizePreset ?? "lean";
    const mbMin = perEp / 1e6 / (info.runtimeMin && info.runtimeMin >= 5 ? info.runtimeMin : 24); // runtime 0 = unknown
    const res = p.resolution ?? profile.resolution;
    const cap = LEAN_MB_PER_MIN[res] ?? (res > 1080 ? LEAN_MB_PER_MIN[2160] : res > 720 ? LEAN_MB_PER_MIN[1080] : res > 480 ? LEAN_MB_PER_MIN[720] : LEAN_MB_PER_MIN[480]);
    const gb = (perEp / 1e9).toFixed(1);
    const remux = /\bremux\b/i.test(p.raw);
    if (preset === "lean") {
      if (mbMin > cap) {
        score -= 35;
        flags.push({ key: "size", label: `Big for Lean (${gb} GB/ep)`, tone: "warn" });
        why.push(`${gb} GB per episode is over the Lean size (~${((cap * 24) / 1000).toFixed(1)} GB per 24 min)`);
      } else if (p.source === "web") score += 3;
    } else if (preset === "balanced") {
      if (p.source === "web") {
        score += 6;
        why.push("WEB-DL (preferred by Balanced)");
      }
    } else {
      if (remux) {
        score += 25;
        flags.push({ key: "size", label: "REMUX", tone: "good" });
        why.push("REMUX (best source)");
      } else if (p.source === "bluray" && mbMin > cap * 1.4) {
        score += 15;
        why.push(`high-bitrate Blu-ray (${gb} GB/ep)`);
      } else if (p.source === "web") score += 5;
      if (!remux && (MINI.test(p.raw) || ((p.codec === "hevc" || p.codec === "x265" || /\b(x265|hevc)\b/i.test(p.raw)) && mbMin < cap * 0.5))) {
        score -= 20;
        flags.push({ key: "size", label: "Small re-encode", tone: "warn" });
        why.push("a small re-encode (Best source prefers the original)");
      }
      if (LOSSLESS.test(p.raw)) {
        score += 8;
        why.push("lossless audio");
      }
    }
  }
  if (info.protocol === "torrent" && info.seeders === 0) {
    score -= 25;
    why.push("no seeders");
  }
  // An indexer whose download links keep failing goes behind equivalent releases elsewhere (still usable as a fallback).
  const ih = known.indexerHealth;
  if (ih?.off) {
    // The circuit breaker: shown, never picked automatically.
    reject = reject ?? `${info.indexer ?? "its indexer"} is off for grabbing (downloads kept failing${ih.lastWhy ? `: ${ih.lastWhy}` : ""})`;
    flags.push({ key: "indexerOff", label: `${info.indexer ?? "Indexer"} is off`, tone: "bad" });
  } else if (ih && ih.failures > 0) {
    const bad = ih.failures >= 2 && ih.failures > ih.ok;
    score -= bad ? 40 : 10;
    flags.push({ key: "indexerHealth", label: `${info.indexer ?? "Indexer"} failing lately (${ih.failures})`, tone: bad ? "bad" : "warn" });
    why.push(`${info.indexer ?? "its indexer"}'s downloads failed ${ih.failures}× lately`);
  }
  if (known.inLibrary) flags.push({ key: "inLibrary", label: "Same as your library copy", tone: "info" });
  if (p.batch) flags.push({ key: "batch", label: "Batch", tone: "info" });

  return { accept: !reject, score: reject ? -1000 + score : score, langProb: best.p, lang: best.lang, langSource: best.src, flags, why: reject ? `skipped: ${reject}` : why.join(", "), reject };
}

/** Sort: accepted before rejected, then score; stable for equal scores. */
export function compareRanked<T extends { rank: Ranked }>(a: T, b: T) {
  return Number(b.rank.accept) - Number(a.rank.accept) || b.rank.score - a.rank.score;
}
