/** Small fetch wrapper for the *arr and download-client APIs. Error messages never include keys or query strings. */

export interface Conn {
  url: string;
  apiKey: string;
}

export class HttpError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function jsonCall<T>(app: string, conn: Conn, apiBase: string, method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
  if (!conn.url || !conn.apiKey) throw new Error(`${app} is not configured`);
  if (!/^https?:\/\//i.test(conn.url)) throw new Error(`${app} URL must start with http:// or https://`);
  let res: Response;
  try {
    res = await fetch(`${conn.url}${apiBase}${path}`, {
      method,
      headers: { "X-Api-Key": conn.apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = e as Error;
    throw new Error(`${app} unreachable (${err.name === "TimeoutError" ? "timed out" : (err.cause as Error | undefined)?.message ?? err.message})`);
  }
  if (!res.ok) {
    const hint = res.status === 401 ? " (wrong API key?)" : "";
    throw new HttpError(`${app} ${method} ${path.split("?")[0]} failed (HTTP ${res.status})${hint}`, res.status);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Replaces any apikey=... in a string (URLs from Prowlarr carry keys). */
export const redactUrl = (s: string) =>
  s
    .replace(/([?&](?:apikey|api_key|key|token|passkey)=)[^&\s]+/gi, "$1***")
    .replace(/(Bearer\s+)[\w.-]+/gi, "$1***") // Authorization headers
    .replace(/\beyJ[\w-]{10,}\.[\w-]+\.[\w-]+/g, "***"); // a bare JWT (TMDB Read Access Token)
