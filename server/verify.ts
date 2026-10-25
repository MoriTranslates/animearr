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
}

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
    execFile(bin, ["-v", "error", "-show_entries", "stream=codec_type,codec_name:stream_tags=language,title:format=duration", "-of", "json", file], { timeout: 120_000, maxBuffer: 8 << 20 }, (err, stdout) => {
      if (err) return reject(new Error(`ffprobe failed: ${err.message.split("\n")[0]}`));
      try {
        const j = JSON.parse(stdout) as { streams?: { codec_type: string; tags?: { language?: string; title?: string } }[]; format?: { duration?: string } };
        const subs = new Set<string>();
        const audio = new Set<string>();
        let untagged = 0;
        for (const s of j.streams ?? []) {
          let l = toLang(s.tags?.language ?? "");
          if ((!l || l === "und") && s.tags?.title) l = NAME_LANG.find(([re]) => re.test(s.tags!.title!))?.[1] ?? l;
          if (s.codec_type === "subtitle") {
            if (!l || l === "und") untagged++;
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
        resolve({ subs: [...subs], audio: [...audio], durationSec: j.format?.duration ? Number(j.format.duration) : null, sidecars, untagged });
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
}

/** Does the file meet the profile? burnedIn: the user confirmed this season only exists with burned-in subs. */
export function judge(p: ProbeResult, profile: { subLangs: string[] }, expectedMin: number | null, burnedIn: string | null): VerifyVerdict {
  const subs = [...new Set([...p.subs, ...p.sidecars])];
  const haveSub = profile.subLangs.find((l) => subs.includes(l));
  const haveDub = profile.subLangs.find((l) => p.audio.includes(l));
  if (p.durationSec !== null && expectedMin) {
    const min = p.durationSec / 60;
    if (min < expectedMin * 0.6) return { ok: false, why: `only ${min.toFixed(1)} min long (expected about ${expectedMin}): a sample or a broken file`, subs, audio: p.audio };
  } else if (p.durationSec !== null && p.durationSec < 240) return { ok: false, why: `only ${Math.round(p.durationSec)} s long: a sample?`, subs, audio: p.audio };
  if (haveSub) return { ok: true, why: `has ${haveSub} subtitles${p.sidecars.includes(haveSub) ? " (sidecar file)" : ""}`, subs, audio: p.audio };
  if (haveDub) return { ok: true, why: `has ${haveDub} audio`, subs, audio: p.audio };
  if (burnedIn) return { ok: true, why: `no subtitle track, accepted because you confirmed this season only exists with burned-in ${burnedIn}`, subs, audio: p.audio };
  if (p.untagged) return { ok: false, why: `${p.untagged} subtitle track(s) without a language tag and none tagged ${profile.subLangs.join("/")}`, subs, audio: p.audio };
  return { ok: false, why: subs.length ? `subtitles ${subs.join("/")} only` : "no subtitles at all", subs, audio: p.audio };
}
