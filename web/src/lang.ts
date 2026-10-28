/**
 * Language codes in prose as full names ("en" → "English", "ja" → "Japanese", "pt-br" → "Brazilian Portuguese"), via
 * Intl.DisplayNames; anything it doesn't know stays as the code (so nothing is lost). Shared by every screen.
 * (fix/playtest-view and fix/playtest-setup both add this file: this copy is a superset of both.)
 */
const ISO2: Record<string, string> = { eng: "en", jpn: "ja", chi: "zh", zho: "zh", spa: "es", por: "pt", fre: "fr", fra: "fr", ger: "de", deu: "de", ita: "it", rus: "ru", ara: "ar", ind: "id", may: "ms", msa: "ms", tha: "th", vie: "vi", kor: "ko", pol: "pl", tur: "tr", dut: "nl", nld: "nl", swe: "sv", nor: "no", dan: "da", fin: "fi", hun: "hu", cze: "cs", ces: "cs", gre: "el", ell: "el", heb: "he", hin: "hi", ukr: "uk", rum: "ro", ron: "ro", fil: "fil", tgl: "fil", cat: "ca", per: "fa", fas: "fa", jp: "ja", jap: "ja" };
const SPECIAL: Record<string, string> = { und: "Unknown", unknown: "Unknown", zxx: "No language", mul: "Several languages" };

let names: Intl.DisplayNames | null | undefined;
const display = () => {
  if (names === undefined)
    try {
      names = new Intl.DisplayNames(["en"], { type: "language", fallback: "code" });
    } catch {
      names = null;
    }
  return names;
};

export function languageName(code: string | null | undefined): string {
  const raw = String(code ?? "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (SPECIAL[lower]) return SPECIAL[lower];
  // "pt-br" → "pt-BR" (DisplayNames wants the region upper-case); three-letter codes → two-letter.
  const tag = ISO2[lower] ?? raw.replace(/^([a-z]{2,3})[-_]([a-z]{2})$/i, (_, l: string, r: string) => `${l.toLowerCase()}-${r.toUpperCase()}`);
  try {
    const n = display()?.of(tag);
    if (n && n.toLowerCase() !== tag.toLowerCase()) return n.charAt(0).toUpperCase() + n.slice(1);
  } catch {
    /* not a valid tag: keep the code */
  }
  return raw;
}

/** "en, ja" → "English, Japanese". */
export const languageNames = (codes: readonly string[]) => codes.map(languageName).filter(Boolean).join(", ");

/** "English, Indonesian and Thai" (unique, in order). */
export function languageList(codes: (string | null | undefined)[]): string {
  const list = [...new Set(codes.map(languageName).filter(Boolean))];
  try {
    return new Intl.ListFormat("en", { type: "conjunction" }).format(list);
  } catch {
    return list.join(", ");
  }
}
