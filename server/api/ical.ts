/**
 * The calendar as an iCalendar (RFC 5545) feed, the way Sonarr offers one: episodes at their air time, anime movies on
 * their release dates. Calendar apps can't log in, so the route (registerIcal) takes its own read-only ?token=.
 */
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getSettings, safeEqual } from "../system/settings.js";
import { cache, db } from "../system/db.js";
import { calendar } from "../library/episodes.js";
import { movieCalendar } from "../library/movies.js";
import { tagRows } from "../library/tags.js";

const DAY = 86_400_000;

export interface IcalOptions {
  /** Days back and ahead of now (Sonarr's pastDays 7 / futureDays 28). */
  pastDays: number;
  futureDays: number;
  /** Include shows and movies that aren't monitored. */
  unmonitored: boolean;
  /** Only shows and movies with one of these tags (empty = all). */
  tags: number[];
}

/** Query parameters → options, clamped (a bad value falls back to the default, like Sonarr). */
export function icalOptions(q: Record<string, unknown>): IcalOptions {
  const days = (v: unknown, d: number) => {
    const n = Number(v);
    return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? Math.min(365, Math.floor(n)) : d;
  };
  const known = new Set(tagRows().map((x) => x.id));
  const tags = String(q.tags ?? "")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isInteger(x) && x > 0 && known.has(x));
  return {
    pastDays: days(q.pastDays, 7),
    futureDays: days(q.futureDays, 28),
    unmonitored: /^(true|1)$/i.test(String(q.unmonitored ?? "")),
    tags: [...new Set(tags)],
  };
}

/** Text values: backslash, semicolon, comma and newlines are escaped (RFC 5545 §3.3.11). */
export const icalEscape = (s: string) =>
  s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");

/** Folds a content line at 75 octets with CRLF + space, never inside a multi-byte character. */
export function icalFold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, "utf8");
    const limit = out.length === 0 ? 75 : 74; // continuation lines start with a space
    if (bytes + n > limit) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const pad = (n: number) => String(n).padStart(2, "0");
const utc = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
};
const dateOnly = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
};

const hasTag = (kind: "series" | "movie", ref: number, tags: number[]) =>
  !tags.length ||
  !!db
    .prepare(`SELECT 1 FROM tag_links WHERE kind = ? AND ref = ? AND tag_id IN (${tags.map(() => "?").join(",")})`)
    .get(kind, ref, ...tags);

const KIND_LABEL = { cinema: "In cinemas", digital: "Digital release", physical: "Physical release" } as const;

/** The whole feed as text (CRLF line ends). `now` is the DTSTAMP and the window's centre. */
export function buildIcal(opts: IcalOptions, now = Date.now()): string {
  const from = now - opts.pastDays * DAY;
  const to = now + opts.futureDays * DAY;
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//AnimeArr//Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:AnimeArr",
    "X-WR-CALDESC:Anime episodes and movie releases from AnimeArr",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  const stamp = utc(now);

  const eps = calendar(from, to, !opts.unmonitored).filter((e) => hasTag("series", e.tvdbId, opts.tags));
  const extra = new Map<number, { absolute: number | null; runtime: number | null }>();
  if (eps.length) {
    const rows = cache
      .prepare(
        `SELECT e.id, e.absolute, COALESCE(e.runtime, s.runtime) AS runtime FROM episodes e JOIN series s ON s.id = e.series_id WHERE e.id IN (${eps.map(() => "?").join(",")})`,
      )
      .all(...eps.map((e) => e.episodeId)) as { id: number; absolute: number | null; runtime: number | null }[];
    for (const r of rows) extra.set(r.id, r);
  }
  for (const e of eps) {
    const x = extra.get(e.episodeId);
    const num = `S${pad(e.season)}E${pad(e.episode)}`;
    const abs = x?.absolute && x.absolute !== e.episode ? ` (#${x.absolute})` : "";
    const minutes = x?.runtime && x.runtime > 0 ? x.runtime : 24;
    lines.push(
      "BEGIN:VEVENT",
      `UID:animearr-episode-${e.episodeId}@animearr`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${utc(e.airUtc)}`,
      `DTEND:${utc(e.airUtc + minutes * 60_000)}`,
      `SUMMARY:${icalEscape(`${e.series} – ${num}${abs}${e.title ? ` – ${e.title}` : ""}`)}`,
      `DESCRIPTION:${icalEscape(`${e.series} ${num}${abs}${e.title ? `\n${e.title}` : ""}`)}`,
      `CATEGORIES:Episode`,
      "END:VEVENT",
    );
  }

  const movies = movieCalendar(from, to, !opts.unmonitored).filter(
    (m) => hasTag("movie", m.movieId, opts.tags) && m.at >= from - (from % DAY) && m.at <= to,
  ); // (a date-only event counts from the start of its UTC day)
  for (const m of movies) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:animearr-movie-${m.movieId}-${m.kind}@animearr`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${dateOnly(m.at)}`,
      `DTEND;VALUE=DATE:${dateOnly(m.at + DAY)}`,
      `SUMMARY:${icalEscape(`${m.title}${m.year ? ` (${m.year})` : ""} – ${KIND_LABEL[m.kind]}`)}`,
      `CATEGORIES:Movie`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(icalFold).join("\r\n") + "\r\n";
}

/**
 * The feed's own read-only token (?token=). Calendar apps store the link, so it must not carry the API key, and the
 * token opens nothing but this feed. It is derived from the API key (one-way), so making a new API key in Settings →
 * Security also replaces it: that is how a shared calendar link is revoked.
 */
export function icalToken() {
  return crypto.createHmac("sha256", getSettings().apiKey).update("animearr-ical-feed").digest("base64url").slice(0, 32);
}

/** The feed route. It sits outside /api (so the login guard doesn't see it) and checks the calendar token itself. */
export function registerIcal(app: FastifyInstance) {
  // For the calendar dialog: any logged-in caller may read the token (it can do less than they can).
  app.get("/api/calendar/ical-token", async () => ({ token: icalToken() }));
  app.get<{ Querystring: Record<string, string> }>("/feed/calendar/animearr.ics", async (req, reply) => {
    const token = req.query.token;
    if (typeof token !== "string" || !safeEqual(token, icalToken()))
      return reply
        .code(401)
        .type("text/plain; charset=utf-8")
        .send("This calendar link is missing its token or is out of date: copy a new one from Calendar → iCal link in AnimeArr.");
    return reply
      .header("Cache-Control", "no-store")
      .header("Content-Disposition", 'inline; filename="animearr.ics"')
      .type("text/calendar; charset=utf-8")
      .send(buildIcal(icalOptions(req.query)));
  });
}
