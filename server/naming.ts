/**
 * Sonarr/Radarr-compatible file and folder naming. The same token syntax users already have in Sonarr/Radarr:
 *   {Series Title} {Series TitleYear} {Series CleanTitle} {Series TitleThe} {Series CleanTitleYear}
 *   {season:00} {episode:00} {absolute:000} {Episode Title} {Episode CleanTitle} {Air-Date} {Air Date}
 *   {Quality Full} {Quality Title} {MediaInfo Simple} {MediaInfo Full} {MediaInfo VideoCodec} {MediaInfo VideoBitDepth}
 *   {MediaInfo VideoDynamicRangeType} {MediaInfo AudioCodec} {MediaInfo AudioChannels} {MediaInfo AudioLanguages}
 *   {MediaInfo SubtitleLanguages} {Release Group} {Release Hash} {Original Title} {Original Filename}
 *   {Movie Title} {Movie TitleYear} {Movie CleanTitle} {Release Year} {ImdbId} {TmdbId} {Edition Tags}
 *   anime extras: {AniDB Title} {Subs Lang}
 * Token modifiers like Sonarr's: separators in the name ({Series.Title} → dots), case ({series title} → lower),
 * and prefix/suffix characters inside the braces that only appear when the value isn't empty ({-Release Group},
 * {[Quality Full]}, {( Edition Tags )}).
 */

export type ColonMode = "delete" | "dash" | "spaceDash" | "spaceDashSpace" | "smart";
export type MultiStyle = "extend" | "duplicate" | "repeat" | "scene" | "range" | "prefixedRange";

export interface NamingOptions { replaceIllegalCharacters: boolean; colonReplacement: ColonMode; multiEpisodeStyle: MultiStyle }

export interface MediaInfoCtx {
  videoCodec?: string | null;
  videoBitDepth?: number | null;
  videoDynamicRange?: string | null;
  audioCodec?: string | null;
  audioChannels?: number | null;
  audioLanguages?: string[];
  subtitleLanguages?: string[];
}
export interface EpisodeCtx {
  seriesTitle: string;
  seriesYear?: number | null;
  season: number;
  episodes: { episode: number; absolute?: number | null; title?: string | null; airDate?: string | null }[];
  quality?: string | null;
  qualityTitle?: string | null;
  mediaInfo?: MediaInfoCtx;
  releaseGroup?: string | null;
  releaseHash?: string | null;
  originalTitle?: string | null;
  originalFilename?: string | null;
  anidbTitle?: string | null;
}
export interface MovieCtx {
  movieTitle: string;
  year?: number | null;
  quality?: string | null;
  qualityTitle?: string | null;
  mediaInfo?: MediaInfoCtx;
  releaseGroup?: string | null;
  imdbId?: string | null;
  tmdbId?: number | null;
  edition?: string | null;
  originalTitle?: string | null;
  originalFilename?: string | null;
}

const pad = (n: number | null | undefined, fmt: string | undefined) => (n === null || n === undefined ? "" : fmt ? String(n).padStart(fmt.length, "0") : String(n));
const cleanTitle = (t: string) => t.replace(/[^\p{L}\p{N}\s.-]+/gu, "").replace(/\s+/g, " ").trim();
const titleThe = (t: string) => {
  const m = /^(The|A|An)\s+(.+)$/i.exec(t);
  return m ? `${m[2]}, ${m[1]}` : t;
};
const withYear = (t: string, y?: number | null) => (y && !/\(\d{4}\)$/.test(t) ? `${t} (${y})` : t);

const VIDEO: Record<string, string> = { h264: "x264", avc: "x264", hevc: "x265", h265: "x265", av1: "AV1", mpeg2video: "MPEG2", vc1: "VC1", vp9: "VP9" };
const AUDIO: Record<string, string> = { aac: "AAC", flac: "FLAC", dts: "DTS", truehd: "TrueHD", eac3: "EAC3", ac3: "AC3", opus: "Opus", mp3: "MP3", vorbis: "Vorbis", pcm_s16le: "PCM", pcm_s24le: "PCM" };
const langs = (l?: string[]) => {
  const u = [...new Set((l ?? []).map((x) => x.split("-")[0].toUpperCase()))].filter(Boolean);
  return u.length ? `[${u.join("+")}]` : "";
};

function mediaTokens(m: MediaInfoCtx = {}) {
  const v = m.videoCodec ? (VIDEO[m.videoCodec.toLowerCase()] ?? m.videoCodec.toUpperCase()) : "";
  const a = m.audioCodec ? (AUDIO[m.audioCodec.toLowerCase()] ?? m.audioCodec.toUpperCase()) : "";
  const ch = m.audioChannels ? (m.audioChannels === 6 ? "5.1" : m.audioChannels === 8 ? "7.1" : m.audioChannels === 2 ? "2.0" : m.audioChannels === 1 ? "1.0" : String(m.audioChannels)) : "";
  // Like Sonarr: audio languages only when there's more than English.
  const audioL = (m.audioLanguages ?? []).length && !(m.audioLanguages!.length === 1 && m.audioLanguages![0].startsWith("en")) ? langs(m.audioLanguages) : "";
  return {
    "mediainfo videocodec": v,
    "mediainfo videobitdepth": m.videoBitDepth ? String(m.videoBitDepth) : "",
    "mediainfo videodynamicrangetype": m.videoDynamicRange ?? "",
    "mediainfo videodynamicrange": m.videoDynamicRange ? "HDR" : "",
    "mediainfo audiocodec": a,
    "mediainfo audiochannels": ch,
    "mediainfo audiolanguages": audioL,
    "mediainfo audiolanguagesall": langs(m.audioLanguages),
    "mediainfo subtitlelanguages": langs(m.subtitleLanguages),
    "mediainfo simple": [v, a].filter(Boolean).join(" "),
    "mediainfo full": [[v, a].filter(Boolean).join(" "), audioL, langs(m.subtitleLanguages)].filter(Boolean).join(" "),
  };
}

/** Renders a format with a token table. Unknown tokens render empty (Sonarr: {Custom Formats}, {Preferred Words}…). */
export function render(format: string, values: Record<string, string>, opts: NamingOptions) {
  const token = (inner: string) => {
    const m = /^([^A-Za-z]*?)([A-Za-z][A-Za-z0-9 ._-]*?)(?::([0#]+))?([^A-Za-z0-9]*)$/.exec(inner);
    if (!m) return "";
    const [, prefix, rawName, fmt, suffix] = m;
    const sep = /[._]/.test(rawName.replace(/^mediainfo[._ ]/i, "")) && !/\s/.test(rawName) ? (rawName.includes("_") ? "_" : ".") : null;
    const key = rawName.replace(/[._]/g, " ").toLowerCase();
    const num = values[`${key}#num`];
    let v = fmt !== undefined ? (num !== undefined ? pad(Number(num), fmt) : "") : (values[key] ?? num ?? ""); // {season} = unpadded
    if (!v) return "";
    v = fixChars(v, opts); // colons/illegal characters in the value, before separators (like Sonarr)
    if (sep) v = v.replace(/\s+/g, sep).split(`${sep}-${sep}`).join(sep);
    if (rawName === rawName.toLowerCase() && /[a-z]/.test(rawName)) v = v.toLowerCase();
    else if (rawName === rawName.toUpperCase() && /[A-Z]/.test(rawName)) v = v.toUpperCase();
    return `${prefix}${v}${suffix}`;
  };
  // Radarr's nested tokens ({imdb-{ImdbId}}, {edition-{Edition Tags}}): literal braces around a value, or nothing.
  const nested = format.replace(/\{([^{}]*)\{([^{}]*)\}([^{}]*)\}/g, (_w, pre: string, inner: string, post: string) => {
    const v = token(inner);
    return v ? `\u0002${pre}${v}${post}\u0003` : "";
  });
  const out = nested.replace(/\{([^{}]*?)\}/g, (_whole, inner: string) => token(inner));
  return cleanName(out, opts).replace(/\u0002/g, "{").replace(/\u0003/g, "}");
}

/** Colons and illegal characters like Sonarr's settings. */
function fixChars(s: string, opts: NamingOptions) {
  let x = s;
  const colon = { delete: "", dash: "-", spaceDash: " -", spaceDashSpace: " - ", smart: "" }[opts.colonReplacement];
  if (opts.colonReplacement === "smart") x = x.replace(/(\d):(\d)/g, "$1-$2").replace(/\s*:\s*/g, " - ");
  else x = x.replace(/:/g, colon);
  if (opts.replaceIllegalCharacters) x = x.replace(/[\\/]/g, "+").replace(/[*?"<>|]/g, "");
  else x = x.replace(/[\\/:*?"<>|]/g, "");
  return x;
}

/** Illegal characters and colons like Sonarr; then tidy empty brackets and doubled separators. */
export function cleanName(s: string, opts: NamingOptions) {
  let x = fixChars(s, opts);
  x = x
    .replace(/\[\s*\]|\(\s*\)|\{\s*\}/g, "")
    .replace(/\s+-\s+(-\s+)+/g, " - ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\s+([\])])/g, "$1")
    .replace(/([[(])\s+/g, "$1")
    .replace(/^[\s.\-_]+|[\s\-_]+$/g, "")
    .replace(/\.$/, "");
  return x;
}

/** Episode numbers per the multi-episode style (S01E01-E03 etc.); single episodes just pad. */
function episodeNumbers(format: string, eps: number[], style: MultiStyle, epFmt: string) {
  const p = (n: number) => pad(n, epFmt);
  if (eps.length === 1) return p(eps[0]);
  const first = p(eps[0]);
  const last = p(eps[eps.length - 1]);
  switch (style) {
    case "extend":
      return `${first}-${eps.slice(1).map(p).join("-")}`;
    case "duplicate": // the whole SxxEyy is repeated by renderEpisode; this is the fallback without a season token
    case "repeat":
      return eps.map(p).join("E");
    case "scene":
      return `${first}-E${eps.slice(1).map(p).join("-E")}`;
    case "range":
      return `${first}-${last}`;
    case "prefixedRange":
      return `${first}-E${last}`;
  }
  void format;
}

/** Renders an episode file name (no extension) for a standard or absolute (anime) format. */
export function renderEpisode(format: string, c: EpisodeCtx, opts: NamingOptions) {
  const epFmt = /\{episode(?::(0+))?\}/i.exec(format)?.[1] ?? "";
  const absFmt = /\{absolute(?::(0+))?\}/i.exec(format)?.[1] ?? "";
  const eps = c.episodes.map((e) => e.episode);
  const abs = c.episodes.map((e) => e.absolute).filter((x): x is number => !!x);
  const titles = [...new Set(c.episodes.map((e) => e.title).filter((t): t is string => !!t && !/^TBA$/i.test(t)))];
  const title = titles.join(" + ");
  const air = c.episodes[0]?.airDate ?? "";
  // Multi-episode: render the numbers ourselves, then splice them in place of {episode:00}/{absolute:000}.
  const epText = episodeNumbers(format, eps, opts.multiEpisodeStyle, epFmt);
  const absText = abs.length ? (abs.length === 1 ? pad(abs[0], absFmt) : `${pad(abs[0], absFmt)}-${pad(abs[abs.length - 1], absFmt)}`) : "";
  // Duplicate (Sonarr): "S01E01 - S01E02", the season+episode pattern repeated per episode.
  const dupe = opts.multiEpisodeStyle === "duplicate" && eps.length > 1 ? /S\{season(?::(0+))?\}E\{episode(?::(0+))?\}/i.exec(format) : null;
  const f0 = dupe ? format.replace(dupe[0], "\u0001DU\u0001") : format;
  const duText = dupe ? eps.map((n) => `S${pad(c.season, dupe[1])}E${pad(n, dupe[2])}`).join(" - ") : "";
  const f = f0.replace(/\{episode(?::0+)?\}/gi, "\u0001EP\u0001").replace(/\{absolute(?::0+)?\}/gi, absText ? "\u0001AB\u0001" : "");
  const values: Record<string, string> = {
    "series title": c.seriesTitle,
    "series titleyear": withYear(c.seriesTitle, c.seriesYear),
    "series cleantitle": cleanTitle(c.seriesTitle),
    "series cleantitleyear": withYear(cleanTitle(c.seriesTitle), c.seriesYear),
    "series titlethe": titleThe(c.seriesTitle),
    "series titlewithoutyear": c.seriesTitle.replace(/\s*\(\d{4}\)$/, ""),
    "season#num": String(c.season),
    "episode title": title,
    "episode cleantitle": cleanTitle(title),
    "air-date": air,
    "air date": air.replace(/-/g, " "),
    "quality full": c.quality ?? "",
    "quality title": c.qualityTitle ?? c.quality ?? "",
    "release group": c.releaseGroup ?? "",
    "release hash": c.releaseHash ?? "",
    "original title": c.originalTitle ?? "",
    "original filename": c.originalFilename ?? "",
    "anidb title": c.anidbTitle ?? "",
    "subs lang": langs(c.mediaInfo?.subtitleLanguages).replace(/[[\]]/g, ""),
    ...mediaTokens(c.mediaInfo),
  };
  return render(f, values, opts).replace(/\u0001EP\u0001/g, epText).replace(/\u0001AB\u0001/g, absText).replace(/\u0001DU\u0001/g, duText);
}

export function renderSeriesFolder(format: string, c: { seriesTitle: string; seriesYear?: number | null; tvdbId?: number | null; anidbTitle?: string | null }, opts: NamingOptions) {
  return render(format, { "series title": c.seriesTitle, "series titleyear": withYear(c.seriesTitle, c.seriesYear), "series cleantitle": cleanTitle(c.seriesTitle), "series cleantitleyear": withYear(cleanTitle(c.seriesTitle), c.seriesYear), "series titlethe": titleThe(c.seriesTitle), "tvdbid": c.tvdbId ? String(c.tvdbId) : "", "anidb title": c.anidbTitle ?? "" }, opts);
}
export function renderSeasonFolder(format: string, season: number, opts: NamingOptions) {
  return render(format, { "season#num": String(season) }, opts);
}

export function renderMovie(format: string, c: MovieCtx, opts: NamingOptions) {
  const t = c.movieTitle;
  return render(
    format,
    {
      "movie title": t,
      "movie titleyear": withYear(t, c.year),
      "movie cleantitle": cleanTitle(t),
      "movie cleantitleyear": withYear(cleanTitle(t), c.year),
      "movie titlethe": titleThe(t),
      "release year": c.year ? String(c.year) : "",
      "quality full": c.quality ?? "",
      "quality title": c.qualityTitle ?? c.quality ?? "",
      "release group": c.releaseGroup ?? "",
      imdbid: c.imdbId ?? "",
      tmdbid: c.tmdbId ? String(c.tmdbId) : "",
      "edition tags": c.edition ?? "",
      "original title": c.originalTitle ?? "",
      "original filename": c.originalFilename ?? "",
      ...mediaTokens(c.mediaInfo),
    },
    opts,
  );
}
