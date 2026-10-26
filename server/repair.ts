/**
 * After-import check (PROPOSAL Phase 1, "verify → repair"): every file that lands in an allowed root folder is checked
 * against its show's language profile, whoever imported it (AnimeArr's grabs are already verified in the pipeline;
 * this covers Sonarr's own imports and manual imports).
 *
 * Safety rails:
 * - mode "log" (default) only reports; "auto" acts; "off" does nothing. Never looks back more than a day, so turning
 *   it on later doesn't replay an old backlog.
 * - Acting needs TWO signals: ffprobe says the file fails AND (Sonarr's track info agrees, or ffprobe found explicit
 *   evidence: a forced/signs-only track or a dub without the original audio). One signal = "suspected", logged only.
 *   A file shorter than the TVDB runtime is never enough on its own (runtimes are often wrong).
 * - One repair per release (a season pack is one repair, not twelve), capped per day (repair.maxPerDay), at most
 *   once per episode per day and 3 times per episode in all, then it gives up and leaves it to you.
 * - Honors dry-run: the show's dry-run for managed shows, the global dry-run for everything else.
 * - Never deletes files. Repair = blocklist the release in AnimeArr (with undo) and then:
 *   managed shows → AnimeArr searches for a replacement (the import replaces the file);
 *   other shows → the grab is marked failed in Sonarr, so Sonarr blocklists it too.
 * - Each import is recorded before anything is changed, so an error can't make it repeat.
 */
import path from "node:path";
import { logDecision } from "./activity.js";
import * as sonarr from "./arr/sonarr.js";
import { burnedInFact } from "./audit.js";
import { langList } from "./core/langs.js";
import { parseRelease } from "./core/parser.js";
import { cache, db, dbState, setJob } from "./db.js";
import { searchAgainSoon } from "./episodes.js";
import { radarrMovieSpecials } from "./franchise.js";
import { learnFromVerify, sourceKey } from "./library.js";
import { listManaged } from "./managed.js";
import { localPath } from "./paths.js";
import { profileFor } from "./profiles.js";
import { getSettings, isDryRun, underAllowedRoot } from "./settings.js";
import { ffprobe, judge, type ProbeResult, type VerifyVerdict } from "./verify.js";

export interface RepairDeps {
  history(since: Date): Promise<sonarr.HistoryItem[]>;
  episodeFile(id: number): Promise<sonarr.SonarrEpisodeFile>;
  grabsOf(episodeId: number): Promise<sonarr.HistoryItem[]>;
  markFailed(historyId: number): Promise<void>;
  probe(file: string): Promise<ProbeResult>;
  localPath(p: string): string | null;
}
export const realRepairDeps: RepairDeps = {
  history: (since) => sonarr.getHistorySince(since, "downloadFolderImported"),
  episodeFile: sonarr.getEpisodeFile,
  grabsOf: sonarr.getEpisodeGrabs,
  markFailed: sonarr.markHistoryFailed,
  probe: (f) => ffprobe(f),
  localPath,
};

const DAY = 86_400_000;
const OVERLAP = 2 * 3_600_000; // re-read 2 h before the watermark (clock skew); history ids dedupe the overlap
const MAX_PER_EPISODE = 3;
const EXPLICIT: VerifyVerdict["code"][] = ["forced-only", "dub-only"];

export type CheckAction = "none" | "unchecked" | "suspected" | "would-repair" | "repaired" | "capped" | "gave-up" | "skipped" | "error";
export interface CheckOutcome { historyId: number; title: string; label: string; ok: boolean; action: CheckAction; why: string }

const kvGet = (k: string) => (db.prepare("SELECT value FROM kv WHERE key = ?").get(k) as { value: string } | undefined)?.value;
const kvSet = (k: string, v: string) => db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v);

/** Is this import AnimeArr's own (already verified by the pipeline, or still being handled by it)? */
function ownImport(h: sonarr.HistoryItem, importedAt: number): string | null {
  if (h.downloadId && db.prepare("SELECT 1 FROM grabs WHERE lower(client_ref) = lower(?) LIMIT 1").get(h.downloadId)) return "AnimeArr's own grab, checked by its pipeline";
  const g = db.prepare("SELECT state FROM grabs WHERE EXISTS (SELECT 1 FROM json_each(grabs.episode_ids) WHERE value = ?) AND (state IN ('sending', 'downloading', 'importing', 'needs-attention', 'removing') OR (updated_at BETWEEN ? AND ?)) LIMIT 1").get(h.episodeId, importedAt - 3 * 3_600_000, importedAt + 3 * 3_600_000) as { state: string } | undefined;
  if (g) return `AnimeArr has its own grab for this episode (${g.state}), so it's left to the pipeline`;
  const st = db.prepare("SELECT state FROM search_state WHERE episode_id = ?").get(h.episodeId) as { state: string } | undefined;
  if (st?.state === "replace") return "AnimeArr is already searching for a replacement";
  return null;
}

/** Checks the imports Sonarr recorded since the last run. Returns what it did (also written to the activity log). */
export async function checkNewImports(deps: RepairDeps = realRepairDeps, now = Date.now()): Promise<CheckOutcome[]> {
  const settings = getSettings();
  const mode = settings.repair.mode;
  if (mode === "off" || dbState.corrupt) return [];
  const wm = Number(kvGet("repair-watermark") ?? 0);
  const since = new Date(Math.max(wm ? wm - OVERLAP : 0, now - DAY));
  const items = (await deps.history(since)).sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.id - b.id);
  const out: CheckOutcome[] = [];
  // The daily budget counts releases, not episodes (a bad season pack is one repair).
  const repairedToday = (db.prepare("SELECT COUNT(DISTINCT COALESCE(download_id, release)) AS n FROM checked_imports WHERE action = 'repaired' AND at > ?").get(now - DAY) as { n: number }).n;
  let budget = Math.max(0, settings.repair.maxPerDay - repairedToday);
  const probes = new Map<string, ProbeResult | null>();
  let maxSeen = wm;
  let oldestUnresolved = Infinity;
  for (const h of items) {
    const importedAt = Date.parse(h.date) || now;
    if (db.prepare("SELECT 1 FROM checked_imports WHERE history_id = ?").get(h.id)) {
      maxSeen = Math.max(maxSeen, importedAt);
      continue;
    }
    const imported = h.data.importedPath ?? "";
    const series = cache.prepare("SELECT id, tvdb_id, title, path FROM series WHERE id = ?").get(h.seriesId) as { id: number; tvdb_id: number; title: string; path: string } | undefined;
    // Only files in the allowed root folders are AnimeArr's business.
    if (!underAllowedRoot(imported || series?.path)) {
      maxSeen = Math.max(maxSeen, importedAt);
      continue;
    }
    const ep = cache.prepare("SELECT season, episode, runtime FROM episodes WHERE id = ?").get(h.episodeId) as { season: number; episode: number; runtime: number | null } | undefined;
    if (!series || !ep) {
      // A show (or episode) added since the last sync: keep it for the next run instead of skipping it forever.
      oldestUnresolved = Math.min(oldestUnresolved, importedAt);
      continue;
    }
    maxSeen = Math.max(maxSeen, importedAt);
    const label = `S${String(ep.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")}`;
    const dl = h.downloadId ?? null;
    const record = (o: Omit<CheckOutcome, "historyId" | "title" | "label">) => {
      db.prepare("INSERT OR REPLACE INTO checked_imports (history_id, tvdb_id, episode_id, release, ok, action, why, at, download_id, title, label, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(h.id, series.tvdb_id, h.episodeId, h.sourceTitle, o.ok ? 1 : 0, o.action, o.why, now, dl, series.title, label, importedAt);
      const i = out.findIndex((x) => x.historyId === h.id);
      if (i >= 0) out.splice(i, 1);
      out.push({ historyId: h.id, title: series.title, label, ...o });
    };
    try {
      const own = ownImport(h, importedAt);
      if (own) {
        record({ ok: true, action: "skipped", why: own });
        continue;
      }
      const prof = profileFor(series.tvdb_id);
      const burned = prof.subLangs.find((l) => !!burnedInFact(series.tvdb_id, ep.season, l)) ?? null;
      // Signal 1: ffprobe on the file itself (once per file: a multi-episode file has several import rows).
      const local = imported ? deps.localPath(imported) : null;
      let probe: ProbeResult | null = null;
      if (local) {
        if (!probes.has(local)) probes.set(local, await deps.probe(local).catch(() => null));
        probe = probes.get(local) ?? null;
      }
      // Signal 2: Sonarr's own track info for the file.
      let sonarrSays: VerifyVerdict | null = null;
      const fileId = Number(h.data.fileId);
      if (fileId) {
        try {
          const f = await deps.episodeFile(fileId);
          sonarrSays = judge({ subs: langList(f.mediaInfo?.subtitles), audio: langList(f.mediaInfo?.audioLanguages), durationSec: null, sidecars: [], untagged: 0 }, prof, null, burned);
        } catch {
          sonarrSays = null; // the file may have been replaced since
        }
      }
      const v = probe ? judge(probe, prof, ep.runtime ?? null, burned) : sonarrSays;
      if (!v) {
        record({ ok: false, action: "unchecked", why: "couldn't read the file or Sonarr's track info" });
        continue;
      }
      const parsed = parseRelease(h.sourceTitle);
      if (probe) learnFromVerify(h.data.releaseGroup ?? parsed.group, parsed.platform ?? sourceKey(h.sourceTitle, null, parsed.source), v.subs, v.audio);
      if (v.ok) {
        record({ ok: true, action: "none", why: v.why });
        logDecision("verify-ok", { tvdbId: series.tvdb_id, title: series.title, episodeIds: [h.episodeId], release: h.sourceTitle, why: `Checked ${label} after Sonarr imported it: ${v.why}` });
        continue;
      }
      const twoSignals = !!probe && (sonarrSays?.ok === false || EXPLICIT.includes(v.code));
      const managed = listManaged().find((m) => m.tvdbId === series.tvdb_id);
      const dryRun = managed ? isDryRun(managed.dryRun) : settings.managed.dryRun;
      // The same release (a pack or multi-episode file) already repaired: don't blocklist or count it again.
      const sameRelease = db.prepare("SELECT history_id FROM checked_imports WHERE action = 'repaired' AND history_id != ? AND ((? IS NOT NULL AND download_id = ?) OR (release = ? AND tvdb_id = ?)) LIMIT 1").get(h.id, dl, dl, h.sourceTitle, series.tvdb_id);
      const episodeRepairs = db.prepare("SELECT COUNT(*) AS n, MAX(at) AS last FROM checked_imports WHERE episode_id = ? AND action = 'repaired'").get(h.episodeId) as { n: number; last: number | null };
      let action: CheckAction;
      let note: string;
      if (!twoSignals) {
        action = "suspected";
        note = !probe
          ? "only Sonarr's track info was available (the file isn't reachable from here), so nothing was changed"
          : v.code === "short"
            ? "the episode runtime on TVDB is often wrong, so a short file alone changes nothing"
            : "Sonarr's track info disagrees, so nothing was changed";
      } else if (mode !== "auto") {
        action = "would-repair";
        note = "the after-import check is in log-only mode";
      } else if (dryRun) {
        action = "would-repair";
        note = managed ? "the show is in dry-run" : "dry-run is on";
      } else if (episodeRepairs.n >= MAX_PER_EPISODE) {
        action = "gave-up";
        note = `this episode was already repaired ${episodeRepairs.n} times; it's left for you to sort out`;
      } else if (episodeRepairs.last && episodeRepairs.last > now - DAY) {
        action = "capped";
        note = "this episode was already repaired today";
      } else if (!sameRelease && budget <= 0) {
        action = "capped";
        note = `the daily limit (${settings.repair.maxPerDay}) is reached`;
      } else if (radarrMovieSpecials(series.id).has(h.episodeId)) {
        action = "suspected";
        note = "this special is a movie Radarr handles, so it isn't repaired as an episode";
      } else {
        // Record first: if anything below fails, this import is not tried again (no repeated blocklisting).
        record({ ok: false, action: "error", why: `${v.why}; repair started but didn't finish` });
        let undo: { action: "unblock"; args: { id: number; release: string } } | undefined;
        if (!sameRelease) {
          budget--;
          const existing = db.prepare("SELECT id FROM blocklist WHERE release = ? AND tvdb_id = ? LIMIT 1").get(h.sourceTitle, series.tvdb_id) as { id: number } | undefined;
          const id = existing?.id ?? Number(db.prepare("INSERT INTO blocklist (guid, release, tvdb_id, reason, at) VALUES (NULL, ?, ?, ?, ?)").run(h.sourceTitle, series.tvdb_id, `after-import check: ${v.why}`, now).lastInsertRowid);
          undo = { action: "unblock", args: { id, release: h.sourceTitle } };
        }
        try {
          if (managed) {
            searchAgainSoon(series.tvdb_id, [h.episodeId], { replace: true, why: `After-import check: ${label} failed the profile (${v.why}); searching for a replacement` });
            note = sameRelease ? "same release as an earlier repair; AnimeArr is searching for a replacement for this episode too" : "blocklisted it; AnimeArr is searching for a replacement (the import replaces the file)";
          } else if (sameRelease) {
            note = "same release as an earlier repair (already marked failed in Sonarr)";
          } else {
            const grab = (await deps.grabsOf(h.episodeId).catch(() => [] as sonarr.HistoryItem[])).find((g) => (dl && g.downloadId?.toLowerCase() === dl.toLowerCase()) || g.sourceTitle === h.sourceTitle);
            if (grab) {
              await deps.markFailed(grab.id);
              note = "blocklisted it and marked the grab failed in Sonarr (Sonarr blocklists it too; it only grabs a replacement if Redownload Failed is on and the replacement counts as an upgrade, since the file stays)";
            } else note = "blocklisted it in AnimeArr (Sonarr's grab record wasn't found, so Sonarr wasn't told)";
          }
        } catch (e) {
          record({ ok: false, action: "error", why: `${v.why}; blocklisted, but the re-search failed: ${(e as Error).message}` });
          continue;
        }
        action = "repaired";
        record({ ok: false, action, why: `${v.why}; ${note}` });
        logDecision("verify-fail", {
          tvdbId: series.tvdb_id,
          title: series.title,
          episodeIds: [h.episodeId],
          release: h.sourceTitle,
          why: `After-import check of ${label} (${path.posix.basename(imported)}): ${v.why}. Repaired: ${note}.${undo && !managed ? " Undo removes AnimeArr's blocklist entry only, not Sonarr's." : ""}`,
          undo,
        });
        continue;
      }
      record({ ok: false, action, why: `${v.why}; ${note}` });
      logDecision(action === "suspected" ? "info" : "verify-fail", { tvdbId: series.tvdb_id, title: series.title, episodeIds: [h.episodeId], release: h.sourceTitle, why: `After-import check of ${label} (${path.posix.basename(imported)}): ${v.why}. ${action === "would-repair" ? "Would blocklist it and search again" : action === "suspected" ? "Suspected only" : "Not repaired"}: ${note}.` });
    } catch (e) {
      record({ ok: false, action: "error", why: `check failed: ${(e as Error).message}` });
    }
  }
  // Watermark = the newest import date seen (Sonarr's clock), but never past an import we couldn't resolve yet.
  const next = Number.isFinite(oldestUnresolved) ? Math.min(maxSeen, oldestUnresolved - 1) : maxSeen;
  if (next > 0) kvSet("repair-watermark", String(next));
  return out;
}

let running: Promise<CheckOutcome[]> | null = null;
/** Runs one check (shared if one is already running). Returns null when the check is off or Sonarr isn't set up. */
export function repairTick(): Promise<CheckOutcome[]> | null {
  if (running) return running;
  if (getSettings().repair.mode === "off" || !getSettings().sonarr.url) return null;
  running = (async () => {
    try {
      const r = await checkNewImports();
      const bad = r.filter((x) => !x.ok && x.action !== "skipped").length;
      setJob("after-import check", "done", `${r.length} new imports checked, ${bad} not meeting the profile (${getSettings().repair.mode === "auto" ? "repair on" : "log only"})`);
      return r;
    } catch (e) {
      setJob("after-import check", "error", (e as Error).message);
      throw e;
    } finally {
      running = null;
    }
  })();
  return running;
}

export function recentChecks(limit = 50) {
  return db.prepare("SELECT * FROM checked_imports ORDER BY at DESC, history_id DESC LIMIT ?").all(limit);
}
