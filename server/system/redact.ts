import { redactUrl } from "../arr/http.js";

/**
 * Scrubs secrets from text that is logged or shown: everything redactUrl catches (apikey= parameters, user:pass@host,
 * Bearer tokens, JWTs) plus passwords/tokens in JSON or key=value text, Telegram bot tokens in API paths, Discord
 * webhook paths, and any exact secret values the caller knows about.
 */
export function redactText(s: string, known: readonly string[] = []): string {
  let out = redactUrl(String(s))
    .replace(
      /(["']?(?:api[-_]?key|apikey|secret|token|password|passwd|pass|authorization|passkey|rsskey|webhook)["']?\s*[:=]\s*["']?)(?!\*\*\*)[^"'\s,&}]+/gi,
      "$1***",
    )
    .replace(/\/bot\d{5,}:[\w-]{20,}/g, "/bot***") // Telegram Bot API path
    .replace(/(\/webhooks\/\d+\/)[\w-]+/g, "$1***") // Discord webhook
    .replace(/(X-Api-Key:\s*)\S+/gi, "$1***");
  for (const k of known) if (k && k.length >= 4) out = out.split(k).join("***");
  return out;
}
