/**
 * Notifications: grabbed / imported / failed / paused by a download-folder rule / indexer off, to Discord (webhook),
 * ntfy, and any number of extra channels (generic webhook, Telegram, Pushover, email: see notifyChannels.ts), plus the
 * in-app bell. Fed from the activity log, so every notification is also an activity entry.
 * Secrets (webhook URLs, tokens, passwords) are stored encrypted and never logged.
 */
import { liveFixesFor, linkFor, type FixContext } from "../system/fixes.js";
import { cache, db, dbState } from "../system/db.js";
import { getSettings } from "../system/settings.js";
import { summarize } from "../system/summary.js";
import { channelProblem, deliver, type ChannelDeps, type Note, type NotifyChannel, type NotifyMeta } from "./notifyChannels.js";
import { redactText } from "../system/redact.js";
import { safeFetch } from "../system/safeFetch.js";

/**
 * "Is this show quiet?" (scope.ts registers quietShow when it loads: notify can't import the library layer without an
 * import cycle). Until then nothing is quiet, so a notice is never lost to a missing rule.
 */
let quietRule: (tvdbId: number, episodeIds: number[]) => boolean = () => false;
export function setQuietRule(fn: typeof quietRule) {
  quietRule = fn;
}

export type NotifyEvent = "grabbed" | "imported" | "failed" | "paused" | "indexer";
export const NOTIFY_EVENTS: NotifyEvent[] = ["grabbed", "imported", "failed", "paused", "indexer"];

const ICON: Record<NotifyEvent, string> = { grabbed: "⬇️", imported: "✅", failed: "⚠️", paused: "⏸️", indexer: "🔌" };
const TITLE: Record<NotifyEvent, string> = {
  grabbed: "Grabbed",
  imported: "Imported",
  failed: "Problem",
  paused: "Grabs paused",
  indexer: "Indexer",
};

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

/** The last delivery result per channel ("discord", "ntfy" or a channel id), shown in Settings. In memory only. */
const lastResult = new Map<string, { at: number; ok: boolean; error: string | null }>();
export const channelStatus = () => Object.fromEntries(lastResult);
const note = (id: string, ok: boolean, why: string) => lastResult.set(id, { at: Date.now(), ok, error: ok ? null : why });

let sentAt: number[] = [];
let chain: Promise<unknown> = Promise.resolve();

/**
 * Sends one notification to the configured channels, one at a time (Discord allows only a few per second). Grabbed
 * and imported are capped at 30 a minute; failed and paused always go out. Failures are noted, never thrown.
 */
export function send(
  ev: NotifyEvent,
  title: string,
  body: string,
  deps: ChannelDeps = { fetch },
  link: string | null = null,
  meta: NotifyMeta = {},
): Promise<{ channel: string; id?: string; ok: boolean; why: string }[]> {
  const p = chain.then(() => sendNow(ev, title, body, deps ?? { fetch }, link, meta));
  chain = p.catch(() => undefined);
  return p;
}

async function sendNow(ev: NotifyEvent, title: string, body: string, deps: ChannelDeps, link: string | null, meta: NotifyMeta) {
  const s = getSettings().notify;
  const legacy = s.events[ev] && (!!s.discordWebhook || !!s.ntfyUrl);
  const extra = (s.channels ?? []).filter((c) => c.enabled && c.events[ev]);
  if (!legacy && !extra.length) return [];
  const now = Date.now();
  sentAt = sentAt.filter((t) => now - t < 60_000);
  if (sentAt.length >= 30 && (ev === "grabbed" || ev === "imported")) return [];
  sentAt.push(now);
  const head = `${ICON[ev]} ${TITLE[ev]}${title ? `: ${title}` : ""}`;
  const out: { channel: string; id?: string; ok: boolean; why: string }[] = [];
  const secrets = [s.discordWebhook, s.ntfyToken];
  if (legacy && s.discordWebhook) {
    try {
      const r = await safeFetch(
        s.discordWebhook,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: "AnimeArr",
            content: [...`**${head}**\n${body}`].slice(0, 1800).join("") + (link ? `\n${link}` : ""),
            allowed_mentions: { parse: [] },
          }),
          signal: AbortSignal.timeout(15_000),
        },
        { fetch: deps.fetch },
      ); // release names can't ping anyone
      out.push({ channel: "discord", ok: r.ok, why: r.ok ? "sent" : `HTTP ${r.status}` });
      if (r.status === 429) await new Promise((res) => setTimeout(res, 2000)); // back off a little
    } catch (e) {
      out.push({ channel: "discord", ok: false, why: redactText((e as Error).message, secrets) });
    }
    note("discord", out.at(-1)!.ok, out.at(-1)!.why);
  }
  if (legacy && s.ntfyUrl) {
    try {
      const headers: Record<string, string> = {
        Title: head.replace(/[^\x20-\x7e]/g, "").trim() || TITLE[ev],
        Tags: ev === "failed" ? "warning" : ev === "paused" ? "pause_button" : ev === "imported" ? "white_check_mark" : "arrow_down",
      };
      if (s.ntfyToken) headers.Authorization = `Bearer ${s.ntfyToken}`;
      // Tapping the notification opens the item in AnimeArr (URL-encoded: headers must be plain ASCII).
      if (link)
        try {
          headers.Click = new URL(link).href;
        } catch {
          /* not a valid URL: no click target */
        }
      const r = await safeFetch(
        s.ntfyUrl,
        { method: "POST", headers, body: body.slice(0, 3000), signal: AbortSignal.timeout(15_000) },
        { fetch: deps.fetch },
      );
      out.push({ channel: "ntfy", ok: r.ok, why: r.ok ? "sent" : `HTTP ${r.status}` });
    } catch (e) {
      out.push({ channel: "ntfy", ok: false, why: redactText((e as Error).message, secrets) });
    }
    note("ntfy", out.at(-1)!.ok, out.at(-1)!.why);
  }
  const n: Note = { event: ev, head, title, body, link, meta, at: now };
  for (const c of extra) {
    const r = await deliver(c, n, deps);
    out.push({ channel: c.name, id: c.id, ...r });
    note(c.id, r.ok, r.why);
  }
  return out;
}

/** The Test button on one extra channel: sends regardless of its switches, returns the outcome. */
export async function testChannel(c: NotifyChannel, deps: ChannelDeps = { fetch }) {
  const problem = channelProblem(c);
  if (problem) return { channel: c.name, id: c.id, ok: false, why: problem };
  const r = await deliver(
    c,
    { event: "test", head: "AnimeArr test", title: "Test", body: "AnimeArr can reach this channel.", link: null, meta: {}, at: Date.now() },
    deps,
  );
  note(c.id, r.ok, r.why);
  return { channel: c.name, id: c.id, ...r };
}

/**
 * Quiet: the decision is about a show in the library of which nothing (or none of its episodes) is wanted. Grabs-paused
 * and indexer notices carry no show, so they are never quiet. If the check itself fails, the notice goes out (loud):
 * a missed real problem costs more than one extra message.
 */
function isQuiet(tvdbId: number | null | undefined, episodeIds: number[] | undefined) {
  if (!tvdbId) return false;
  try {
    return quietRule(tvdbId, episodeIds ?? []);
  } catch (e) {
    console.warn(`notification quiet check failed (sending it anyway): ${(e as Error).message}`);
    return false;
  }
}

/** Called for every activity entry: the bell always records it; Discord/ntfy and the extra channels when switched on. */
export function onDecision(
  kind: string,
  d: { title?: string; why: string; detail?: unknown; tvdbId?: number | null; episodeIds?: number[]; release?: string | null },
) {
  if (dbState.corrupt) return;
  const ev = eventOf(kind, d.why, d.detail);
  if (!ev) return;
  // A show you don't monitor (nothing of it wanted, or none of these episodes) stays quiet, like Sonarr: the bell keeps
  // the entry already read and out of "Needs action", and nothing is pushed. Activity still has the full record.
  const quiet = isQuiet(d.tvdbId, d.episodeIds);
  try {
    const det = (d.detail ?? {}) as { grabId?: number; movieId?: number };
    const ctx = {
      kind,
      grabId: det.grabId ?? null,
      tvdbId: d.tvdbId ?? null,
      movieId: det.movieId ?? null,
      episodeIds: d.episodeIds ?? [],
      ...(quiet ? { quiet: true } : {}),
    };
    db.prepare("INSERT INTO notifications (at, event, title, body, read, ctx) VALUES (?, ?, ?, ?, ?, ?)").run(
      Date.now(),
      ev,
      d.title ?? "",
      d.why,
      quiet ? 1 : 0,
      JSON.stringify(ctx),
    );
    db.prepare("DELETE FROM notifications WHERE id <= (SELECT MAX(id) - 500 FROM notifications)").run();
  } catch {
    /* the bell is best effort */
  }
  if (quiet) return;
  // After the caller's work (and any transaction) is done.
  const det2 = (d.detail ?? {}) as { grabId?: number; movieId?: number };
  const link = linkFor(
    { grabId: det2.grabId ?? null, tvdbId: d.tvdbId ?? null, movieId: det2.movieId ?? null },
    getSettings().externalUrl ?? "",
  );
  const meta: NotifyMeta = {
    tvdbId: d.tvdbId ?? null,
    movieId: det2.movieId ?? null,
    episodeIds: d.episodeIds ?? [],
    grabId: det2.grabId ?? null,
    release: d.release ?? null,
  };
  setImmediate(
    () =>
      void send(ev, d.title ?? "", d.why, undefined, link, meta).then(
        (r) => r.filter((x) => !x.ok).forEach((x) => console.warn(`notification to ${x.channel} failed: ${redactText(x.why)}`)),
        () => undefined,
      ),
  );
}

/**
 * A problem is settled when what it was about got sorted: its grab finished or was replaced by a newer one, its
 * episodes have files now, its movie has its file, or a later pause notice superseded it.
 */
function settled(ctx: FixContext, event: NotifyEvent, at: number, title: string, body: string) {
  if (event === "paused") {
    // An importer review pause is settled once imports run again; a download-rule pause once grabs aren't paused.
    if (/importer/i.test(body)) {
      const imp = getSettings().importer;
      return imp.allowReal && (imp.realBudget < 0 || imp.realBudget > 0);
    }
    return (
      !!db.prepare("SELECT 1 FROM notifications WHERE event = 'paused' AND at > ? LIMIT 1").get(at) ||
      !getSettings().downloads.rules.some((r) => (r as { paused?: boolean }).paused)
    );
  }
  // "X is off" is settled by a later notice about the same indexer ("working again", or turned back on).
  if (event === "indexer")
    return !!db.prepare("SELECT 1 FROM notifications WHERE event = 'indexer' AND title = ? AND at > ? LIMIT 1").get(title, at);
  if (ctx.grabId) {
    const g = db.prepare("SELECT state FROM grabs WHERE id = ?").get(ctx.grabId) as { state: string } | undefined;
    if (g && ["done", "downloading", "importing", "sending"].includes(g.state)) return true;
    if (
      db
        .prepare(
          "SELECT 1 FROM grabs WHERE id > ? AND state = 'done' AND ((movie_id IS NOT NULL AND movie_id = (SELECT movie_id FROM grabs WHERE id = ?)) OR (tvdb_id IS NOT NULL AND tvdb_id = (SELECT tvdb_id FROM grabs WHERE id = ?) AND episode_ids = (SELECT episode_ids FROM grabs WHERE id = ?))) LIMIT 1",
        )
        .get(ctx.grabId, ctx.grabId, ctx.grabId, ctx.grabId)
    )
      return true;
  }
  if (
    ctx.movieId &&
    (cache.prepare("SELECT has_file FROM movies WHERE id = ?").get(ctx.movieId) as { has_file: number } | undefined)?.has_file
  )
    return true;
  if (ctx.episodeIds?.length) {
    const left = cache
      .prepare(`SELECT COUNT(*) AS n FROM episodes WHERE has_file = 0 AND id IN (${ctx.episodeIds.map(() => "?").join(",")})`)
      .get(...ctx.episodeIds) as { n: number };
    if (!left.n) return true;
  }
  return false;
}

/**
 * The bell: "Needs action" (problems that still have a fix and aren't settled; they alone count on the badge) and
 * "Recent" (everything). Settled problems drop out of "Needs action" on their own.
 */
export function bell(limit = 40) {
  type Row = { id: number; at: number; event: NotifyEvent; title: string; body: string; read: number; ctx: string | null };
  const recent = db.prepare("SELECT id, at, event, title, body, read, ctx FROM notifications ORDER BY id DESC LIMIT ?").all(limit) as Row[];
  // Problems are looked at over two weeks, not just the latest few (a busy day of imports would push them out).
  const problems = db
    .prepare(
      "SELECT id, at, event, title, body, read, ctx FROM notifications WHERE event IN ('failed', 'paused', 'indexer') AND at > ? ORDER BY id DESC LIMIT 500",
    )
    .all(Date.now() - 14 * 86_400_000) as Row[];
  const seenIds = new Set(recent.map((r) => r.id));
  const rows = [...recent, ...problems.filter((p) => !seenIds.has(p.id))];
  const unread = (db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE read = 0").get() as { n: number }).n;
  const all = rows.map((r) => {
    const ctx = r.ctx ? (JSON.parse(r.ctx) as FixContext) : {};
    const problem = r.event === "failed" || r.event === "paused" || (r.event === "indexer" && /is off/.test(r.body));
    const fixes = problem ? liveFixesFor(r.body, ctx) : [];
    const action =
      problem &&
      !(ctx as { quiet?: boolean }).quiet &&
      Date.now() - r.at < 14 * 86_400_000 &&
      !settled(ctx, r.event, r.at, r.title, r.body) &&
      (fixes.length > 0 || r.event !== "failed");
    // A settled problem counts as read (nothing left to look at); the plain summary leads, the raw body is the detail.
    const isSettled = problem && !action && r.event !== "indexer" ? settled(ctx, r.event, r.at, r.title, r.body) : false;
    const summary = summarize({
      kind: ctx.kind ?? (r.event === "grabbed" ? "grab" : r.event === "imported" ? "import" : r.event === "failed" ? "fail" : null),
      why: r.body,
      title: r.title,
    });
    return {
      id: r.id,
      at: r.at,
      event: r.event,
      title: r.title,
      body: r.body,
      summary,
      read: !!r.read || isSettled,
      resolved: isSettled,
      fixes,
      action,
      tvdbId: ctx.tvdbId ?? null,
      movieId: ctx.movieId ?? null,
    };
  });
  const items = all;
  // One entry per thing to do (the same show/movie problem repeated counts once).
  const seen = new Set<string>();
  const needs = items.filter((i) => {
    if (!i.action) return false;
    const key = `${i.event}:${i.tvdbId ?? ""}:${i.movieId ?? ""}:${i.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // "Recent" is the latest few; "Needs action" also brings older open problems.
  const shown = items.filter((i) => seenIds.has(i.id) || needs.includes(i)).sort((a, b) => b.id - a.id);
  return { unread, needs: needs.length, items: shown.map((i) => ({ ...i, action: needs.includes(i) })) };
}

/** Marks notifications read: everything up to an id ("Mark all read"), or just the ones given (dismissed one by one). */
export function markRead(upToId: number, ids: number[] = []) {
  if (upToId) db.prepare("UPDATE notifications SET read = 1 WHERE read = 0 AND id <= ?").run(upToId);
  for (const id of ids) db.prepare("UPDATE notifications SET read = 1 WHERE id = ?").run(id);
}
