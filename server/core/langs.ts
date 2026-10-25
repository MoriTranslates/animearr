/** ISO 639-2 (media tracks, Sonarr mediaInfo) ↔ short BCP-47 codes used by profiles. */
const ISO2: Record<string, string> = {
  eng: "en", jpn: "ja", chi: "zh", zho: "zh", spa: "es", por: "pt", fre: "fr", fra: "fr", ger: "de", deu: "de", ita: "it", rus: "ru", ara: "ar",
  ind: "id", may: "ms", msa: "ms", tha: "th", vie: "vi", kor: "ko", pol: "pl", tur: "tr", dut: "nl", nld: "nl", swe: "sv", nor: "no", dan: "da",
  fin: "fi", hun: "hu", cze: "cs", ces: "cs", gre: "el", ell: "el", heb: "he", hin: "hi", ukr: "uk", rum: "ro", ron: "ro", fil: "fil", tgl: "fil",
  cat: "ca", per: "fa", fas: "fa", und: "und", cmn: "zh", yue: "zh", jp: "ja", jap: "ja",
};
const NAMES: Record<string, string> = { english: "en", japanese: "ja", chinese: "zh", mandarin: "zh", cantonese: "zh", spanish: "es", portuguese: "pt", french: "fr", german: "de", italian: "it", russian: "ru", arabic: "ar", korean: "ko", thai: "th", hindi: "hi", vietnamese: "vi", indonesian: "id", unknown: "und" };

/** One language token from a media track or Sonarr ("eng", "English", "pt-BR", "en") → short code. */
export function toLang(tok: string): string {
  const t = tok.trim().toLowerCase();
  if (!t) return "";
  if (ISO2[t]) return ISO2[t];
  if (NAMES[t]) return NAMES[t];
  const m = t.match(/^([a-z]{2,3})(?:[-_][a-z0-9]+)?$/);
  if (m) return ISO2[m[1]] ?? m[1];
  return t;
}

/** Sonarr mediaInfo strings ("eng/ara/chi", "English / Japanese") → unique short codes. */
export function langList(s: string | null | undefined): string[] {
  if (!s) return [];
  return [...new Set(s.split(/[/,|]/).map(toLang).filter(Boolean))];
}

/** Language hinted by a sidecar file name: "Show - S01E01.en.ass", ".eng.forced.srt", ".English.srt". */
export function sidecarLang(file: string): string | null {
  // Forced / signs-only sidecars are not full dialogue subtitles.
  if (/\.(forced|signs?|songs?)[.\]]/i.test(file)) return null;
  const m = file.toLowerCase().match(/\.([a-z]{2,3}(?:-[a-z]{2})?|english|japanese|spanish|french|german)(?:\.(?:forced|sdh|cc|default|signs|full))*\.(srt|ass|ssa|vtt|sub|sup)$/);
  return m ? toLang(m[1]) : null;
}
