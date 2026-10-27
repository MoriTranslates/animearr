/**
 * Errors in plain words on the browser side, shared by every screen. The server already words connection errors
 * (server/errors.ts) and sends the raw text as `detail`; this keeps that detail per message (so a toast or an error
 * box can offer "Details"), words the browser's own failures ("Failed to fetch" = AnimeArr itself didn't answer),
 * and drops a leftover "Something went wrong: " prefix.
 */
const details = new Map<string, string>();

/** The raw text behind a worded error message (shown behind "Details"), when there is one. */
export const detailFor = (msg: string) => details.get(msg) ?? null;

export function rememberDetail(msg: string, detail: string | null | undefined) {
  if (!detail || detail === msg) return;
  details.set(msg, detail);
  if (details.size > 50) details.delete(details.keys().next().value!);
}

/** A message for the user from anything thrown (an ApiError, a TypeError from fetch, a string). */
export function humanError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  // The browser couldn't reach AnimeArr itself (network down, server restarting).
  if (e instanceof TypeError && /fetch|network|load failed/i.test(raw)) {
    const msg = "AnimeArr didn't answer. Is it still running? Check the connection and try again.";
    rememberDetail(msg, raw);
    return msg;
  }
  const msg = raw.replace(/^Something went wrong: /i, "").trim();
  if (msg !== raw) rememberDetail(msg, raw);
  return msg || "That didn't work. Try again.";
}

/**
 * Copies text to the clipboard. The Clipboard API only works on https or localhost; on a plain-http LAN address
 * (http://192.168.1.10:8484) it's missing, so a hidden textarea + execCommand("copy") is the fallback. Returns
 * false when neither worked (the caller then selects the text and says "press Ctrl+C").
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the fallback */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

/** Selects an element's text (after a failed copy, so Ctrl+C / long-press copies it). */
export function selectText(el: HTMLElement | null) {
  if (!el) return;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return void (el.focus(), el.select());
  const r = document.createRange();
  r.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
}
