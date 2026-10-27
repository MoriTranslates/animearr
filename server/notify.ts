/**
 * Notifications, minimal for 1.0: grabbed / imported / failed / paused by a download-folder rule, to Discord (webhook)
 * and/or ntfy, plus the in-app bell. Fed from the activity log, so every notification is also an activity entry.
 * Secrets (webhook URL, ntfy token) are stored encrypted and never logged.
 */
import { liveFixesFor, linkFor, type FixContext } from "./fixes.js";
import { db, dbState } from "./db.js";
import { getSettings } from "./settings.js";

export type NotifyEvent = "grabbed" | "imported" | "failed" | "paused" | "indexer";
export const NOTIFY_EVENTS: NotifyEvent[] = ["grabbed", "imported", "failed", "paused", "indexer"];

const ICON: Record<NotifyEvent, string> = { grabbed: "⬇️", imported: "✅", failed: "⚠️", paused: "⏸️", indexer: "🔌" };
const TITLE: Record<NotifyEvent, string> = { grabbed: "Grabbed", imported: "Imported", failed: "Problem", paused: "Grabs paused", indexer: "Indexer" };

/** Which notification (if any) an activity entry is. */
export function eventOf(kind: string, why: string, detail: unknown): NotifyEvent | null {
  const d = (detail ?? {}) as { final?: boolean; grabId?: number; breaker?: string };
  if (d.breaker === "off" || (d.breaker === "on" && /working again/.test(why))) return "indexer"; // the circuit breaker tripped / recovered
  if (kind === "grab") return "grabbed";
  if (kind === "import") return d.final || (!d.grabId && /^Imported /.test(why)) ? "imported" : null;
  if (kind === "fail" || kind === "verify-fail") return "failed";
  if (kind === "info" && /^Grabs paused by/.test(why)) return "paused"; // not the "no longer pauses" message
  return null;
}

let sentAt: number[] = [];
let chain: Promise<unknown> = Promise.resolve();

/**
 * Sends one notification to the configured channels, one at a time (Discord allows only a few per second). Grabbed
 * and imported are capped at 30 a minute; failed and paused always go out. Failures are noted, never thrown.
 */
export function send(ev: NotifyEvent, title: string, body: string, deps = { fetch }, link: string | null = null): Promise<{ channel: string; ok: boolean; why: string }[]> {
  const p = chain.then(() => sendNow(ev, title, body, deps ?? { fetch }, link));
  chain = p.catch(() => undefined);
  return p;
}

async function sendNow(ev: NotifyEvent, title: string, body: string, deps: { fetch: typeof fetch }, link: string | null) {
  const s = getSettings().notify;
  if (!s.events[ev] || (!s.discordWebhook && !s.ntfyUrl)) return [];
  const now = Date.now();
  sentAt = sentAt.filter((t) => now - t < 60_000);
  if (sentAt.length >= 30 && (ev === "grabbed" || ev === "imported")) return [];
  sentAt.push(now);
  const head = `${ICON[ev]} ${TITLE[ev]}${title ? `: ${title}` : ""}`;
  const out: { channel: string; ok: boolean; why: string }[] = [];
  if (s.discordWebhook) {
    try {
      const r = await deps.fetch(s.discordWebhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "AnimeArr", content: [...`**${head}**\n${body}`].slice(0, 1800).join("") + (link ? `\n${link}` : ""), allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(15_000) }); // release names can't ping anyone
      out.push({ channel: "discord", ok: r.ok, why: r.ok ? "sent" : `HTTP ${r.status}` });
      if (r.status === 429) await new Promise((res) => setTimeout(res, 2000)); // back off a little
    } catch (e) {
      out.push({ channel: "discord", ok: false, why: (e as Error).message });
    }
  }
  if (s.ntfyUrl) {
    try {
      const headers: Record<string, string> = { Title: head.replace(/[^\x20-\x7e]/g, "").trim() || TITLE[ev], Tags: ev === "failed" ? "warning" : ev === "paused" ? "pause_button" : ev === "imported" ? "white_check_mark" : "arrow_down" };
      if (s.ntfyToken) headers.Authorization = `Bearer ${s.ntfyToken}`;
      // Tapping the notification opens the item in AnimeArr (URL-encoded: headers must be plain ASCII).
      if (link)
        try {
          headers.Click = new URL(link).href;
        } catch {
          /* not a valid URL: no click target */
        }
      const r = await deps.fetch(s.ntfyUrl, { method: "POST", headers, body: body.slice(0, 3000), signal: AbortSignal.timeout(15_000) });
      out.push({ channel: "ntfy", ok: r.ok, why: r.ok ? "sent" : `HTTP ${r.status}` });
    } catch (e) {
      out.push({ channel: "ntfy", ok: false, why: (e as Error).message });
    }
  }
  return out;
}

/** Called for every activity entry: the bell always records it; Discord/ntfy when switched on. */
export function onDecision(kind: string, d: { title?: string; why: string; detail?: unknown; tvdbId?: number | null; episodeIds?: number[] }) {
  if (dbState.corrupt) return;
  const ev = eventOf(kind, d.why, d.detail);
  if (!ev) return;
  try {
    const det = (d.detail ?? {}) as { grabId?: number; movieId?: number };
    const ctx = { kind, grabId: det.grabId ?? null, tvdbId: d.tvdbId ?? null, movieId: det.movieId ?? null, episodeIds: d.episodeIds ?? [] };
    db.prepare("INSERT INTO notifications (at, event, title, body, read, ctx) VALUES (?, ?, ?, ?, 0, ?)").run(Date.now(), ev, d.title ?? "", d.why, JSON.stringify(ctx));
    db.prepare("DELETE FROM notifications WHERE id <= (SELECT MAX(id) - 500 FROM notifications)").run();
  } catch {
    /* the bell is best effort */
  }
  // After the caller's work (and any transaction) is done.
  const det2 = (d.detail ?? {}) as { grabId?: number; movieId?: number };
  const link = linkFor({ grabId: det2.grabId ?? null, tvdbId: d.tvdbId ?? null, movieId: det2.movieId ?? null }, getSettings().externalUrl ?? "");
  setImmediate(() => void send(ev, d.title ?? "", d.why, undefined, link).then((r) => r.filter((x) => !x.ok).forEach((x) => console.warn(`notification to ${x.channel} failed: ${x.why}`)), () => undefined));
}

export function bell(limit = 30) {
  const rows = db.prepare("SELECT id, at, event, title, body, read, ctx FROM notifications ORDER BY id DESC LIMIT ?").all(limit) as { id: number; at: number; event: NotifyEvent; title: string; body: string; read: number; ctx: string | null }[];
  const unread = (db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE read = 0").get() as { n: number }).n;
  return {
    unread,
    items: rows.map((r) => {
      const ctx = r.ctx ? (JSON.parse(r.ctx) as FixContext) : {};
      return { id: r.id, at: r.at, event: r.event, title: r.title, body: r.body, read: !!r.read, fixes: r.event === "failed" || r.event === "paused" ? liveFixesFor(r.body, ctx) : [], tvdbId: ctx.tvdbId ?? null, movieId: ctx.movieId ?? null };
    }),
  };
}

/** Marks what the user has seen (up to the newest shown) as read; anything newer stays unread. */
export function markRead(upToId: number) {
  db.prepare("UPDATE notifications SET read = 1 WHERE read = 0 AND id <= ?").run(upToId);
}
