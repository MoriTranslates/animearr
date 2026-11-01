/**
 * Per-file marks the user sets on a library file: "this file has burned-in <lang> subtitles" (a hardsubbed release
 * with no subtitle tracks). The language check then counts the file as having that language, like the per-season
 * burned-in fact (audit.ts burnedInFact) but for this one file. Keyed by the file's path (Sonarr's file ids change on
 * every re-import); a renamed or replaced file loses its mark, which is what the user wants for a new file.
 */
import type { FastifyInstance } from "fastify";
import path from "node:path";
import { logDecision } from "./activity.js";
import { cache, db, dbState } from "./db.js";

/** The language a file was marked as having burned-in subtitles in, or null. */
export function burnedInFile(filePath: string): string | null {
  return (db.prepare("SELECT burned_lang FROM file_marks WHERE path = ?").get(filePath) as { burned_lang: string } | undefined)?.burned_lang ?? null;
}

/** Every marked file of a show (path → language). */
export function burnedInFiles(tvdbId: number): Map<string, string> {
  return new Map((db.prepare("SELECT path, burned_lang FROM file_marks WHERE tvdb_id = ?").all(tvdbId) as { path: string; burned_lang: string }[]).map((r) => [r.path, r.burned_lang]));
}

/** Marks (lang) or unmarks (null) a library file. Only files the library knows can be marked. */
export function markBurnedIn(filePath: string, lang: string | null, now = Date.now()) {
  if (dbState.corrupt) throw Object.assign(new Error("The database failed its integrity check; restore a backup first"), { statusCode: 503 });
  const f = cache.prepare("SELECT f.path, s.tvdb_id, s.title FROM files f JOIN series s ON s.id = f.series_id WHERE f.path = ?").get(filePath) as { path: string; tvdb_id: number; title: string } | undefined;
  if (!f) throw Object.assign(new Error("That file isn't in the library"), { statusCode: 404 });
  const name = path.posix.basename(f.path);
  if (lang) {
    if (!/^[a-z]{2,3}$/.test(lang)) throw Object.assign(new Error("Pick a language"), { statusCode: 400 });
    db.prepare("INSERT INTO file_marks (path, tvdb_id, burned_lang, at) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET burned_lang = excluded.burned_lang, at = excluded.at").run(f.path, f.tvdb_id, lang, now);
    logDecision("fact", { tvdbId: f.tvdb_id, title: f.title, why: `You confirmed: ${name} has burned-in ${lang} subtitles, so it counts as having them`, undo: { action: "unmark-burned", args: { path: f.path } } });
  } else {
    db.prepare("DELETE FROM file_marks WHERE path = ?").run(f.path);
    logDecision("fact", { tvdbId: f.tvdb_id, title: f.title, why: `You removed the burned-in subtitles mark from ${name}` });
  }
  return { path: f.path, burnedLang: lang };
}

export function registerFileMarksApi(app: FastifyInstance, opts: { writable: () => void }) {
  app.post<{ Body: { path?: string; lang?: string | null } }>("/api/files/burned-in", async (req) => {
    opts.writable();
    const p = String(req.body?.path ?? "");
    if (!p) throw Object.assign(new Error("Which file?"), { statusCode: 400 });
    return markBurnedIn(p, req.body?.lang ? String(req.body.lang).toLowerCase() : null);
  });
}
