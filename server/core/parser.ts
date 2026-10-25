/**
 * Anime release-name parser (PROPOSAL §6.3).
 *
 * Not a line-by-line port of Sonarr's ~109 ordered regexes: it is an anitomy-style pass that finds the *earliest*
 * episode marker and treats everything before it as the title. Sonarr's anime test cases are ported in
 * test/sonarr-anime.test.ts; deliberate deviations are listed there.
 *
 * Key differences from Sonarr:
 * - `S6 - 01` / `S6.-.01` is season 6 episode 1 (Sonarr: a multi-season pack, or title "X S6" + absolute 1).
 * - A season token in the title is split off (`Title S3 - 12` → title "Title", season 3), so aliases don't need it.
 * - Subtitle-language tokens are parsed per language instead of ignored (see `hints`).
 */

export type Source = "bluray" | "web" | "hdtv" | "dvd" | null;
export type SpecialKind = "ova" | "oad" | "ona" | "special" | "movie" | "ncop" | "nced" | "recap" | "pv" | null;

export interface LangHints {
  /** Subtitle languages explicitly named in the title (BCP-47-ish: en, fr, es, pt, de, it, ru, ar, zh, ja, id, vi, th, ko, pl, tr). */
  subs: string[];
  /** Audio languages named in the title (dual audio → ja + en). */
  audio: string[];
  /** "Multi-Subs", "Multiple Subtitle", "MultiSub". */
  multiSubs: boolean;
  dualAudio: boolean;
  /** Raw release (no subtitles), from a RAW token or a raw-only group. */
  raw: boolean;
  /** Explicit hardsub token, or a pattern that usually means burned-in subs. */
  hardsub: boolean;
  /** Language believed burned in, when known. */
  hardsubLang: string | null;
  /** Why hardsub is suspected (for the "why" text). */
  hardsubWhy: string | null;
  uncensored: boolean;
  censored: boolean;
  /** Japanese-market release (Japanese subs only / JP-only platform) with no other subtitle language named. */
  jpMarket: boolean;
}

export interface ParsedRelease {
  raw: string;
  group: string | null;
  title: string;
  /** Other titles found in the name, e.g. `(Tensei Shitara Ken Deshita, Dual-Audio, ...)` → "Tensei Shitara Ken Deshita". */
  altTitles: string[];
  season: number | null;
  /** Season range for multi-season packs (`S01-S03`). */
  seasons: number[];
  /** Season-relative episode numbers (`S06E01`, `S6 - 01`). */
  episodes: number[];
  /** Bare numbers (`- 78`, `#957`, `Ep 12` without a season): absolute or per-entry, the resolver decides. */
  absolute: number[];
  /** Decimal recap numbers (`12.5`). */
  specialNumber: number | null;
  special: SpecialKind;
  version: number;
  /** Season pack / batch (range, "Batch", "Complete", or a season with no episode). */
  batch: boolean;
  fullSeason: boolean;
  resolution: number | null;
  source: Source;
  /** Streaming service / platform token: CR, AMZN, NF, HIDIVE, ... */
  platform: string | null;
  codec: string | null;
  crc: string | null;
  year: number | null;
  /** True when the season came from a fan-style "S6 - 01" rather than SxxEyy. */
  fanSeason: boolean;
  hints: LangHints;
}

// ---------------------------------------------------------------- language/group knowledge

/** Groups whose releases are raw (no subtitles). Lower-case. */
const RAW_GROUPS = new Set(["ohys-raws", "leopard-raws", "snow-raws", "u3-web", "moozzi2", "dbd-raws", "reinforce", "beatrice-raws", "kawaiika-raws", "nanakoraws", "vcb-studio", "lowpower-raws", "jpbd", "raws-4u"]);
/** "-raws" groups that are actually subbed. */
const SUBBED_RAWS = new Set(["erai-raws", "tsundere-raws", "nc-raws", "lilith-raws", "skymoon-raws", "nekomoe kissaten&vcb-studio"]);
/** Groups that release Chinese subtitles (and usually only those). */
const ZH_GROUPS = ["7³acg", "7acg", "lolihouse", "sakurato", "nekomoe kissaten", "ani", "nc-raws", "lilith-raws", "skymoon-raws", "haruhana", "sweetsub", "mingy", "kitaujisub", "airota", "dmhy", "幻樱字幕组", "桜都字幕组", "喵萌奶茶屋", "北宇治字幕组", "ktxp", "jsum", "philosophy-raws", "kirara fantasia", "lpsub", "comicat", "fzsd", "hysub", "nanao", "ktnbytes"];
/** Groups that reliably carry English subtitles (seed values; the learned table refines them). */
export const EN_GROUPS = ["subsplease", "erai-raws", "ember", "asw", "judas", "varyg", "skyanime", "senpai", "tsundere-raws", "dkb", "anime time", "yameii", "cbm", "nep blanc", "fle", "deanzel", "kametsu", "golumpa", "horriblesubs", "cleo", "lostyears", "mtbb", "commie", "gjm", "kaleido-subs", "crimson subs", "ozi works", "geckyzz", "subsplus+", "toonshub", "anime chap", "nanda", "sam", "dae-p9", "beatrice", "koten_gars", "obscurerips", "vivid", "yurasuka", "ironclad", "sallysubs", "coalgirls", "dekinai", "doki", "underwater", "fff", "chihiro", "hatsuyuki", "naruto-kun.hu", "thighs", "smol", "arid", "sxales", "moozzi2-en", "bonkai77", "breeze", "anime land", "rasetsu", "zigzag", "sokudo", "pmr", "neko-raws-en", "kawaiika", "wtf-anime", "scy", "dragsterps", "hdb", "jacobswaggedup", "flugel", "mysteryprojects", "mihoyo"];
const ZH_RE = /\b(CHS|CHT|GB|BIG5|Chinese|CN|ZH|CHI)\b|简|繁|中文|字幕[组組社]|中字|國語|国语|内封|內封|简日|繁日|双语|雙語/i;

/** Platforms where releases are for the Japanese market (Japanese subs or none). */
const JP_PLATFORMS = /\b(ABEMA|U-?NEXT|Lemino|DMM(?:[ ._-]?TV)?|dAnime|d-?anime|Hulu[ ._-]?JP|AMZN[ ._-]?JP|NF[ ._-]?JP|FOD|TVer)\b/i;
const PLATFORMS: [RegExp, string][] = [
  [/\b(CR|Crunchyroll|CRUNCHYROLL)\b/, "CR"],
  [/\b(AMZN|Amazon)\b/i, "AMZN"],
  [/\b(NF|Netflix|NETFLIX)\b/, "NF"],
  [/\b(HIDIVE|HIDI)\b/i, "HIDIVE"],
  [/\b(DSNP|Disney\+?)\b/i, "DSNP"],
  [/\b(B-Global|Bilibili|BiliBili|BILI)\b/i, "B-Global"],
  [/\bWeTV\b/i, "WeTV"],
  [/\biQIYI\b/i, "iQIYI"],
  [/\bYouku\b/i, "Youku"],
  [/\bABEMA\b/i, "ABEMA"],
  [/\bU-?NEXT\b/i, "U-NEXT"],
  [/\bADN\b/, "ADN"],
  [/\bWAKANIM\b/i, "Wakanim"],
  [/\bMuse\b/, "Muse"],
  [/\bAniOne\b/i, "Ani-One"],
];
/** Chinese platforms: "ENG SUB" rips from them are often burned-in. */
const CN_PLATFORMS = new Set(["WeTV", "iQIYI", "Youku"]);

/** Subtitle-language tokens. Matched against the raw title. */
const SUB_LANG: [string, RegExp][] = [
  ["en", /\b(eng(?:lish)?[ ._-]?(?:subs?|subbed|subtitles?|sub(?:titled)?)|eng[ ._-]?sub|EngSub|\[ENG\]|\(ENG\)|English(?!\s*Dub)|ENG(?=[\]\-&+ ,)]|$))|[\[(](?:[A-Z]{2,3}[-&+])*ENG(?:[-&+][A-Z]{2,3})*[\])]/i],
  ["fr", /\b(VOSTFR|VOSTF|FRENCH|TrueFrench|Fr[ ._-]?Subs?|SUB[ ._-]?FR)\b/i],
  ["es", /\b(ESP|Spanish|Espa[ñn]ol|LATINO|Castellano|CAST|VOSE|SUB[ ._-]?ESP|Sub[ ._-]?Español)\b/i],
  ["pt", /\b(LEGENDADO|PT-?BR|PTBR|Portugu[eê]s|Portuguese)\b/i],
  ["de", /\b(GerSub|Ger[ ._-]?Sub|German[ ._-]?Subs?|Deutsch[ ._-]?Sub|OmU)\b/i],
  ["it", /\b(SUB[ ._-]?ITA|ITA[ ._-]?SUB|Italian)\b/i],
  ["ru", /\b(RUS|Russian|AniLibria|AniDub|Anilibria[ ._]TV)\b/i],
  ["ar", /\b(Arabic|ARA)\b/i],
  ["id", /\b(Indonesian|SUB[ ._-]?INDO|Indo[ ._-]?Sub)\b/i],
  ["vi", /\b(Vietsub|Vietnamese)\b/i],
  ["th", /\b(Thai[ ._-]?Sub)\b/i],
  ["pl", /\b(PL[ ._-]?Sub|Napisy)\b/i],
  ["tr", /\b(Türkçe|Turkce|TR[ ._-]?Sub|turkseed|TURG)\b/i],
  ["ja", /\b(Japanese[ ._-]?Subs?|JP[ ._-]?Subs?|JPN[ ._-]?Subs?|JapSub)\b|日本語字幕/i],
];
/** Dubbed/audio tokens. */
const AUDIO_LANG: [string, RegExp][] = [
  ["en", /\b(English[ ._-]?Dub(?:bed)?|Eng[ ._-]?Dub|Dubbed)\b/i],
  ["fr", /\b(VF|VFF|French[ ._-]?Dub)\b/],
  ["es", /\b(Audio[ ._-]?Latino|Spanish[ ._-]?Dub|Latino)\b/i],
  ["de", /\b(German(?![ ._-]?Subs?)|GerDub|Deutsch(?![ ._-]?Sub))\b/i],
  ["it", /\b(ITA(?![ ._-]?SUB))\b/],
  ["pt", /\b(Dublado)\b/i],
  ["zh", /\b(Mandarin|Cantonese)\b|国语|國語/i],
];

// ---------------------------------------------------------------- helpers

const EXT = /\.(mkv|mp4|avi|m4v|ts|wmv|webm|nzb|torrent)$/i;
const isYear = (n: number) => n >= 1950 && n <= 2049;
const RES_RE = /\b(?:(\d{3,4})x(\d{3,4})|(2160|1080|720|576|540|480|360)[pi])\b|\b4K\b|\bUHD\b/i;
const CRC_RE = /[\[(]([A-F0-9]{8})[\])]/i;

/** Brackets/parens that are only release metadata (resolution, codec, crc, source...). */
const META_TOKEN =
  /^(?:\d{3,4}p|\d{3,4}x\d{3,4}|[A-F0-9]{8}|batch|complete|web(?:[ -]?(?:dl|rip))?|bd(?:rip)?|blu-?ray|dvd(?:rip)?|hevc|avc|x26[45]|h\.?26[45]|av1|aac.*|flac.*|opus.*|e?ac3.*|dts.*|hi10p?|10[ -]?bits?|8[ -]?bits?|multi.*|dual.*|eng.*|english.*|vostfr.*|raw|mkv|mp4|uncensored|uncut|v\d|end|fin(?:al)?|hdr|sdr|remux|\d+bit|cr|amzn|nf|hidive|dsnp|b-global|japanese.*sub.*|jp.*sub.*)$/i;

function cleanSpaces(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

/** Usenet/indexer decorations: `.mkv-[N-Z-B]-xpost`, `[UNRAR]`, `-xpost`. */
function stripDecorations(s: string): string {
  let t = s.trim();
  for (let i = 0; i < 3; i++) {
    t = t
      .replace(/-?\[?N-Z-B\]?/gi, "")
      .replace(/[-.]xpost$/i, "")
      .replace(/\.?\[UNRAR\]/gi, "")
      .replace(EXT, "")
      .replace(/[-. ]+$/, "")
      .trim();
  }
  return t;
}

function detectHints(raw: string, group: string | null, platform: string | null): LangHints {
  const g = (group ?? "").toLowerCase();
  const subs = new Set<string>();
  for (const [lang, re] of SUB_LANG) if (re.test(raw)) subs.add(lang);
  // "Japanese Sub" must not count as English because of the generic ENG pattern; nothing to do — patterns are disjoint.
  if (ZH_RE.test(raw) || ZH_GROUPS.some((z) => g === z || g.split(/\s*[&+x×]\s*/).includes(z))) subs.add("zh");
  const audio = new Set<string>();
  for (const [lang, re] of AUDIO_LANG) if (re.test(raw)) audio.add(lang);
  const multiSubs = /\bmulti[ ._-]?subs?\b|\bmultiple[ ._-]?subtitles?\b|\bmultisubs?\b|\bmulti[ ._-]?sub\b/i.test(raw) || /\bMULTi\b/.test(raw);
  const dualAudio = /\bdual[ ._-]?audio\b|\bDUAL\b|\b(?:JP|JPN|JAP)[ ._+&-]+(?:EN|ENG)\b|\bMulti[ ._-]?Audio\b/i.test(raw);
  if (dualAudio) {
    audio.add("ja");
    audio.add("en");
  }
  const rawToken = /(^|[\s._\[(-])RAWS?([\s._\])-]|$)/.test(raw) && !/-raws\]/i.test(raw.slice(0, 40));
  const rawGroup = RAW_GROUPS.has(g) || (/-raws$/.test(g) && !SUBBED_RAWS.has(g));
  const explicitSub = subs.size > 0 || multiSubs;
  const raw_ = (rawGroup || rawToken) && !(explicitSub && !rawGroup) && !SUBBED_RAWS.has(g);

  let hardsub = false;
  let hardsubLang: string | null = null;
  let hardsubWhy: string | null = null;
  if (/内嵌|內嵌|硬字幕/.test(raw)) {
    // Chinese "embedded" = burned-in (usually Chinese, sometimes with Japanese).
    hardsub = true;
    hardsubLang = "zh";
    hardsubWhy = "Chinese release with embedded (burned-in) subtitles";
  } else if (/\b(hard[ ._-]?subs?|hardsubbed|burned[ ._-]?in|burnt[ ._-]?in|\bHC\b)\b|\[HS\]/i.test(raw)) {
    hardsub = true;
    hardsubWhy = "the name says hardsub";
    hardsubLang = subs.size === 1 ? [...subs][0] : null;
  } else if (platform === "AMZN" && /\bEnglish[ ._-]Sub\b/i.test(raw) && !multiSubs) {
    // Amazon (JP storefront) rips tagged "English-Sub" (singular, not Multi-Subs) are usually burned-in English.
    hardsub = true;
    hardsubLang = "en";
    hardsubWhy = "Amazon rip tagged English-Sub (usually burned in)";
  } else if (platform && CN_PLATFORMS.has(platform) && subs.has("en") && !multiSubs && !/\bsoft[ ._-]?subs?\b/i.test(raw)) {
    hardsub = true;
    hardsubLang = "en";
    hardsubWhy = `${platform} rip with English subs (often burned in)`;
  }

  const uncensored = /\b(uncensored|uncut|uncen)\b|無修正|无修|無修/i.test(raw);
  const censored = !uncensored && /\bcensored\b/i.test(raw);
  const jpPlatform = JP_PLATFORMS.test(raw);
  const jpMarket = (subs.has("ja") || jpPlatform) && ![...subs].some((l) => l !== "ja") && !multiSubs;
  return { subs: [...subs], audio: [...audio], multiSubs, dualAudio, raw: raw_, hardsub, hardsubLang, hardsubWhy, uncensored, censored, jpMarket };
}

// ---------------------------------------------------------------- main

interface Marker {
  at: number;
  end: number;
  season?: number;
  seasonsTo?: number;
  episodes?: number[];
  absolute?: number[];
  special?: number;
  version?: number;
  batch?: boolean;
  fullSeason?: boolean;
  fan?: boolean;
  /** Weak markers (bare trailing numbers) only count when no strong marker exists. */
  weak?: boolean;
}

const range = (a: number, b: number) => (b >= a && b - a < 2000 ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a]);

export function parseRelease(input: string): ParsedRelease {
  const raw = input;
  let s = stripDecorations(input);

  // Path → last component (manual-import file names).
  if (/[\\/]/.test(s)) s = s.split(/[\\/]/).filter(Boolean).pop() ?? s;

  // CJK brackets → square brackets; full-width spaces.
  s = s.replace(/【/g, "[").replace(/】/g, "]").replace(/　/g, " ");

  // ---- group: leading [Group] (possibly several: [WtF-aNiMe][SCY]) or trailing -GROUP (scene).
  let group: string | null = null;
  const lead = s.match(/^\s*\[([^\]]{1,60})\]\s*/);
  if (lead && !/^\d+$/.test(lead[1]) && !RES_RE.test(lead[1])) {
    group = lead[1].trim();
    s = s.slice(lead[0].length);
    // A second leading bracket that looks like a group tag ([F-B], [SCY]).
    const lead2 = s.match(/^\s*\[([A-Za-z][\w.& -]{0,20})\]\s*[._ ]?/);
    if (lead2 && !META_TOKEN.test(lead2[1]) && !/^\d/.test(lead2[1])) s = s.slice(lead2[0].length);
  }
  s = s.replace(/^[._\s-]+/, "");

  // ---- dot/underscore separated names → spaces (keep "H.264", "AAC2.0", "12.5" intact).
  const dots = (s.match(/\./g) ?? []).length;
  const unders = (s.match(/_/g) ?? []).length;
  const spaces = (s.match(/ /g) ?? []).length;
  if (unders > spaces) s = s.replace(/_/g, " ");
  if (dots > spaces && dots >= 2)
    s = s
      .replace(/(\d)\.(?=\d(?:\D|$))/g, "$1\u0001")
      .replace(/\b([Hh])\.(26[45])/g, "$1\u0001$2")
      .replace(/\./g, " ")
      .replace(/\u0001/g, ".");
  s = cleanSpaces(s);

  // Trailing scene group "-GROUP" (only when no bracket group).
  if (!group) {
    const tail = s.match(/-([A-Za-z0-9][A-Za-z0-9+._]{1,20})$/);
    if (tail && !/^\d+$/.test(tail[1]) && /\b(?:\d{3,4}p|WEB|BluRay|BDRip|HDTV|x26[45]|H\.?26[45]|HEVC|AVC|AAC|DUAL|MULTi)\b/i.test(s)) {
      group = tail[1];
      s = s.slice(0, -tail[0].length).trim();
    }
  }
  // Trailing [Group] when no leading group: "Anime Title the Final - 09 (2021) [SubsPlease] [WEBRip] [HD 1080p]"
  if (!group) {
    const brs = [...s.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]).filter((x) => !META_TOKEN.test(x.trim()) && !/\d{3,4}p|x26|hevc|aac|web|hd\b/i.test(x) && /^[A-Za-z][\w &.+-]{1,24}$/.test(x.trim()));
    if (brs.length) group = brs[0].trim();
  }

  // ---- tags on the whole string
  const resM = s.match(RES_RE);
  let resolution: number | null = null;
  if (resM) resolution = resM[3] ? Number(resM[3]) : resM[2] ? Number(resM[2]) : 2160;
  if (resolution && resolution > 2160) resolution = null;
  if (resM?.[1] && resM[2]) resolution = Number(resM[2]) >= 1000 ? 1080 : Number(resM[2]) >= 700 ? 720 : Number(resM[2]) >= 540 ? 576 : 480;
  if (resM?.[1] && Number(resM[1]) >= 3800) resolution = 2160;
  const source: Source = /\b(BD|BDRip|BDRemux|Blu-?Ray|BRRip|BDMV)\b/i.test(s) ? "bluray" : /\bWEB(?:[ ._-]?(?:DL|Rip))?\b|\bWEBRip\b/i.test(s) ? "web" : /\bHDTV\b/i.test(s) ? "hdtv" : /\bDVD(?:Rip)?\b/i.test(s) ? "dvd" : null;
  let platform: string | null = null;
  for (const [re, name] of PLATFORMS) if (re.test(s)) {
    platform = name;
    break;
  }
  const codec = /\bAV1\b/i.test(s) ? "AV1" : /\b(x265|HEVC|H\.?265)\b/i.test(s) ? "HEVC" : /\b(x264|AVC|H\.?264)\b/i.test(s) ? "AVC" : null;
  const crc = s.match(CRC_RE)?.[1]?.toUpperCase() ?? null;
  const yearM = s.match(/[([](19[5-9]\d|20[0-4]\d)[)\]]|\s(19[5-9]\d|20[0-4]\d)(?=\s|$)/);
  const year = yearM ? Number(yearM[1] ?? yearM[2]) : null;

  // ---- alt titles from a parenthesised group: "(Tensei Shitara Ken Deshita, Dual-Audio, English-Sub)"
  const altTitles: string[] = [];
  for (const m of s.matchAll(/\(([^()]{4,})\)/g)) {
    for (const part of m[1].split(/[;,]/)) {
      const p = part.trim();
      if (p.length < 4 || META_TOKEN.test(p) || /\b(sub|subs|audio|dub|uncensored|web|1080|720|batch|season|bd|dual|multi)\b/i.test(p) || /^\d/.test(p)) continue;
      altTitles.push(p);
    }
  }

  // ---- markers. Work on a copy where bracket contents can't masquerade as episode numbers, but keep positions.
  const work = s.replace(/\[[^\]]*\]|\{[^}]*\}/g, (m) => {
    // Keep "[05]" / "[01-05]" / "[第07话]" style episode brackets visible.
    if (/^\[(\d{1,4})(?:v\d)?\]$/.test(m) || /^\[\d{1,4}\s*[-~]\s*\d{1,4}\]$/.test(m) || /第\s*\d+\s*[话話集]/.test(m)) return m.replace(/[\[\]]/g, " ");
    return " ".repeat(m.length);
  });

  const markers: Marker[] = [];
  const push = (m: RegExpExecArray | RegExpMatchArray, mk: Omit<Marker, "at" | "end">) => markers.push({ at: m.index!, end: m.index! + m[0].length, ...mk });
  let m: RegExpExecArray | null;

  // S01E02(-E03|E03)(v2), S01E01-02
  const reSE = /\bS(\d{1,2})[ ._]?E(\d{1,4})(?:v(\d))?(?:(?:[-~]|-?E)E?(\d{1,4})(?!\d))?(?:v(\d))?/gi;
  while ((m = reSE.exec(work))) push(m, { season: +m[1], episodes: m[4] ? range(+m[2], +m[4]) : [+m[2]], version: Number(m[3] ?? m[5] ?? 1) });
  // 10x14
  const reX = /\b(\d{1,2})x(\d{2,3})\b/g;
  while ((m = reX.exec(work))) if (!(Number(m[1]) > 99 || /\d{3,4}x\d{3,4}/.test(m[0]))) push(m, { season: +m[1], episodes: [+m[2]] });
  // Multi-season pack: S01-S03 / Season 1-3 (the second S is REQUIRED, unlike Sonarr's regex).
  const reMS = /\bS(\d{1,2})\s*[-~]\s*S(\d{1,2})\b|\bSeasons?\s*(\d{1,2})\s*[-~]\s*(\d{1,2})\b/gi;
  while ((m = reMS.exec(work))) push(m, { season: +(m[1] ?? m[3]), seasonsTo: +(m[2] ?? m[4]), batch: true, fullSeason: true });
  // Fan style "S6 - 01", "S7 - 09v2", "S03 - EP14", "S3 -  15", "S2 - Episode 4"
  const reFan = /\bS(\d{1,2})\s+-\s+(?:EP?\s?|Episode\s)?(\d{1,4})(?:v(\d))?(?:\s*[-~]\s*(\d{1,4}))?(?![\d.])/gi;
  while ((m = reFan.exec(work))) push(m, { season: +m[1], episodes: m[4] ? range(+m[2], +m[4]) : [+m[2]], version: Number(m[3] ?? 1), fan: true, batch: !!m[4] });
  // "Season 2 - 05", "(Season 2) - 33"
  const reSeasonDash = /\(?\bSeason\s+(\d{1,2})\)?\s+-\s+(\d{1,4})(?:v(\d))?(?![\d.])/gi;
  while ((m = reSeasonDash.exec(work))) push(m, { season: +m[1], episodes: [+m[2]], version: Number(m[3] ?? 1), fan: true });
  // "6th Season" / "Season 6" / "S01" without an episode → season token (pack if nothing else).
  const reOrd = /\b(\d{1,2})(?:st|nd|rd|th)\s+Season\b/gi;
  while ((m = reOrd.exec(work))) push(m, { season: +m[1], fullSeason: true, batch: true });
  const reSeasonOnly = /\(?\bSeason\s+(\d{1,2})\b\)?|\bS(\d{1,2})\b(?!\s*-\s*\d)(?![ ._]?E\d)/gi;
  while ((m = reSeasonOnly.exec(work))) push(m, { season: +(m[1] ?? m[2]), fullSeason: true, batch: true });
  // Ranges: "(01-12)", "01~10", "01 - 119", "091-123", "[01-05]", "Ep01-12", "Episode 99-100", "1-13"
  const reRange = /(?:^|\s|\(|-\s)(?:EP?|Episode\s?)?(\d{1,4})\s*(?:[-~]|\s-\s)\s*(\d{1,4})(?=\s|\)|$|v\d)/gi;
  while ((m = reRange.exec(work))) {
    const a = +m[1];
    const b = +m[2];
    const spacedDash = /\d\s+-\s+\d/.test(m[0]);
    const batchWord = /(batch|complete)/i.test(s);
    if (spacedDash && !(m[1].startsWith("0") || batchWord)) continue;
    if (b > a && !(isYear(a) || isYear(b)) && b - a < 1500) {
      const off = m[0].search(/\d/);
      const idx = m.index + off - (/(?:EP?|Episode\s?)$/i.test(m[0].slice(0, off)) ? m[0].slice(0, off).match(/(?:EP?|Episode\s?)$/i)![0].length : 0);
      markers.push({ at: idx, end: m.index + m[0].length, absolute: range(a, b), batch: true });
    }
  }
  // Decimal recap "- 12.5", "- 26.5.1"
  const reDec = /\s-\s(\d{1,4})\.(\d)(?:\.\d)?(?=\s|$|\()/g;
  while ((m = reDec.exec(work))) push(m, { special: Number(`${m[1]}.${m[2]}`) });
  // " - 78", " - 09v2", "-01" (Hatsuyuki), "- 01(DVD)"
  const reDash = /(?:\s-\s?|(?<=[A-Za-z!?])-)(\d{1,4})(?:v(\d))?(?=\s|$|\(|\[|v\d|-)/g;
  while ((m = reDash.exec(work))) {
    const n = +m[1];
    if (isYear(n) && m[1].length === 4) continue;
    const rest = work.slice(m.index + m[0].length);
    if (/^\s+[A-Za-z]/.test(rest) && !/^\s+-/.test(rest) && /\s-\s?\d{1,4}(?:v\d)?(?=\s|$|\(|\[)/.test(rest)) continue;
    push(m, { absolute: [n], version: Number(m[2] ?? 1) });
  }
  // EP06 / Ep01 / E1135 / Episode 56 / e66 / #957 / 第07话 / {01}
  const reEp = /(?:\bEP?|\bEpisode\s?|\bEpisodio\s|#|\be)(\d{1,4})(?:v(\d))?(?![\d.x])|第\s*(\d{1,4})\s*[话話集]/gi;
  while ((m = reEp.exec(work))) {
    // "E1135" must not be part of SxxEyy (handled above).
    if (/S\d{1,2}[ ._]?$/i.test(work.slice(Math.max(0, m.index - 4), m.index))) continue;
    push(m, { absolute: [+(m[1] ?? m[3])], version: Number(m[2] ?? 1) });
  }
  // "[01]" / "[05v2]" episode in brackets (Chinese/Russian style)
  const reBrEp = /\[(\d{1,4})(?:v(\d))?\]/g;
  while ((m = reBrEp.exec(s))) {
    const n = +m[1];
    if (isYear(n) && m[1].length === 4) continue;
    push(m, { absolute: [n], version: Number(m[2] ?? 1) });
  }
  // "{01}" in names like "Series Title (2010) {01} Episode Title"
  const reBrace = /\{(\d{1,4})\}/g;
  while ((m = reBrace.exec(s))) push(m, { absolute: [+m[1]] });
  // "69. Blm", "60.Bolum", "1. Bölüm" (Turkish)
  const reBolum = /\b(\d{1,4})\s?\.\s?(?:B[oö]l[uü]m|BLM)\b/gi;
  while ((m = reBolum.exec(work))) push(m, { absolute: [+m[1]] });
  // Weak: a bare number after the title: "Show One 07", "Some Anime Show 214", "Series Title 2018 06 720p"
  const reBare = /\s(\d{1,4})(?:v(\d))?(?=\s|$|\(|\[|v\d)/g;
  while ((m = reBare.exec(work))) {
    const n = +m[1];
    if ((isYear(n) && m[1].length === 4) || /^(2160|1080|720|576|540|480|360)$/.test(m[1])) continue;
    push(m, { absolute: [n], version: Number(m[2] ?? 1), weak: true });
  }

  // A single number inside a range marker ("- 01-12", "01 ~ 10") is part of the range.
  for (const r of markers.filter((x) => x.absolute && x.absolute.length > 1)) {
    for (let i = markers.length - 1; i >= 0; i--) {
      const x = markers[i];
      if (x !== r && x.absolute?.length === 1 && x.at >= r.at - 3 && x.at < r.end) markers.splice(i, 1);
    }
  }

  // ---- special markers (OVA, Movie, NCOP...)
  let special: SpecialKind = null;
  const spM = work.match(/\b(OVA|OAD|ONA|OVD|NCOP\d*|NCED\d*|Special|SP\d*|Movie|Gekijouban|Recap|PV|Tebie Pian|Tokubetsu-hen)\b|劇場版|剧场版|特别篇/i);
  if (spM) {
    const k = spM[0].toLowerCase();
    special = /^(ova|ovd)$/.test(k) ? "ova" : k === "oad" ? "oad" : k === "ona" ? "ona" : /^ncop/.test(k) ? "ncop" : /^nced/.test(k) ? "nced" : /movie|gekijouban|劇場版|剧场版/.test(k) ? "movie" : k === "recap" ? "recap" : k === "pv" ? "pv" : "special";
    if (k === "ona") special = null; // ONA is a format, not a special marker in names
  }

  // ---- choose markers: the title ends at the earliest strong marker.
  const strong = markers.filter((x) => !x.weak).sort((a, b) => a.at - b.at);
  const weak = markers.filter((x) => x.weak).sort((a, b) => a.at - b.at);
  // Season tokens (pack markers) only count as "strong" for the title end; episode info prefers real episode markers.
  let titleEnd = s.length;
  const firstStrong = strong[0];
  let chosen: Marker[] = strong;
  if (!strong.some((x) => x.episodes || x.absolute || x.special !== undefined) && weak.length) {
    // Only a season token (or nothing): accept the first weak number after it ("Title S1 05", "Show One 07").
    const afterTitle = weak.filter((w) => !firstStrong || w.at > firstStrong.at);
    if (afterTitle.length) {
      chosen = [...strong, afterTitle[0]];
      if (!firstStrong) titleEnd = afterTitle[0].at;
    }
  }
  if (firstStrong) titleEnd = Math.min(titleEnd, firstStrong.at);
  // A special word before any marker ends the title too ("Another OVA - The Other -Karma-", "Long Series - NCOP").
  if (spM && spM.index! < titleEnd && special && ["ova", "oad", "ncop", "nced"].includes(special)) titleEnd = spM.index!;
  // "Special" inside the title ("Another Anime With Special Naming") is not a special marker.
  if (spM && special === "special" && spM.index! < titleEnd) special = null;

  let season: number | null = null;
  let seasons: number[] = [];
  let episodes: number[] = [];
  let absolute: number[] = [];
  let specialNumber: number | null = null;
  let version = 1;
  let batch = false;
  let fullSeason = false;
  let fan = false;
  for (const mk of chosen.sort((a, b) => a.at - b.at)) {
    if (mk.season !== undefined) {
      if (season === null) season = mk.season;
      if (mk.seasonsTo) seasons = range(mk.season, mk.seasonsTo);
    }
    if (mk.episodes && !episodes.length) {
      episodes = mk.episodes;
      if (mk.season !== undefined) season = mk.season;
      fan = !!mk.fan;
    }
    if (mk.absolute && !absolute.length) absolute = mk.absolute;
    if (mk.special !== undefined && specialNumber === null) specialNumber = mk.special;
    if (mk.version && mk.version > version) version = mk.version;
    if (mk.batch) batch = true;
    if (mk.fullSeason) fullSeason = true;
  }
  // A dash number right after a fan "S6 - 01" is the same number; don't double-count.
  if (fan && absolute.length === 1 && episodes.length === 1 && absolute[0] === episodes[0]) absolute = [];
  // "S01E01-02 - 001-002" keeps both; SxxEyy plus a weak trailing number "S10E14 214" → absolute 214.
  if (episodes.length && !absolute.length) {
    const after = weak.find((w) => w.at >= (chosen.find((c) => c.episodes)?.end ?? 0));
    const absAfter = markers.find((x) => x.absolute && !x.weak && x.at > (chosen.find((c) => c.episodes)?.end ?? 0));
    if (absAfter) absolute = absAfter.absolute!;
    else if (after && after.absolute![0] > 0 && after.at - (chosen.find((c) => c.episodes)?.end ?? 0) <= 3) absolute = after.absolute!;
  }
  // "[K-F] Some Anime Show 214 10x14": absolute before the SxE.
  if (episodes.length && !absolute.length) {
    const epMk = chosen.find((c) => c.episodes);
    const before = epMk && !epMk.fan ? weak.find((w) => w.end >= epMk.at - 1 && w.end <= epMk.at + 1) : undefined;
    if (before) {
      absolute = before.absolute!;
      titleEnd = Math.min(titleEnd, before.at);
    }
  }
  if (episodes.length || absolute.length > 1 || specialNumber !== null) fullSeason = fullSeason && !episodes.length && absolute.length > 1;
  if (episodes.length || (absolute.length === 1 && !batch)) fullSeason = false;
  if (absolute.length > 1 || episodes.length > 1 || seasons.length > 1) batch = true;
  if (/\b(batch|complete(?: series| season)?)\b/i.test(s) && !(episodes.length === 1 && absolute.length <= 1)) batch = true;
  if (season !== null && !episodes.length && !absolute.length && specialNumber === null) fullSeason = true;
  if (episodes.length === 1 && absolute.length === 0) batch = false;
  if (absolute.length === 1 && !episodes.length && !fullSeason) batch = /\b(batch)\b/i.test(s) && false;

  // ---- title
  let title = s.slice(0, titleEnd);
  title = title.replace(/\[[^\]]*\]/g, " ").replace(/\{[^}]*\}/g, " ");
  // Year in parens stays (Sonarr keeps "Series Title (2014)"); trailing separators go.
  title = cleanSpaces(title).replace(/[\s\-–~|:,.]+$/, "").replace(/^[\s\-–~|:,.]+/, "");
  // Remove a trailing "(Season 2)" left by "Title (Season 2) - 33".
  title = title.replace(/\s*\(\s*Season\s+\d+\s*\)\s*$/i, "").trim();
  // Trailing ordinal season, "Season N" or "SN" inside the title: the season is already a marker.
  title = title.replace(/\s+\d{1,2}(?:st|nd|rd|th)\s+Season$/i, "").replace(/\s+Season\s+\d{1,2}$/i, "").replace(/\s+S\d{1,2}$/i, "").trim();
  title = title.replace(/[\s\-–~|:,([]+$/, "").trim();
  if (!title && group && !lead) title = group;

  const hints = detectHints(raw, group, platform);
  return {
    raw,
    group,
    title,
    altTitles: [...new Set(altTitles)].filter((a) => a.toLowerCase() !== title.toLowerCase()),
    season: specialNumber !== null && season === null ? null : season,
    seasons: seasons.length ? seasons : season !== null ? [season] : [],
    episodes,
    absolute,
    specialNumber,
    special,
    version,
    batch,
    fullSeason: fullSeason && !episodes.length && !absolute.length,
    resolution,
    source,
    platform,
    codec,
    crc,
    year,
    fanSeason: fan,
    hints,
  };
}
