/**
 * Connection and validation errors in plain words. "SABnzbd unreachable (fetch failed)" or "getaddrinfo ENOTFOUND x"
 * tell a new user nothing: this names the service and the address and says what to check; the raw text is kept as
 * `detail` (shown behind "Details"). Generic on purpose: any route's error goes through it (index.ts error handler),
 * and so do the connection cards' status lines.
 */

export interface HumanError { message: string; detail: string | null }

/** "http://user:pw@192.168.1.10:8080/sab" → "192.168.1.10:8080". */
export function addressOf(url: string | null | undefined) {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}


/**
 * Plain words for an error message. `ctx` names the service/address when the message doesn't (test buttons pass the
 * address being tested). Messages that are already plain come back unchanged with no detail.
 */
export function humanizeError(raw: string, ctx: { service?: string; url?: string } = {}): HumanError {
  const msg = String(raw ?? "").trim();
  const keep = (message: string): HumanError => ({ message, detail: message === msg ? null : msg });
  // Known messages first.
  const nc = /^(.+?) is not configured$/i.exec(msg);
  if (nc) return keep(`${nc[1]} isn't set up yet.`);
  if (/^AniDB titles download failed \(HTTP (403|429|503)\)/i.test(msg)) return keep("AniDB refused the title download for now (it limits how often). AnimeArr tries again later; nothing to do.");
  if (/TMDB API key \(32 hex characters\)/i.test(msg)) return keep("That doesn't look like a TMDB key. Paste the API key (32 letters and digits) or the Read Access Token (starts with eyJ) from TMDB's API settings page.");
  if (/^Something went wrong: /i.test(msg)) return keep(msg.replace(/^Something went wrong: /i, ""));
  // "Sonarr unreachable (…)", "SABnzbd GET /api failed (HTTP 401) (wrong API key?)", "unreachable (…)" (indexers)
  const un = /^(?:(.+?) )?unreachable \((.*)\)$/is.exec(msg);
  const http = /^(.+?) (?:GET|POST|PUT|DELETE|PATCH)? ?\S* ?failed \(HTTP (\d{3})\)/i.exec(msg) ?? /^(.+?):? HTTP (\d{3})\b/i.exec(msg);
  const svc = ctx.service || (un?.[1] ?? http?.[1] ?? "").trim() || "";
  const name = svc || "the service";
  const cause = un ? un[2] : msg;
  const hostIn = /(?:ENOTFOUND|EAI_AGAIN|host) ([\w.-]+)/i.exec(cause)?.[1] ?? "";
  const refusedAt = /ECONNREFUSED ([\w.:[\]-]+)/i.exec(cause)?.[1] ?? "";
  const addr = addressOf(ctx.url) || refusedAt || hostIn;
  const at = addr ? ` at ${addr}` : "";

  if (/^(?:that address isn't a valid URL|address must start)/i.test(msg) && ctx.url === "") return keep("Enter the address first, e.g. http://192.168.1.10:8080");
  // Network causes only for network errors ("Search timed out" from elsewhere stays as it is).
  const net = !!un || /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_\w+)\b|^fetch failed$|not found \(DNS\)|refused the connection|dropped the connection/i.test(msg);
  if (net) {
    if (/\b(ENOTFOUND|EAI_AGAIN)\b|not found \(DNS\)/i.test(cause))
      return keep(`No computer called ${hostIn || addr || "that"} was found on your network. Check ${svc ? `${svc}'s` : "the"} address (a typo, or use its IP address, e.g. http://192.168.1.10:8080).`);
    if (/ECONNREFUSED|refused the connection/i.test(cause)) return keep(`${cap(name)}${at} refused the connection. Is it running, and is the port right?`);
    if (/ECONNRESET|dropped the connection|socket hang up|other side closed/i.test(cause)) return keep(`${cap(name)}${at} hung up on AnimeArr. Is the address right (http or https, the port)?`);
    if (/timed? ?out|TimeoutError|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|aborted/i.test(cause)) return keep(`${cap(name)}${at} didn't answer in time. Is it running, and is the address right?`);
    if (/EHOSTUNREACH|ENETUNREACH/i.test(cause)) return keep(`AnimeArr can't get to ${addr || "that address"} from where it runs. Is the address right, and is that computer on?`);
    if (/CERT|TLS|SSL|self[- ]signed/i.test(cause)) return keep(`${cap(name)}${at} has a certificate problem. Try http:// instead of https://, or fix its certificate.`);
    return keep(`AnimeArr couldn't reach ${name}${at}. Is it running, and is the address right?`);
  }
  if (http) {
    const code = Number(http[2]);
    if (code === 401) return keep(`${cap(name)} said the API key or password is wrong. Copy it again from ${svc ? `${svc}'s` : "its"} settings.`);
    if (code === 403) return keep(`${cap(name)} refused access (it answered "forbidden"). Check the API key or password, and that it allows AnimeArr's address.`);
    if (code === 404) return keep(`${cap(name)} answered, but nothing is at that address. Check the address, including any extra path (e.g. /sonarr).`);
    if (code >= 500) return keep(`${cap(name)} had a problem of its own (error ${code}). Try again in a minute, or look at its logs.`);
  }
  return { message: msg, detail: null };
}

/** Sentence start: "the service" → "The service"; product names keep their spelling (qBittorrent). */
const cap = (s: string) => (s.startsWith("the ") ? `T${s.slice(1)}` : s);
