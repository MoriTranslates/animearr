/** Queue (AnimeArr's own downloads, with live client status) and grab history. */
import { cache, db } from "./db.js";
import { realDeps, type GrabRow, type PipelineDeps } from "./pipeline.js";
import type { ClientJob } from "./arr/clients.js";

const label = (id: number) => {
  const e = cache.prepare("SELECT season, episode FROM episodes WHERE id = ?").get(id) as { season: number; episode: number } | undefined;
  return e ? `S${String(e.season).padStart(2, "0")}E${String(e.episode).padStart(2, "0")}` : `#${id}`;
};
const seriesTitle = (tvdbId: number) => (cache.prepare("SELECT title FROM series WHERE tvdb_id = ?").get(tvdbId) as { title: string } | undefined)?.title ?? String(tvdbId);

function view(g: GrabRow) {
  const eps = JSON.parse(g.episode_ids) as number[];
  return { id: g.id, at: g.at, updatedAt: g.updated_at, tvdbId: g.tvdb_id, series: seriesTitle(g.tvdb_id), episodes: eps.map(label), episodeIds: eps, release: g.release, protocol: g.protocol, client: g.client, state: g.state, dryRun: !!g.dry_run, why: g.why, error: g.error, progress: g.progress ?? null, attempt: g.attempt ?? 1, origin: g.origin };
}

export async function queueView(deps: PipelineDeps = realDeps) {
  const active = db.prepare("SELECT * FROM grabs WHERE state IN ('sending', 'downloading', 'importing', 'needs-attention') ORDER BY id DESC").all() as unknown as GrabRow[];
  const items = await Promise.all(
    active.map(async (g) => {
      let live = null;
      if (g.state === "downloading" && g.client && g.client_ref) {
        try {
          live = await deps.clients.status({ client: g.client as ClientJob["client"], ref: g.client_ref });
        } catch (e) {
          live = { state: "unknown", progress: g.progress ?? 0, message: (e as Error).message };
        }
      }
      return { ...view(g), live };
    }),
  );
  return { items };
}

export function grabHistory(opts: { before?: number; limit?: number; state?: string } = {}) {
  const where = ["state NOT IN ('sending', 'downloading', 'importing', 'needs-attention')"];
  const args: (number | string)[] = [];
  if (opts.before) (where.push("id < ?"), args.push(opts.before));
  if (opts.state) (where.push("state = ?"), args.push(opts.state));
  const rows = db.prepare(`SELECT * FROM grabs WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`).all(...args, Math.min(200, opts.limit ?? 50)) as unknown as GrabRow[];
  return rows.map(view);
}
