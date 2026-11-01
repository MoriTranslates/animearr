import { useEffect, useState } from "react";
import { api, runFix, type Fix } from "./api";
import { navigate } from "./App";
import { t, type I18nKey } from "./i18n";
import { ImportBrowser } from "./importBrowser";
import { followAutoJob, outcomeMessage } from "./autojobs";
import { Chip, Modal, Spinner, useToast } from "./ui";

/** The UI's words for the fix actions (the server's label is the fallback). */
const FIX_LABEL: Partial<Record<string, I18nKey>> = { regrab: "ep.regrab", tryNext: "fix.tryNext", interactiveSearch: "auto.chooseRelease", retryImport: "managed.retryImport" };

/** The fix buttons for a problem (Queue, Activity, the bell, sheets). */
export function FixButtons({ fixes, small = true }: { fixes?: Fix[] | null; small?: boolean }) {
  if (!fixes?.length) return null;
  return (
    <span className="row fix-buttons">
      {fixes.map((f) => (
        <button key={f.action} className={small ? "small" : ""} onClick={(e) => (e.preventDefault(), e.stopPropagation(), runFix(f))}>
          {FIX_LABEL[f.action] ? t(FIX_LABEL[f.action]!) : f.label}
        </button>
      ))}
    </span>
  );
}

interface Ep { id: number; season: number; episode: number; title: string | null }
interface PlanItem { source: string; destArr: string; label: string; action: string; replaces: string | null; problem: string | null; episodeIds?: number[] }

/** Carries out fix actions (mounted once, in the app shell): navigation, one-click calls, the import dialog. */
export function FixHost() {
  const toast = useToast();
  const [dialog, setDialog] = useState<null | { tvdbId?: number; movieId?: number; path?: string | null; episodeIds?: number[]; pick?: boolean; grabId?: number | null; review?: boolean }>(null);
  useEffect(() => {
    const call = async (path: string, body: unknown, ok: string, method = "POST") => {
      try {
        const r = await api<{ jobId?: string }>(path, { method, body });
        toast(ok);
        window.dispatchEvent(new Event("animearr:changed"));
        // ⚡ answers at once; its outcome comes when the background search is done.
        if (r?.jobId)
          followAutoJob(r.jobId, (job) => {
            const o = outcomeMessage(job);
            toast(o.msg, o.error, undefined, { kind: o.got ? "grab" : "success" });
            window.dispatchEvent(new Event("animearr:changed"));
          });
      } catch (e) {
        toast((e as Error).message, true);
      }
    };
    const on = (e: Event) => {
      const f = (e as CustomEvent<Fix>).detail;
      const p = (f.params ?? {}) as { tvdbId?: number; movieId?: number; episodeIds?: number[]; path?: string | null; grabId?: number; service?: string; name?: string; review?: boolean };
      switch (f.action) {
        case "importManual":
          return setDialog({ tvdbId: p.tvdbId, movieId: p.movieId, path: p.path ?? null, episodeIds: p.review ? undefined : p.episodeIds, grabId: p.grabId ?? null, review: !!p.review });
        case "pickEpisode":
          return setDialog({ tvdbId: p.tvdbId, movieId: p.movieId, path: p.path ?? null, episodeIds: (p.episodeIds?.length ?? 0) > 1 ? undefined : p.episodeIds, pick: true, grabId: p.grabId ?? null });
        case "regrab":
          return p.movieId ? void call(`/movies/${p.movieId}/autosearch`, { replace: false }, t("fix.searching")) : void call("/autosearch", { tvdbId: p.tvdbId, episodeIds: p.episodeIds }, t("fix.searching"));
        case "keepAnyway":
          return void call(`/grabs/${p.grabId}/keep`, {}, t("fix.kept"));
        case "tryNext":
          return void call(`/grabs/${p.grabId}/next`, {}, t("fix.next"));
        case "retryImport":
          return void call(`/grabs/${p.grabId}/retry`, {}, t("managed.retried"));
        case "openRule":
          return navigate("/settings?tab=downloads");
        case "resumeRule":
          return void call("/downloads/rules/disable", { name: p.name }, t("fix.ruleOff"));
        case "resumeImports":
          if (!window.confirm(t("fix.importsConfirm"))) return;
          return void call("/media/importer", { allowReal: true, realBudget: -1, ...((p as { movies?: boolean }).movies ? { movies: true } : {}) }, t("fix.importsOn"), "PUT");
        case "interactiveSearch":
          return navigate(p.movieId ? `/movie/${p.movieId}?search=1` : `/search?tvdbId=${p.tvdbId}&eps=${(p.episodeIds ?? []).join(",")}`);
        case "testConnection":
          return void (async () => {
            try {
              const r = await api<{ version?: string }>(`/test/${p.service}`, { body: {} });
              toast(t("fix.connOk", { version: r.version ?? "" }));
            } catch (x) {
              toast((x as Error).message, true);
            }
          })();
        case "indexerHealth":
          return navigate("/settings?tab=indexers");
        case "openSettings":
          return navigate(`/settings?tab=${(p as { tab?: string }).tab ?? ""}`);
      }
    };
    window.addEventListener("animearr:fix", on);
    return () => window.removeEventListener("animearr:fix", on);
  }, [toast]);
  return dialog ? <ImportDialog {...dialog} onClose={() => setDialog(null)} /> : null;
}

/**
 * "Import manually…" / "Pick episode…" / the movie page's "Manual import…": browse AnimeArr's download folders (starting
 * in the grab's own download), pick a file or folder, preview, import. The typed path stays as an advanced fallback.
 */
export function ImportDialog({ tvdbId, movieId, path: initialPath, episodeIds, pick, grabId, review, onClose, onDone }: { tvdbId?: number; movieId?: number; path?: string | null; episodeIds?: number[]; pick?: boolean; grabId?: number | null; review?: boolean; onClose: () => void; onDone?: () => void }) {
  const toast = useToast();
  const [path, setPath] = useState(initialPath ?? "");
  const [eps, setEps] = useState<Ep[] | null>(null);
  const [chosen, setChosen] = useState<number[]>(episodeIds ?? []);
  const [items, setItems] = useState<PlanItem[] | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [place, setPlace] = useState("");
  // Several files (a season, a batch): each one is ticked or not, and can be given another episode.
  const [ticked, setTicked] = useState<Set<string> | null>(null);
  const [assign, setAssign] = useState<Record<string, number[]>>({});
  useEffect(() => {
    if (tvdbId) void api<{ episodes: Ep[] }>(`/series/${tvdbId}`).then((s) => setEps(s.episodes), () => setEps([]));
  }, [tvdbId]);
  const plan = async (p = path, opts: { ticked?: Set<string> | null; assign?: Record<string, number[]> } = {}) => {
    if (!p.trim()) return;
    setBusy(true);
    const tk = opts.ticked === undefined ? ticked : opts.ticked;
    const as = opts.assign ?? assign;
    try {
      const r = movieId
        ? await api<{ items: PlanItem[]; notes?: string[] }>("/import/movie-plan", { body: { movieId, path: p, grabId: grabId ?? undefined } })
        : await api<{ items: PlanItem[]; notes?: string[] }>("/import/plan", { body: { tvdbId, path: p, episodeIds: chosen.length ? chosen : undefined, grabId: grabId ?? undefined, only: tk ? [...tk] : undefined, assign: as } });
      setItems(r.items);
      // First look: every file that can go is ticked; a creditless extra or a clash starts unticked.
      if (!tk) setTicked(new Set(r.items.filter((i) => !i.problem).map((i) => i.source)));
      setNotes(r.notes ?? []);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  // Nothing is planned on open (the grab's file is only pre-selected); a file the user picks is checked right away.
  const select = (p: string, dir: boolean, auto: boolean) => {
    setPath(p);
    setItems(null);
    setNotes([]);
    setTicked(null);
    setAssign({});
    // "Review files…" from a download that needs you: its whole folder is listed right away.
    if (auto && (review || (pick && grabId))) void plan(p, { ticked: null, assign: {} });
    else if (!dir && !pick && !auto) void plan(p, { ticked: null, assign: {} });
  };
  const run = async () => {
    setBusy(true);
    try {
      const r = movieId
        ? await api<{ results: { done: boolean; why: string }[] }>("/import/movie-run", { body: { movieId, path, grabId: grabId ?? undefined } })
        : await api<{ results: { done: boolean; why: string }[] }>("/import/run", { body: { tvdbId, path, episodeIds: chosen.length ? chosen : undefined, dryRun: false, grabId: grabId ?? undefined, only: goes.map((i) => i.source), assign } });
      const ok = r.results.filter((x) => x.done).length;
      toast(t("import.done", { ok, total: r.results.length }), ok < r.results.length);
      window.dispatchEvent(new Event("animearr:changed"));
      if (ok) (onDone?.(), onClose());
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const many = !!tvdbId && (items?.length ?? 0) > 1;
  const goes = items?.filter((i) => !i.problem && (!many || !ticked || ticked.has(i.source))) ?? [];
  const ready = goes.length;
  const toggle = (src: string, on: boolean) => {
    const next = new Set(ticked ?? []);
    if (on) next.add(src);
    else next.delete(src);
    setTicked(next);
    void plan(path, { ticked: next });
  };
  const reassign = (src: string, id: number | null) => {
    const next = { ...assign, [src]: id ? [id] : [] };
    setAssign(next);
    const tk = new Set(ticked ?? []);
    if (id) tk.add(src);
    else tk.delete(src);
    setTicked(tk);
    void plan(path, { ticked: tk, assign: next });
  };
  const fileName = (src: string) => src.split(/[\\/]/).pop() ?? src;
  const label = (e: Ep) => `S${String(e.season).padStart(2, "0")}E${String(e.episode).padStart(2, "0")}${e.title ? ` · ${e.title}` : ""}`;
  return (
    <Modal title={t(pick ? "fix.pickTitle" : "fix.importTitle")} onClose={onClose}>
      <div className="stack">
        <p className="muted small">{t("import.browseHelp")}</p>
        <ImportBrowser start={initialPath} grabId={grabId} selected={path} onSelect={select} onPlace={setPlace} />
        <details className="small">
          <summary>{t("import.typePath")}</summary>
          <label className="stack small">
            {t("import.path")}
            <input value={path} onChange={(e) => (setPath(e.target.value), setItems(null))} onKeyDown={(e) => e.key === "Enter" && void plan()} placeholder="/data/…" spellCheck={false} />
          </label>
        </details>
        {path && (
          <p className="small import-selected">
            {t("import.selected")} <strong>{place && path.split("/").pop() === place.split(" › ").pop() ? place : path.split("/").pop()}</strong>
          </p>
        )}
        {tvdbId && !many && (
          <label className="stack small">
            {t("fix.episode")}
            {!eps ? (
              <Spinner label={t("app.loading")} />
            ) : (
              <select value={chosen[0] ?? ""} onChange={(e) => (setChosen(e.target.value ? [Number(e.target.value)] : []), setItems(null))}>
                <option value="">{t("fix.fromName")}</option>
                {eps.map((e) => (
                  <option key={e.id} value={e.id}>
                    {label(e)}
                  </option>
                ))}
              </select>
            )}
          </label>
        )}
        {notes.map((n) => (
          <p key={n} className="small muted">
            {n}
          </p>
        ))}
        {items && !items.length && <p className="small warn-text">{t("import.nothing")}</p>}
        {items && items.length > 0 && (
          <ul className="rename-list small">
            {many && <p className="muted">{t("import.reviewHelp")}</p>}
            {items.map((i) => (
              <li key={i.source} className="stack">
                {many ? (
                  <span className="row">
                    <label className="check">
                      <input type="checkbox" checked={!!ticked?.has(i.source)} disabled={busy} onChange={(e) => toggle(i.source, e.target.checked)} /> <b>{i.label}</b>
                    </label>
                    <select aria-label={t("import.episodeFor", { file: fileName(i.source) })} value={i.episodeIds?.[0] ?? ""} disabled={busy || !eps} onChange={(e) => reassign(i.source, e.target.value ? Number(e.target.value) : null)}>
                      <option value="">{t("import.notAnEpisode")}</option>
                      {(eps ?? []).map((e) => (
                        <option key={e.id} value={e.id}>
                          {label(e)}
                        </option>
                      ))}
                    </select>
                    <span className="muted">· {t(`import.action.${i.action}` as I18nKey)}</span>
                  </span>
                ) : (
                  <span>
                    <b>{i.label}</b> · {t(`import.action.${i.action}` as I18nKey)}
                  </span>
                )}
                <span className="muted">{i.source.split(/[\/]/).pop()}</span>
                {i.destArr && (
                  <span className="muted" title={i.destArr}>
                    → {i.destArr.split("/").slice(-2).join(" › ")}
                  </span>
                )}
                {i.replaces && <span className="muted">{t("import.replaces")}</span>}
                {i.problem && <Chip tone="warn">{i.problem}</Chip>}
              </li>
            ))}
          </ul>
        )}
        <div className="row import-actions">
          <button onClick={onClose}>{t("common.cancel")}</button>
          {/* One clear next step: check where it goes first, then import (the button says how many). */}
          {!items ? (
            <button className="primary" disabled={busy || !path.trim()} onClick={() => void plan()}>
              {busy ? t("import.checking") : t("import.check")}
            </button>
          ) : (
            <button className="primary" disabled={busy || !ready} onClick={() => void run()}>
              {t("import.runN", { n: ready })}
            </button>
          )}
        </div>
        <p className="small muted import-state" aria-live="polite">
          {!path.trim() ? t("import.state.pick") : !items ? t("import.state.check") : ready ? t("import.state.ready", { n: ready }) : t("import.state.none")}
        </p>
      </div>
    </Modal>
  );
}
