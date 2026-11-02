/** Routes: System: jobs, metadata, logs, update check, backups. */
import { humanizeError } from "../errors.js";
import { checkForUpdates } from "../releases.js";
import { createBackup, MAX_BACKUP_BYTES, parseBackup, restoreUploaded, stageBackup, takeStaged } from "../backupTransfer.js";
import { getLogs, logText } from "../logs.js";
import { type FastifyReply } from "fastify";
import { authState, loginAllowed } from "../auth.js";
import { BACKUP_DIR, backupNow, CONFIG_DIR, dbState, listBackups, listJobs, resetCache, restoreBackup } from "../db.js";
import { syncLibrary } from "../library.js";
import { aliasIndex, invalidateIndex, metadataStatus, refreshMetadata } from "../metadata.js";

import { checkPassword, getSettings } from "../settings.js";
import { VERSION } from "../version.js";
import type { FastifyInstance } from "fastify";
import { STARTED, fail, writable } from "./common.js";

export function registerSystemRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- system: jobs, metadata, backups

  app.get("/api/system", async () => ({
    version: VERSION,
    uptime: Date.now() - STARTED,
    node: process.version,
    configDir: CONFIG_DIR,
    // Job errors in plain words ("AniDB titles download failed (HTTP 403)" → "AniDB refused…"), raw text as detailRaw.
    jobs: listJobs().map((j) => {
      const h = j.state === "error" ? humanizeError(String(j.detail ?? "")) : { message: j.detail, detail: null };
      return { ...j, detail: h.message, detailRaw: h.detail };
    }),
    metadata: metadataStatus(),
    aliasKeys: aliasIndex().size,
    db: { corrupt: dbState.corrupt, detail: dbState.detail },
    backups: listBackups(),
    backupDir: BACKUP_DIR,
    memoryMb: Math.round(process.memoryUsage().rss / 1e6),
  }));
  // Logs: the last lines (secrets already scrubbed), filtered; the download is plain text.
  app.get<{ Querystring: { level?: string; q?: string; limit?: string } }>("/api/system/logs", async (req) =>
    getLogs({ level: req.query.level, q: req.query.q, limit: Number(req.query.limit) || 500 }),
  );
  app.get("/api/system/logs/download", async (_req, reply) => {
    reply
      .header("Content-Type", "text/plain; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="animearr-logs-${new Date().toISOString().slice(0, 10)}.txt"`);
    return logText();
  });
  app.post("/api/system/metadata", async () => refreshMetadata(false));
  // Read-only: which release is newest on GitHub (offline → { offline: true }).
  app.get("/api/system/updates", async () => checkForUpdates());
  app.post("/api/system/backup", async () => {
    writable();
    return { name: backupNow("manual") };
  });
  app.post<{ Body: { name?: string; password?: string } }>("/api/system/restore", async (req) => {
    if (authState(req).via === "apikey") throw fail("Restoring needs the account password", 403);
    if (!loginAllowed(req.ip, getSettings().auth.username)) throw fail("Too many attempts, wait a few seconds", 429);
    if (!(await checkPassword(String(req.body?.password ?? ""), getSettings().auth.passwordHash))) throw fail("Wrong password", 403);
    restoreBackup(String(req.body?.name ?? ""));
    app.log.warn("Backup restored; exiting so the app restarts with it.");
    setTimeout(() => process.exit(0), 500);
    return {
      ok: true,
      message:
        "Restored. AnimeArr is restarting; reload the page in a few seconds (start it again yourself if it isn't running in Docker).",
    };
  });
  // Download / upload a whole backup (database + secret.key). Upload is two steps: the file is checked and staged,
  // then restoring it needs the account password, like restoring one of the automatic backups.
  // The file holds secret.key, so "no password on my home network" isn't enough: a logged-in session (GET) or the account
  // password (POST, what the UI sends) is.
  const sendBackup = async (reply: FastifyReply) => {
    const b = await createBackup();
    reply
      .header("Content-Type", "application/gzip")
      .header("Content-Disposition", `attachment; filename="${b.name}"`)
      .header("Cache-Control", "no-store");
    return b.data;
  };
  app.get("/api/system/backup/download", async (req, reply) => {
    if (authState(req).via !== "session")
      throw fail("Enter your password to download a backup (it holds the key to your saved passwords)", 403);
    return sendBackup(reply);
  });
  app.post<{ Body: { password?: string } }>("/api/system/backup/download", async (req, reply) => {
    if (authState(req).via === "apikey") throw fail("Log in to download a backup", 403);
    if (!loginAllowed(req.ip, getSettings().auth.username)) throw fail("Too many attempts, wait a few seconds", 429);
    if (!(await checkPassword(String(req.body?.password ?? ""), getSettings().auth.passwordHash))) throw fail("Wrong password", 403);
    return sendBackup(reply);
  });
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: MAX_BACKUP_BYTES }, (_req, body, done) =>
    done(null, body),
  );
  app.post<{ Body: Buffer }>("/api/system/backup/upload", { bodyLimit: MAX_BACKUP_BYTES }, async (req) => {
    if (authState(req).via === "apikey") throw fail("Log in to restore a backup", 403);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw fail("Choose a backup file", 400);
    const parsed = await parseBackup(req.body);
    const m = parsed.manifest;
    return { token: stageBackup(parsed), appVersion: m.appVersion, schema: m.schema, createdAt: m.createdAt, size: req.body.length };
  });
  app.post<{ Body: { token?: string; password?: string } }>("/api/system/backup/restore-upload", async (req) => {
    if (authState(req).via === "apikey") throw fail("Restoring needs the account password", 403);
    if (!loginAllowed(req.ip, getSettings().auth.username)) throw fail("Too many attempts, wait a few seconds", 429);
    if (!(await checkPassword(String(req.body?.password ?? ""), getSettings().auth.passwordHash))) throw fail("Wrong password", 403);
    restoreUploaded(takeStaged(String(req.body?.token ?? "")));
    app.log.warn("Uploaded backup restored; exiting so the app restarts with it.");
    setTimeout(() => process.exit(0), 500);
    return {
      ok: true,
      message:
        "Restored. AnimeArr is restarting; reload the page in a few seconds (start it again yourself if it isn't running in Docker). A safety copy of what was here before is in the backups folder.",
    };
  });
  app.post("/api/system/cache/reset", async (req) => {
    writable();
    if (authState(req).via === "apikey") throw fail("Log in to rebuild the cache", 403);
    resetCache();
    invalidateIndex();
    void syncLibrary(true).catch(() => undefined);
    return { ok: true };
  });
}
