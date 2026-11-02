/**
 * The log viewer's source: everything the server logs (Fastify/pino lines and console output) goes through here into a
 * ring buffer (last 2000 lines, for Settings → System → Logs) and a size-capped file in the config folder
 * (logs/animearr.log, rotated to animearr.log.1 at 5 MB), so the lines survive a restart. Every line is scrubbed of
 * secrets (API keys, tokens, passwords, webhook paths) before it is kept, shown or downloaded.
 */
import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import { CONFIG_DIR } from "./db.js";
import { redactText } from "./redact.js";

export type LogLevel = "error" | "warn" | "info" | "debug";
export interface LogEntry {
  at: number;
  level: LogLevel;
  msg: string;
}
export const LOG_LEVELS: LogLevel[] = ["error", "warn", "info", "debug"];

const RING_SIZE = 2000;
const FILE_CAP = 5_000_000;
export const LOG_DIR = path.join(CONFIG_DIR, "logs");
export const LOG_FILE = path.join(LOG_DIR, "animearr.log");

let ring: LogEntry[] = [];
let pending = "";
let fileSize = 0;
let timer: NodeJS.Timeout | null = null;
let fileOk = true;

/** pino's numeric levels (and its trace) mapped to the four shown. */
export const levelOf = (n: number): LogLevel => (n >= 50 ? "error" : n >= 40 ? "warn" : n >= 30 ? "info" : "debug");

/** Keeps one line: scrubbed, bounded, in the ring and (soon) in the file. */
export function record(level: LogLevel, msg: string, at = Date.now()) {
  const e: LogEntry = { at, level, msg: redactText(msg).slice(0, 4000) };
  ring.push(e);
  if (ring.length > RING_SIZE) ring = ring.slice(-RING_SIZE);
  if (!fileOk) return;
  pending += `${JSON.stringify(e)}\n`;
  timer ??= setTimeout(flushLogs, 500).unref();
}

/** Writes what is waiting to the file (rotating it first when it is full). Never throws: logging must not break anything. */
export function flushLogs() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!pending) return;
  const out = pending;
  pending = "";
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (fileSize === 0) fileSize = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
    if (fileSize > FILE_CAP) {
      fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
      fileSize = 0;
    }
    fs.appendFileSync(LOG_FILE, out);
    fileSize += Buffer.byteLength(out);
  } catch {
    fileOk = false; // read-only config folder etc.: keep the ring only
  }
}

/** The newest `limit` lines at or above `level` (error < warn < info < debug), containing `q` (case-insensitive). Oldest first. */
export function getLogs(opts: { level?: string; q?: string; limit?: number } = {}) {
  const rank = LOG_LEVELS.indexOf(LOG_LEVELS.includes(opts.level as LogLevel) ? (opts.level as LogLevel) : "debug");
  const q = (opts.q ?? "").trim().toLowerCase();
  const limit = Math.min(RING_SIZE, Math.max(1, Math.round(opts.limit ?? 500)));
  const hits = ring.filter((e) => LOG_LEVELS.indexOf(e.level) <= rank && (!q || e.msg.toLowerCase().includes(q)));
  return { entries: hits.slice(-limit), total: ring.length, matched: hits.length };
}

export const formatLine = (e: LogEntry) =>
  `${new Date(e.at).toISOString()} ${e.level.toUpperCase().padEnd(5)} ${e.msg.replace(/\r?\n/g, "\n    ")}`;

function readFileEntries(file: string): LogEntry[] {
  try {
    const text = fs.readFileSync(file, "utf8");
    const out: LogEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const o = JSON.parse(line) as LogEntry;
        if (typeof o.at === "number" && typeof o.msg === "string" && LOG_LEVELS.includes(o.level))
          out.push({ at: o.at, level: o.level, msg: redactText(o.msg) });
      } catch {
        /* a half-written last line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Everything kept (the rotated file, the current one), as plain text for the Download button. */
export function logText(): string {
  flushLogs();
  const entries = [...readFileEntries(`${LOG_FILE}.1`), ...readFileEntries(LOG_FILE)];
  return `${(entries.length ? entries : ring).map(formatLine).join("\n")}\n`;
}

/** A pino line (JSON) as one entry; null for lines that aren't worth keeping. */
const quiet = new Set<string>();
export function fromPino(line: string): { level: LogLevel; msg: string; at: number } | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { level: "info", msg: line.trim(), at: Date.now() };
  }
  const req = o.req as { method?: string; url?: string } | undefined;
  const res = o.res as { statusCode?: number } | undefined;
  const reqId = String(o.reqId ?? "");
  // The viewer polling itself would drown everything else: its own requests are not kept.
  if (req?.url && /^\/api\/system\/logs/.test(req.url)) {
    quiet.add(reqId);
    if (quiet.size > 200) quiet.delete(quiet.values().next().value!);
    return null;
  }
  if (reqId && quiet.delete(reqId)) return null;
  let msg = String(o.msg ?? "");
  if (req) msg += ` ${req.method ?? ""} ${req.url ?? ""}`.trimEnd();
  if (res) msg += ` ${res.statusCode ?? ""}${typeof o.responseTime === "number" ? ` (${Math.round(o.responseTime)} ms)` : ""}`;
  const err = o.err as { message?: string; stack?: string } | undefined;
  if (err) msg += `: ${err.stack ?? err.message ?? ""}`;
  return { level: levelOf(Number(o.level) || 30), msg, at: Number(o.time) || Date.now() };
}

/** For Fastify's logger.stream: lines still reach stdout (as before) and are kept here. */
export const logStream = {
  write(chunk: string) {
    process.stdout.write(chunk);
    for (const line of String(chunk).split("\n")) {
      if (!line.trim()) continue;
      const e = fromPino(line);
      if (e) record(e.level, e.msg, e.at);
    }
  },
};

let installed = false;
/** Starts keeping console output too, and reloads the file's tail into the ring so a restart doesn't empty the viewer. */
export function installLogCapture() {
  if (installed) return;
  installed = true;
  ring = [...readFileEntries(`${LOG_FILE}.1`), ...readFileEntries(LOG_FILE)].slice(-RING_SIZE);
  for (const [name, level] of [
    ["log", "info"],
    ["info", "info"],
    ["warn", "warn"],
    ["error", "error"],
    ["debug", "debug"],
  ] as const) {
    const orig = console[name].bind(console);
    console[name] = (...args: unknown[]) => {
      orig(...args);
      try {
        record(level, util.format(...args));
      } catch {
        /* never break the caller */
      }
    };
  }
  process.on("exit", flushLogs);
}

/** Test helper: forget everything in memory. */
export function resetLogs() {
  ring = [];
  pending = "";
}
