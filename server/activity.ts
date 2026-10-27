import { db, dbState } from "./db.js";
import { liveFixesFor } from "./fixes.js";
import { onDecision } from "./notify.js";

/**
 * Activity log: every action and decision with a plain-language "why" (design principle: helpful but transparent,
 * never scary). `undo` describes how to reverse an action when that is possible.
 */
export type DecisionKind =
  | "would-grab" // dry-run
  | "grab"
  | "skip" // nothing good enough / rejected candidates
  | "import"
  | "would-import"
  | "verify-ok"
  | "verify-fail"
  | "fail"
  | "search"
  | "managed"
  | "alias"
  | "rule"
  | "fact"
  | "sonarr"
  | "sync"
  | "info";

export interface Undo {
  action: "unmanage" | "manage" | "delete-alias" | "delete-rule" | "delete-fact" | "remonitor" | "unblock" | "rename-back" | "delete-overrides" | "rename-sidecar-back" | "undrop";
  args: Record<string, unknown>;
}

export function logDecision(kind: DecisionKind, d: { tvdbId?: number | null; title?: string; episodeIds?: number[]; release?: string | null; why: string; detail?: unknown; undo?: Undo | null }) {
  if (dbState.corrupt) {
    console.warn(`[activity, not saved: database read-only] ${kind}: ${d.why}`);
    return 0;
  }
  const r = db
    .prepare("INSERT INTO decisions (at, kind, tvdb_id, title, episode_ids, release, why, detail, undo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(Date.now(), kind, d.tvdbId ?? null, d.title ?? "", JSON.stringify(d.episodeIds ?? []), d.release ?? null, d.why, JSON.stringify(d.detail ?? {}), d.undo ? JSON.stringify(d.undo) : null);
  onDecision(kind, d); // the bell + Discord/ntfy for grabbed/imported/failed/paused
  return Number(r.lastInsertRowid);
}

export interface DecisionRow {
  id: number;
  at: number;
  kind: DecisionKind;
  tvdbId: number | null;
  title: string;
  episodeIds: number[];
  release: string | null;
  why: string;
  detail: unknown;
  undo: Undo | null;
  undoneAt: number | null;
}

export function listDecisions(opts: { tvdbId?: number; kinds?: string[]; before?: number; limit?: number } = {}): DecisionRow[] {
  const where: string[] = [];
  const args: (number | string)[] = [];
  if (opts.tvdbId) {
    where.push("tvdb_id = ?");
    args.push(opts.tvdbId);
  }
  if (opts.kinds?.length) {
    where.push(`kind IN (${opts.kinds.map(() => "?").join(",")})`);
    args.push(...opts.kinds);
  }
  if (opts.before) {
    where.push("id < ?");
    args.push(opts.before);
  }
  const rows = db
    .prepare(`SELECT * FROM decisions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
    .all(...args, Math.min(500, opts.limit ?? 100)) as { id: number; at: number; kind: DecisionKind; tvdb_id: number | null; title: string; episode_ids: string; release: string | null; why: string; detail: string; undo: string | null; undone_at: number | null }[];
  return rows.map((r) => {
    const detail = JSON.parse(r.detail) as { grabId?: number; movieId?: number };
    const episodeIds = JSON.parse(r.episode_ids) as number[];
    const problem = r.kind === "fail" || r.kind === "verify-fail" || r.kind === "skip" || (r.kind === "info" && /needs a look|paused|couldn't|failed/i.test(r.why));
    const fixes = problem ? liveFixesFor(r.why, { kind: r.kind, grabId: detail.grabId ?? null, tvdbId: r.tvdb_id, movieId: detail.movieId ?? null, episodeIds }) : [];
    return { id: r.id, at: r.at, kind: r.kind, tvdbId: r.tvdb_id, title: r.title, episodeIds, release: r.release, why: r.why, detail, undo: r.undo ? JSON.parse(r.undo) : null, undoneAt: r.undone_at, fixes };
  });
}

export function getDecision(id: number) {
  return listDecisions({ limit: 1, before: id + 1 }).find((d) => d.id === id) ?? null;
}

export function markUndone(id: number) {
  db.prepare("UPDATE decisions SET undone_at = ? WHERE id = ?").run(Date.now(), id);
}

/** Keeps the log bounded: decisions older than 180 days are removed (grabs and facts stay in their own tables). */
export function pruneDecisions() {
  if (!dbState.corrupt) db.prepare("DELETE FROM decisions WHERE at < ?").run(Date.now() - 180 * 86_400_000);
}
