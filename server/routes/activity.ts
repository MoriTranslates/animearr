/** Routes: The activity log and undo. */
import { undropShow } from "../library/dropped.js";
import { deleteOverrides, renameSidecarBack } from "../import/detection.js";
import { cache, db } from "../system/db.js";
import { getDecision, listDecisions, logDecision, markUndone } from "../system/activity.js";
import { coverFor } from "../metadata/covers.js";
import { setManaged, unmonitorInSonarr } from "../library/managed.js";
import { invalidateIndex } from "../metadata/metadata.js";
import { summarize } from "../system/summary.js";
import { registerBlocklistApi } from "../grabs/blocklist.js";
import { registerFileMarksApi } from "../import/fileMarks.js";
import { registerMetaOverrideApi } from "../metadata/metaoverride.js";

import { renameBack } from "../import/importer.js";
import { getSettings } from "../system/settings.js";
import type { FastifyInstance } from "fastify";
import { fail, id, writable } from "./common.js";

export function registerActivityRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- activity log + undo

  app.get<{ Querystring: { before?: string; tvdbId?: string; kinds?: string } }>("/api/activity", async (req) =>
    withArt(
      listDecisions({
        before: req.query.before ? Number(req.query.before) : undefined,
        tvdbId: req.query.tvdbId ? Number(req.query.tvdbId) : undefined,
        kinds: req.query.kinds ? req.query.kinds.split(",") : undefined,
        limit: 100,
      }),
    ),
  );
  /** Activity cards: the show/movie poster and a short episode label ("S01E02–E04"), looked up once per page. */
  function withArt<T extends { tvdbId: number | null; episodeIds: number[]; detail: unknown }>(list: T[]) {
    const covers = new Map<string, string | null>();
    const coverOf = (key: string, get: () => string | null) =>
      covers.has(key) ? covers.get(key)! : (covers.set(key, get()), covers.get(key)!);
    return list.map((d) => {
      const movieId = (d.detail as { movieId?: number } | null)?.movieId;
      const cover = d.tvdbId
        ? coverOf(`s${d.tvdbId}`, () => {
            const s = cache.prepare("SELECT tvdb_id, poster FROM series WHERE tvdb_id = ?").get(d.tvdbId) as
              { tvdb_id: number; poster: string | null } | undefined;
            return s ? coverFor(s) : null;
          })
        : movieId
          ? coverOf(
              `m${movieId}`,
              () =>
                (cache.prepare("SELECT poster FROM movies WHERE id = ?").get(movieId) as { poster: string | null } | undefined)?.poster ??
                null,
            )
          : null;
      let label = "";
      if (d.episodeIds.length) {
        const eps = d.episodeIds
          .map(
            (e) =>
              cache.prepare("SELECT season, episode FROM episodes WHERE id = ?").get(e) as { season: number; episode: number } | undefined,
          )
          .filter((x): x is { season: number; episode: number } => !!x)
          .sort((a, b) => a.season - b.season || a.episode - b.episode);
        if (eps.length)
          label = `S${String(eps[0].season).padStart(2, "0")}E${String(eps[0].episode).padStart(2, "0")}${eps.length > 1 ? `–E${String(eps[eps.length - 1].episode).padStart(2, "0")}` : ""}`;
      }
      // A plain one-line summary next to the raw message (old rows get one too); the title fills in when the entry lacks it.
      const title =
        (d as { title?: string }).title ||
        (d.tvdbId
          ? ((cache.prepare("SELECT title FROM series WHERE tvdb_id = ?").get(d.tvdbId) as { title: string } | undefined)?.title ?? "")
          : movieId
            ? ((cache.prepare("SELECT title FROM movies WHERE id = ?").get(movieId) as { title: string } | undefined)?.title ?? "")
            : "");
      const summary = summarize({ kind: (d as { kind?: string }).kind, why: (d as { why?: string }).why ?? "", title, label });
      return { ...d, title, cover, label, movieId: movieId ?? null, summary };
    });
  }
  registerBlocklistApi(app);
  registerFileMarksApi(app, { writable });
  registerMetaOverrideApi(app, { fetch, key: () => getSettings().metadata.tmdbKey, writable });
  app.post<{ Params: { id: string } }>("/api/activity/:id/undo", async (req) => {
    writable();
    const d = getDecision(id(req.params.id));
    if (!d?.undo) throw fail("This can't be undone", 404);
    if (d.undoneAt) throw fail("Already undone", 409);
    const a = d.undo.args as Record<string, number | string>;
    switch (d.undo.action) {
      case "unmanage":
        setManaged([Number(a.tvdbId)], false);
        break;
      case "manage":
        setManaged([Number(a.tvdbId)], true);
        break;
      case "rename-back":
        await renameBack(d.undo.args as unknown as Parameters<typeof renameBack>[0]);
        break;
      case "delete-alias":
        db.prepare("DELETE FROM aliases WHERE id = ?").run(Number(a.id));
        invalidateIndex();
        break;
      case "delete-rule":
        db.prepare("DELETE FROM rules WHERE id = ?").run(Number(a.id));
        break;
      case "delete-fact":
        db.prepare("DELETE FROM facts WHERE id = ?").run(Number(a.id));
        break;
      case "unmark-burned":
        db.prepare("DELETE FROM file_marks WHERE path = ?").run(String(a.path));
        break;
      case "unblock":
        if (a.id) db.prepare("DELETE FROM blocklist WHERE id = ?").run(Number(a.id));
        else db.prepare("DELETE FROM blocklist WHERE release = ?").run(String(a.release));
        break;
      case "remonitor":
        await unmonitorInSonarr(Number(a.tvdbId), true);
        break;
      case "undrop":
        undropShow(Number(a.tvdbId));
        break;
      case "delete-overrides":
        deleteOverrides(String(a.ids).split(",").map(Number).filter(Boolean));
        break;
      case "rename-sidecar-back":
        renameSidecarBack(d.undo.args as { dir: string; from: string; to: string });
        break;
    }
    markUndone(d.id);
    logDecision("info", { tvdbId: d.tvdbId, title: d.title, why: `Undid: ${d.why}` });
    return { ok: true };
  });
}
