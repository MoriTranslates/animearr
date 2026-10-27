/**
 * Language codes in prose as full English names ("en" → "English", "pt-br" → "Brazilian Portuguese"), via
 * Intl.DisplayNames; anything it doesn't know stays as the code. Shared by every screen.
 */
let names: Intl.DisplayNames | null = null;
const SPECIAL: Record<string, string> = { und: "Unknown", zxx: "No language", mul: "Several languages" };

export function languageName(code: string | null | undefined): string {
  const c = String(code ?? "").trim();
  if (!c) return "";
  if (SPECIAL[c.toLowerCase()]) return SPECIAL[c.toLowerCase()];
  try {
    names ??= new Intl.DisplayNames(["en"], { type: "language" });
    // "pt-br" → "pt-BR" (DisplayNames wants the region upper-case).
    const tag = c.replace(/^([a-z]{2,3})[-_]([a-z]{2})$/i, (_, l: string, r: string) => `${l.toLowerCase()}-${r.toUpperCase()}`);
    const n = names.of(tag);
    return n && n.toLowerCase() !== tag.toLowerCase() ? n : c;
  } catch {
    return c;
  }
}

/** "en, ja" → "English, Japanese". */
export const languageNames = (codes: readonly string[]) => codes.map(languageName).filter(Boolean).join(", ");
