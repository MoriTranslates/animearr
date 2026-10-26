/**
 * Notifications, minimal for 1.0: grabbed / imported / failed / paused by a download-folder rule, to Discord (webhook)
 * and/or ntfy, plus the in-app bell. Fed from the activity log, so every notification is also an activity entry.
 * Secrets (webhook URL, ntfy token) are stored encrypted and never logged.
 */
import { db, dbState } from "./db.js";
import { getSettings } from "./settings.js";

export type NotifyEvent = "grabbed" | "imported" | "failed" | "paused";
export const NOTIFY_EVENTS: NotifyEvent[] = ["grabbed", "imported", "failed", "paused"];

const ICON: Record<NotifyEvent, string> = { grabbed: "⬇️", imported: "✅", failed: "⚠️", paused: "⏸️" };
const TITLE: Record<NotifyEvent, string> = { grabbed: "Grabbed", imported: "Imported", failed: "Problem", paused: "Grabs paused" };

/** Which notification (if any) an activity entry is. */
export function eventOf(kind: string, why: string, detail: unknown): NotifyEvent | null {
  const d = (detail ?? {}) as { final?: boolean; grabId?: number };
  if (kind === "grab") return "grabbed";
  if (kind === "import") return d.final || (!d.grabId && /^Imported /.test(why)) ? "imported" : null;
  if (kind === "fail" || kind === "verify-fail") return "failed";
  if (kind === "info" && /^Grabs paused by|^Download-folder rule .* pauses/.test(why)) return "paused";
  return null;
}

let sentAt: number[] = [];

/** Sends one notification to the configured channels (at most 30 a minute; failures are noted, never thrown). */
export async function send(ev: NotifyEvent, title: string, body: string, deps = { fetch }) {
  const s = getSettings().notify;
  if (!s.events[ev]) return [];
  const now = Date.now();
  sentAt = sentAt.filter((t) => now - t < 60_000);
  if (sentAt.length >= 30) return [];
  sentAt.push(now);
  const head = `${ICON[ev]} ${TITLE[ev]}${title ? `: ${title}` : ""}`;
  const out: { channel: string; ok: boolean; why: string }[] = [];
  if (s.discordWebhook) {
    try {
      const r = await deps.fetch(s.discordWebhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "AnimeArr", content: `**${head}**\n${body}`.slice(0, 1900) }), signal: AbortSignal.timeout(15_000) });
      out.push({ channel: "discord", ok: r.ok, why: r.ok ? "sent" : `HTTP ${r.status}` });
    } catch (e) {
      out.push({ channel: "discord", ok: false, why: (e as Error).message });
    }
  }
  if (s.ntfyUrl) {
    try {
      const headers: Record<string, string> = { Title: head.replace(/[^\x20-\x7e]/g, "").trim() || TITLE[ev], Tags: ev === "failed" ? "warning" : ev === "paused" ? "pause_button" : ev === "imported" ? "white_check_mark" : "arrow_down" };
      if (s.ntfyToken) headers.Authorization = `Bearer ${s.ntfyToken}`;
      const r = await deps.fetch(s.ntfyUrl, { method: "POST", headers, body: body.slice(0, 3000), signal: AbortSignal.timeout(15_000) });
      out.push({ channel: "ntfy", ok: r.ok, why: r.ok ? "sent" : `HTTP ${r.status}` });
    } catch (e) {
      out.push({ channel: "ntfy", ok: false, why: (e as Error).message });
    }
  }
  return out;
}

/** Called for every activity entry: the bell always records it; Discord/ntfy when switched on. */
export function onDecision(kind: string, d: { title?: string; why: string; detail?: unknown }) {
  if (dbState.corrupt) return;
  const ev = eventOf(kind, d.why, d.detail);
  if (!ev) return;
  try {
    db.prepare("INSERT INTO notifications (at, event, title, body, read) VALUES (?, ?, ?, ?, 0)").run(Date.now(), ev, d.title ?? "", d.why);
    db.prepare("DELETE FROM notifications WHERE id <= (SELECT MAX(id) - 500 FROM notifications)").run();
  } catch {
    /* the bell is best effort */
  }
  void send(ev, d.title ?? "", d.why).catch(() => undefined);
}

export function bell(limit = 30) {
  const rows = db.prepare("SELECT id, at, event, title, body, read FROM notifications ORDER BY id DESC LIMIT ?").all(limit) as { id: number; at: number; event: NotifyEvent; title: string; body: string; read: number }[];
  const unread = (db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE read = 0").get() as { n: number }).n;
  return { unread, items: rows.map((r) => ({ ...r, read: !!r.read })) };
}

export function markRead() {
  db.prepare("UPDATE notifications SET read = 1 WHERE read = 0").run();
}
