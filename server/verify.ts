/**
 * Stage 2 (VERIFY): facts about a downloaded file — language tracks, sidecars, duration, not a sample.
 * Uses ffprobe when the file is reachable from this machine (local path mappings), otherwise Sonarr's mediaInfo after import.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sidecarLang, toLang } from "./core/langs.js";

export interface ProbeResult {
  subs: string[];
  audio: string[];
  durationSec: number | null;
  sidecars: string[];
  /** Subtitle tracks with no language tag (und). */
  untagged: number;
  /** Languages that only have a forced / signs / songs track (these never count as subtitles). */
  forced?: string[];
}

/** A subtitle track that isn't full dialogue: forced flag, or a title like "Signs & Songs", "Forced". */
export const PARTIAL_TRACK = /^\W*(forced|signs?(\s*[&+/,]\s*songs?)?|songs?(\s*[&+/,]\s*signs?)?|s&s|karaoke|commentary)\W*$|\bforced\b|\(signs?(\s*[&+/]\s*songs?)?\)/i;
/** Titles that say the track is full dialogue win over the partial patterns ("English (Full + Songs)"). */
const FULL_TRACK = /\b(full|dialog(ue)?|complete)\b/i;

const NAME_LANG: [RegExp, string][] = [
  [/english|\beng\b/i, "en"],
  [/espa[ñn]ol|spanish|latino/i, "es"],
  [/portugu[eê]s|portuguese|brasil/i, "pt"],
  [/fran[cç]ais|french/i, "fr"],
  [/deutsch|german/i, "de"],
  [/italiano|italian/i, "it"],
  [/русский|russian/i, "ru"],
  [/العربية|arabic/i, "ar"],
  [/中文|简|繁|chinese/i, "zh"],
  [/日本語|japanese/i, "ja"],
];

export function ffprobe(file: string, bin = process.env.FFPROBE_PATH || "ffprobe"): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    execFile(bin, ["-v", "error", "-show_entries", "stream=codec_type,codec_name:stream_disposition=forced:stream_tags=language,title:format=duration", "-of", "json", file], { timeout: 120_000, maxBuffer: 8 << 20 }, (err, stdout) => {
      if (err) return reject(new Error(`ffprobe failed: ${err.message.split("\n")[0]}`));
      try {
        const j = JSON.parse(stdout) as { streams?: { codec_type: string; disposition?: { forced?: number }; tags?: { language?: string; title?: string } }[]; format?: { duration?: string } };
        const subs = new Set<string>();
        const forced = new Set<string>();
        const audio = new Set<string>();
        let untagged = 0;
        for (const s of j.streams ?? []) {
          let l = toLang(s.tags?.language ?? "");
          if ((!l || l === "und") && s.tags?.title) l = NAME_LANG.find(([re]) => re.test(s.tags!.title!))?.[1] ?? l;
          if (s.codec_type === "subtitle") {
            const title = s.tags?.title ?? "";
            const partial = s.disposition?.forced === 1 || (PARTIAL_TRACK.test(title) && !FULL_TRACK.test(title));
            if (!l || l === "und") untagged++;
            else if (partial) forced.add(l);
            else subs.add(l);
          } else if (s.codec_type === "audio" && l && l !== "und") audio.add(l);
        }
        const dir = path.dirname(file);
        const base = path.basename(file).replace(/\.[^.]+$/, "");
        const sidecars: string[] = [];
        try {
          for (const f of fs.readdirSync(dir)) {
            if (!f.startsWith(base)) continue;
            const sl = sidecarLang(f);
            if (sl) sidecars.push(sl);
          }
        } catch {
          /* ignore */
        }
        resolve({ subs: [...subs], audio: [...audio], durationSec: j.format?.duration ? Number(j.format.duration) : null, sidecars, untagged, forced: [...forced].filter((l) => !subs.has(l)) });
      } catch (e) {
        reject(e);
      }
    });
  });
}

export interface VerifyVerdict {
  ok: boolean;
  why: string;
  subs: string[];
  audio: string[];
  /** Machine-readable reason (the after-import check only acts alone on explicit evidence: forced-only or dub-only). */
  code?: "ok" | "short" | "forced-only" | "dub-only" | "untagged" | "wrong-subs" | "no-subs" | "no-dub";
}

export interface VerifyProfile {
  subLangs: string[];
  dubLangs?: string[];
  watchMode?: "sub" | "dub" | "dual" | "either";
  originalLangs?: string[];
}

/**
 * Does the file meet the profile (and its watch mode)? Facts only: tracks, sidecars, duration.
 * Forced / signs-only tracks never count as subtitles. burnedIn: the user confirmed this season only exists with
 * burned-in subs in that language (accepted in the sub modes).
 */
export function judge(p: ProbeResult, profile: VerifyProfile, expectedMin: number | null, burnedIn: string | null): VerifyVerdict {
  const base = (l: string) => l.split("-")[0];
  const subs = [...new Set([...p.subs, ...p.sidecars])];
  const mode = profile.watchMode ?? "sub";
  const subWanted = profile.subLangs.map(base);
  const dubWanted = (profile.dubLangs ?? []).map(base);
  const original = (profile.originalLangs ?? ["ja"]).map(base);
  const anyOriginal = !original.length; // original language unknown: don't judge the audio
  const out = (ok: boolean, why: string, code: VerifyVerdict["code"] = ok ? "ok" : undefined): VerifyVerdict => ({ ok, why, subs, audio: p.audio, code });
  if (p.durationSec !== null && expectedMin) {
    const min = p.durationSec / 60;
    if (min < expectedMin * 0.6) return out(false, `only ${min.toFixed(1)} min long (expected about ${expectedMin}): a sample or a broken file`, "short");
  } else if (p.durationSec !== null && p.durationSec < 240) return out(false, `only ${Math.round(p.durationSec)} s long: a sample?`, "short");
  const haveSub = subWanted.find((l) => subs.includes(l));
  const haveDub = dubWanted.find((l) => p.audio.includes(l) && !original.includes(l));
  const knownAudio = p.audio.filter((a) => a !== "und");
  const haveOriginal = anyOriginal || !knownAudio.length || knownAudio.some((a) => original.includes(a));
  const subWhy = haveSub ? `has full ${haveSub} subtitles${p.sidecars.includes(haveSub) ? " (sidecar file)" : ""}` : "";
  const forcedOnly = (p.forced ?? []).filter((l) => subWanted.includes(l));
  const noSubCode: VerifyVerdict["code"] = forcedOnly.length ? "forced-only" : p.untagged ? "untagged" : subs.length ? "wrong-subs" : "no-subs";
  const noSubWhy = forcedOnly.length
    ? `only a forced/signs ${forcedOnly.join("/")} track (not full dialogue subtitles)`
    : p.untagged
      ? `${p.untagged} subtitle track(s) without a language tag and none tagged ${subWanted.join("/")}`
      : subs.length
        ? `subtitles ${subs.join("/")} only`
        : "no subtitles at all";
  if (mode === "dub") return haveDub ? out(true, `has ${haveDub} audio`) : out(false, `no ${dubWanted.join("/")} audio (audio: ${p.audio.join("/") || "unknown"})`, "no-dub");
  if (mode === "dual") {
    if (haveDub && haveOriginal) return out(true, `dual audio: original + ${haveDub}${haveSub ? `, and ${haveSub} subtitles` : ""}`);
    if (haveSub) return out(true, `${subWhy}; sub only for now (a dual-audio release will replace it)`);
    if (burnedIn) return out(true, `no subtitle track, accepted because you confirmed this season only exists with burned-in ${burnedIn}`);
    return out(false, `no ${dubWanted.join("/")} audio and ${noSubWhy}`, noSubCode);
  }
  if (mode === "either") {
    if (haveSub) return out(true, subWhy);
    if (haveDub) return out(true, `has ${haveDub} audio`);
    if (burnedIn) return out(true, `no subtitle track, accepted because you confirmed this season only exists with burned-in ${burnedIn}`);
    return out(false, noSubWhy, noSubCode);
  }
  // sub: original audio + full subtitles. A dub alone is not enough.
  if (haveSub && haveOriginal) return out(true, subWhy);
  if (haveSub && !haveOriginal) return out(false, `${knownAudio.join("/")} audio only (a dub, without the original audio)`, "dub-only");
  if (burnedIn) return out(true, `no subtitle track, accepted because you confirmed this season only exists with burned-in ${burnedIn}`);
  return out(false, noSubWhy, noSubCode);
}
