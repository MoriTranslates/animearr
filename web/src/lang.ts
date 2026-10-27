/**
 * Language codes in prose → full names ("en" → "English", "ja" → "Japanese", "pt-BR" → "Brazilian Portuguese").
 * Uses Intl.DisplayNames in the UI language; anything it can't name stays as the code (so nothing is lost).
 */
const ISO2: Record<string, string> = { eng: "en", jpn: "ja", chi: "zh", zho: "zh", spa: "es", por: "pt", fre: "fr", fra: "fr", ger: "de", deu: "de", ita: "it", rus: "ru", ara: "ar", ind: "id", may: "ms", msa: "ms", tha: "th", vie: "vi", kor: "ko", pol: "pl", tur: "tr", dut: "nl", nld: "nl", swe: "sv", nor: "no", dan: "da", fin: "fi", hun: "hu", cze: "cs", ces: "cs", gre: "el", ell: "el", heb: "he", hin: "hi", ukr: "uk", rum: "ro", ron: "ro", fil: "fil", tgl: "fil", cat: "ca", per: "fa", fas: "fa", jp: "ja", jap: "ja" };

let names: Intl.DisplayNames | null | undefined;
const display = () => {
  if (names === undefined)
    try {
      names = new Intl.DisplayNames([document.documentElement.lang || "en"], { type: "language", fallback: "code" });
    } catch {
      names = null;
    }
  return names;
};

export function languageName(code: string | null | undefined): string {
  const raw = (code ?? "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (lower === "und" || lower === "unknown") return "Unknown";
  const norm = ISO2[lower] ?? raw.replace("_", "-");
  try {
    const n = display()?.of(norm);
    if (n && n.toLowerCase() !== norm.toLowerCase()) return n.charAt(0).toUpperCase() + n.slice(1);
  } catch {
    /* not a valid tag: keep the code */
  }
  return raw;
}

/** "English, Indonesian and Thai" (unique, in order). */
export function languageList(codes: (string | null | undefined)[]): string {
  const list = [...new Set(codes.map(languageName).filter(Boolean))];
  try {
    return new Intl.ListFormat(document.documentElement.lang || "en", { type: "conjunction" }).format(list);
  } catch {
    return list.join(", ");
  }
}
