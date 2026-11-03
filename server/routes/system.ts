/** Routes: System: jobs, metadata, logs, update check, backups. */
import { humanizeError } from "../system/errors.js";
import { checkForUpdates } from "../system/releases.js";
import {
  createBackup,
  dropStaged,
  MAX_BACKUP_BYTES,
  parseBackup,
  peekStaged,
  restoreBackup,
  restoreUploaded,
  safetyCopyFailed,
  stageBackup,
} from "../system/backupTransfer.js";
import { getLogs, logText } from "../system/logs.js";
import { type FastifyReply, type FastifyRequest } from "fastify";
import { authState, DEVICE_COOKIE, loginAllowed, loginSucceeded, validDevice } from "../system/auth.js";
import { BACKUP_DIR, backupNow, CONFIG_DIR, dbState, listBackups, listJobs, resetCache, restartNeeded } from "../system/db.js";
import { syncLibrary } from "../library/library.js";
import { aliasIndex, invalidateIndex, metadataStatus, refreshMetadata } from "../metadata/metadata.js";

import { checkPassword, getSettings, keepSessionsEndedAcrossRestore } from "../system/settings.js";
import { VERSION } from "../system/version.js";
import type { FastifyInstance } from "fastify";
import { STARTED, fail, writable } from "./common.js";

/*
 * Both restores take keepSessionsEndedAcrossRestore as their beforeSwap step: the session floor (blind review A9) is
 * written only once the input is checked and the safety copy made, right before the live files are replaced. A restore
 * refused before that writes no floor (R2: otherwise the next restart signed everyone out); if writing the floor
 * fails, nothing is replaced. Once it is written the swap follows, so a partly applied restore still can't bring
 * logged-out sessions back.
 */

/*
 * The password-checked backup routes are called by someone already let in, so they are throttled like the signed-in
 * password change: on this browser's device, or on one "signed-in" entry, never on the anonymous real-name entry for
 * the address. Behind a proxy everyone shares that address, and a flood guessing the user name kept it in back-off, so
 * the owner got 429 on restore exactly when they might need it (blind review round 2, R4). A stolen session guessing
 * the password still backs off on its own entry.
 */
const signedInAllowed = (req: FastifyRequest) =>
  loginAllowed(req.ip, getSettings().auth.username, validDevice(req.cookies[DEVICE_COOKIE]) ?? "signed-in");

/** A correct password clears the lane signedInAllowed counted it in (the login route does the same), so the owner starts fresh. */
const signedInPassed = (req: FastifyRequest) =>
  loginSucceeded(req.ip, getSettings().auth.username, validDevice(req.cookies[DEVICE_COOKIE]) ?? "signed-in");

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
  /*
   * Once a restore has closed the live database (it succeeded, or it stopped after the close: blind review round 4,
   * M1), this process can't serve it again; it exits so it restarts on what the folder holds. Until then, another
   * restore is refused instead of failing with "database is not open".
   */
  let restarting = false;
  const restartAfterRestore = (code: number, why: string) => {
    restarting = true;
    app.log[code ? "error" : "warn"](why);
    setTimeout(() => process.exit(code), 500);
  };
  const notRestarting = () => {
    if (restarting) throw fail("AnimeArr is restarting after a restore; reload the page in a few seconds", 503);
  };
  app.post<{ Body: { name?: string; password?: string } }>("/api/system/restore", async (req) => {
    notRestarting();
    if (authState(req).via === "apikey") throw fail("Restoring needs the account password", 403);
    if (!signedInAllowed(req)) throw fail("Too many attempts, wait a few seconds", 429);
    if (!(await checkPassword(String(req.body?.password ?? ""), getSettings().auth.passwordHash))) throw fail("Wrong password", 403);
    signedInPassed(req);
    notRestarting();
    try {
      restoreBackup(String(req.body?.name ?? ""), keepSessionsEndedAcrossRestore);
    } catch (e) {
      if (restartNeeded(e))
        restartAfterRestore(1, `Restore stopped after the database was closed; exiting so the app restarts. ${(e as Error).message}`);
      throw e;
    }
    restartAfterRestore(0, "Backup restored; exiting so the app restarts with it.");
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
    if (!signedInAllowed(req)) throw fail("Too many attempts, wait a few seconds", 429);
    if (!(await checkPassword(String(req.body?.password ?? ""), getSettings().auth.passwordHash))) throw fail("Wrong password", 403);
    signedInPassed(req);
    return sendBackup(reply);
  });
  // No bodyLimit on the parser itself: it is registered app-wide, so a limit here would let every route (the public
  // login included) buffer a backup-sized body (review M2). The upload route below raises its own limit.
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  app.post<{ Body: Buffer }>("/api/system/backup/upload", { bodyLimit: MAX_BACKUP_BYTES }, async (req) => {
    if (authState(req).via === "apikey") throw fail("Log in to restore a backup", 403);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw fail("Choose a backup file", 400);
    const parsed = await parseBackup(req.body);
    const m = parsed.manifest;
    return { token: stageBackup(parsed), appVersion: m.appVersion, schema: m.schema, createdAt: m.createdAt, size: req.body.length };
  });
  app.post<{ Body: { token?: string; password?: string } }>("/api/system/backup/restore-upload", async (req) => {
    if (authState(req).via === "apikey") throw fail("Restoring needs the account password", 403);
    if (!signedInAllowed(req)) throw fail("Too many attempts, wait a few seconds", 429);
    if (!(await checkPassword(String(req.body?.password ?? ""), getSettings().auth.passwordHash))) throw fail("Wrong password", 403);
    signedInPassed(req);
    notRestarting();
    const token = String(req.body?.token ?? "");
    const staged = peekStaged(token);
    try {
      restoreUploaded(staged, keepSessionsEndedAcrossRestore);
    } catch (e) {
      // Stopped after the database was closed: no retry in this process (blind review round 4, M1). The swap was
      // undone where it could be, the message says what the folder holds, and the app restarts to reopen it.
      if (restartNeeded(e)) {
        dropStaged(token);
        restartAfterRestore(
          1,
          `Uploaded backup restore stopped after the database was closed; exiting so the app restarts. ${(e as Error).message}`,
        );
        throw e;
      }
      // Failed before anything live was touched: the upload stays staged (blind review round 3, L5), so the user can
      // retry without sending a possibly large file again; the message says so.
      // A safety copy that couldn't be made (a full disk, a read-only backups folder) fails the same way on a plain
      // retry, so the message names what to fix instead of saying "try again" (blind review round 5, M1).
      const err = e as Error & { statusCode?: number };
      const next = safetyCopyFailed(e)
        ? "Fix that first (free some disk space, or check the backups folder can be written). The uploaded file is kept for a few minutes, so you won't need to choose it again."
        : "The uploaded file is kept for a few minutes: try again without choosing the file again.";
      throw Object.assign(new Error(`${err.message}. ${next}`, { cause: e }), { statusCode: err.statusCode ?? 500 });
    }
    dropStaged(token);
    restartAfterRestore(0, "Uploaded backup restored; exiting so the app restarts with it.");
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
