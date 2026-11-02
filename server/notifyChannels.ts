/**
 * The extra notification channels (Sonarr "Connect" parity): generic webhook, Telegram, Pushover and email (SMTP).
 * Each is a list entry in settings (notify.channels) with its own switch and per-event toggles. Secrets live in the
 * encrypted settings row, are masked on their way to the browser, and are scrubbed from every error text.
 * Discord and ntfy stay as the two original fields in notify.ts; this file only builds and sends the new ones.
 */
import { MASK, isMasked } from "./system/settings.js";
import { VERSION } from "./system/version.js";
import { redactText } from "./system/redact.js";

export type ChannelType = "webhook" | "telegram" | "pushover" | "email";
export const CHANNEL_TYPES: ChannelType[] = ["webhook", "telegram", "pushover", "email"];
export type ChannelEvents = { grabbed: boolean; imported: boolean; failed: boolean; paused: boolean; indexer: boolean };

export interface NotifyChannel {
  id: string;
  type: ChannelType;
  name: string;
  enabled: boolean;
  events: ChannelEvents;
  // webhook
  url: string;
  method: "POST" | "PUT";
  headers: { name: string; value: string }[];
  // telegram
  botToken: string;
  chatId: string;
  threadId: string;
  silent: boolean;
  // pushover
  userKey: string;
  appToken: string;
  priority: number;
  device: string;
  sound: string;
  // email
  host: string;
  port: number;
  secure: "none" | "starttls" | "tls";
  username: string;
  password: string;
  from: string;
  to: string;
}

/** What a notification carries beyond its text (webhook payloads and links). */
export interface NotifyMeta {
  tvdbId?: number | null;
  movieId?: number | null;
  episodeIds?: number[];
  grabId?: number | null;
  release?: string | null;
}
export interface MailMessage {
  from: string;
  to: string[];
  subject: string;
  text: string;
}
export interface ChannelDeps {
  fetch: typeof fetch;
  sendMail?: (c: NotifyChannel, m: MailMessage) => Promise<void>;
}
export interface Note {
  event: string;
  head: string;
  title: string;
  body: string;
  link: string | null;
  meta: NotifyMeta;
  at: number;
}

export const newChannel = (type: ChannelType, id: string): NotifyChannel => ({
  id,
  type,
  name: "",
  enabled: true,
  events: { grabbed: true, imported: true, failed: true, paused: true, indexer: true },
  url: "",
  method: "POST",
  headers: [],
  botToken: "",
  chatId: "",
  threadId: "",
  silent: false,
  userKey: "",
  appToken: "",
  priority: 0,
  device: "",
  sound: "",
  host: "",
  port: 587,
  secure: "starttls",
  username: "",
  password: "",
  from: "",
  to: "",
});

/** Every secret value on a channel (for scrubbing error text). */
export function channelSecrets(c: NotifyChannel): string[] {
  return [c.url, c.botToken, c.userKey, c.appToken, c.password, ...c.headers.map((h) => h.value)].filter((x) => x && x !== MASK);
}

/** The channel as the browser sees it: every secret masked. */
export function maskChannel(c: NotifyChannel): NotifyChannel {
  return {
    ...c,
    url: c.url ? MASK : "",
    botToken: c.botToken ? MASK : "",
    userKey: c.userKey ? MASK : "",
    appToken: c.appToken ? MASK : "",
    password: c.password ? MASK : "",
    headers: c.headers.map((h) => ({ name: h.name, value: h.value ? MASK : "" })),
  };
}

const str = (v: unknown, max = 300) =>
  String(v ?? "")
    .trim()
    .slice(0, max);
const pick = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
const splitList = (s: string) =>
  s
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const refuse = (msg: string) => Object.assign(new Error(msg), { statusCode: 400 });

function badUrl(v: string): string | null {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return "that isn't a web address (https://…)";
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return "the address must be http(s) without a user name or password in it";
  if (/^(169\.254\.|0\.|\[?fe80:|\[::ffff:169\.254)/i.test(u.hostname)) return "that address isn't allowed";
  return null;
}

/**
 * Cleans the list the browser sends. A masked secret means "unchanged" and is taken from the saved channel with the
 * same id.
 */
export function cleanChannels(input: unknown, saved: NotifyChannel[]): NotifyChannel[] {
  if (!Array.isArray(input)) throw refuse("Expected a list of channels");
  const out: NotifyChannel[] = [];
  for (const raw of input.slice(0, 20)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const type = pick(r.type, CHANNEL_TYPES, "webhook");
    const id = /^[\w-]{1,40}$/.test(str(r.id)) ? str(r.id) : `ch-${Date.now().toString(36)}-${out.length}`;
    const old = saved.find((x) => x.id === id && x.type === type);
    const keep = (v: unknown, o: string) => (isMasked(v) ? o : str(v, 500));
    const ev = (r.events ?? {}) as Record<string, unknown>;
    const c: NotifyChannel = {
      ...newChannel(type, id),
      name: str(r.name, 60) || ({ webhook: "Webhook", telegram: "Telegram", pushover: "Pushover", email: "Email" } as const)[type],
      enabled: r.enabled !== false,
      events: {
        grabbed: ev.grabbed !== false,
        imported: ev.imported !== false,
        failed: ev.failed !== false,
        paused: ev.paused !== false,
        indexer: ev.indexer !== false,
      },
    };
    if (type === "webhook") {
      c.url = keep(r.url, old?.url ?? "");
      const why = c.url ? badUrl(c.url) : null;
      if (why) throw refuse(`${c.name}: ${why}`);
      c.method = pick(r.method, ["POST", "PUT"] as const, "POST");
      c.headers = (Array.isArray(r.headers) ? r.headers : [])
        .slice(0, 10)
        .map((h) => {
          const x = (h ?? {}) as Record<string, unknown>;
          const name = str(x.name, 80);
          return {
            name,
            value: isMasked(x.value)
              ? (old?.headers.find((o) => o.name.toLowerCase() === name.toLowerCase())?.value ?? "")
              : str(x.value, 1000),
          };
        })
        .filter((h) => /^[\w-]+$/.test(h.name) && h.value !== "" && !/^(host|content-length|transfer-encoding|connection)$/i.test(h.name));
    } else if (type === "telegram") {
      c.botToken = keep(r.botToken, old?.botToken ?? "");
      c.chatId = str(r.chatId, 80);
      c.threadId = str(r.threadId, 20).replace(/\D/g, "");
      c.silent = r.silent === true;
      if (c.botToken && !/^\d{5,}:[\w-]{20,}$/.test(c.botToken))
        throw refuse(`${c.name}: that isn't a Telegram bot token (like 123456:ABC…, from @BotFather)`);
    } else if (type === "pushover") {
      c.userKey = keep(r.userKey, old?.userKey ?? "");
      c.appToken = keep(r.appToken, old?.appToken ?? "");
      c.priority = Math.min(2, Math.max(-2, Math.round(Number(r.priority) || 0)));
      c.device = str(r.device, 100);
      c.sound = str(r.sound, 40);
    } else {
      c.host = str(r.host, 200);
      c.port = Math.min(65535, Math.max(1, Math.round(Number(r.port) || 587)));
      c.secure = pick(r.secure, ["none", "starttls", "tls"] as const, "starttls");
      c.username = str(r.username, 200);
      c.password = keep(r.password, old?.password ?? "");
      c.from = str(r.from, 200);
      c.to = str(r.to, 1000);
      if ([c.from, c.host, c.to].some((x) => /[\r\n]/.test(x))) throw refuse(`${c.name}: bad address`);
    }
    out.push(c);
  }
  return out;
}

/** Why a channel can't send yet (a plain phrase), or null when it is set up. */
export function channelProblem(c: NotifyChannel): string | null {
  if (c.type === "webhook") return c.url ? null : "no webhook address yet";
  if (c.type === "telegram") return c.botToken && c.chatId ? null : "needs a bot token and a chat id";
  if (c.type === "pushover") return c.userKey && c.appToken ? null : "needs a user key and an app token";
  return c.host && c.from && splitList(c.to).length ? null : "needs a server, a from address and at least one to address";
}

/** The webhook's JSON body (documented in the README). */
export function webhookPayload(n: Note) {
  return {
    eventType: n.event,
    title: n.title,
    message: n.body,
    show: n.meta.tvdbId ? { tvdbId: n.meta.tvdbId, title: n.title } : undefined,
    movie: n.meta.movieId ? { id: n.meta.movieId, title: n.title } : undefined,
    episodeIds: n.meta.episodeIds?.length ? n.meta.episodeIds : undefined,
    release: n.meta.release ?? undefined,
    reason: n.body,
    link: n.link ?? undefined,
    timestamp: new Date(n.at).toISOString(),
    applicationVersion: VERSION,
  };
}

/** The request for the HTTP channels (what gets sent is testable without sending). */
export function buildRequest(c: NotifyChannel, n: Note): { url: string; init: RequestInit } | null {
  if (c.type === "webhook") {
    const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": `AnimeArr/${VERSION}` };
    for (const h of c.headers) headers[h.name] = h.value;
    return { url: c.url, init: { method: c.method, headers, body: JSON.stringify(webhookPayload(n)) } };
  }
  if (c.type === "telegram") {
    const link = n.link ? `\n<a href="${escapeHtml(n.link).replace(/"/g, "&quot;")}">Open in AnimeArr</a>` : "";
    const body: Record<string, unknown> = {
      chat_id: c.chatId,
      text: `<b>${escapeHtml(n.head)}</b>\n${escapeHtml(n.body.slice(0, 3500))}${link}`,
      parse_mode: "HTML",
      disable_notification: c.silent,
      link_preview_options: { is_disabled: true },
    };
    if (c.threadId) body.message_thread_id = Number(c.threadId);
    return {
      url: `https://api.telegram.org/bot${c.botToken}/sendMessage`,
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    };
  }
  if (c.type === "pushover") {
    const body: Record<string, unknown> = {
      token: c.appToken,
      user: c.userKey,
      title: n.head.slice(0, 250),
      message: (n.body || n.head).slice(0, 1000),
      priority: c.priority,
    };
    if (c.device) body.device = c.device;
    if (c.sound) body.sound = c.sound;
    if (n.link) body.url = n.link;
    if (c.priority === 2) Object.assign(body, { retry: 60, expire: 3600 }); // emergency priority needs these
    return {
      url: "https://api.pushover.net/1/messages.json",
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    };
  }
  return null;
}

/** The email for a notification. */
export function buildMail(c: NotifyChannel, n: Note): MailMessage {
  return {
    from: c.from,
    to: splitList(c.to),
    subject: n.head.replace(/[\r\n]+/g, " ").slice(0, 200),
    text: `${n.body}${n.link ? `\n\n${n.link}` : ""}\n\n-- AnimeArr ${VERSION}`,
  };
}

/** Real SMTP delivery through nodemailer (loaded only when an email channel actually sends). */
async function smtp(c: NotifyChannel, m: MailMessage) {
  const nodemailer = (await import("nodemailer")).default;
  const tx = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure === "tls",
    requireTLS: c.secure === "starttls",
    ignoreTLS: c.secure === "none",
    auth: c.username ? { user: c.username, pass: c.password } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
  try {
    await tx.sendMail({ from: m.from, to: m.to, subject: m.subject, text: m.text });
  } finally {
    tx.close();
  }
}

/** Sends one note to one channel. Never throws: the outcome says what happened, with every secret scrubbed. */
export async function deliver(c: NotifyChannel, n: Note, deps: ChannelDeps): Promise<{ ok: boolean; why: string }> {
  try {
    const problem = channelProblem(c);
    if (problem) return { ok: false, why: problem };
    if (c.type === "email") {
      await (deps.sendMail ?? smtp)(c, buildMail(c, n));
      return { ok: true, why: "sent" };
    }
    const req = buildRequest(c, n)!;
    const r = await deps.fetch(req.url, { ...req.init, signal: AbortSignal.timeout(15_000) });
    if (r.status === 429) await new Promise((res) => setTimeout(res, 2000)); // back off a little
    return r.ok ? { ok: true, why: "sent" } : { ok: false, why: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, why: redactText((e as Error).message, channelSecrets(c)).slice(0, 300) };
  }
}
