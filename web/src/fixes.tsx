import { useEffect, useState } from "react";
import { api, runFix, type Fix } from "./api";
import { navigate } from "./App";
import { t } from "./i18n";
import { Chip, Modal, Spinner, useToast } from "./ui";

/** The fix buttons for a problem (Queue, Activity, the bell, sheets). */
export function FixButtons({ fixes, small = true }: { fixes?: Fix[] | null; small?: boolean }) {
  if (!fixes?.length) return null;
  return (
    <span className="row fix-buttons">
      {fixes.map((f) => (
        <button key={f.action} className={small ? "small" : ""} onClick={(e) => (e.preventDefault(), e.stopPropagation(), runFix(f))}>
          {f.label}
        </button>
      ))}
    </span>
  );
}

interface Ep { id: number; season: number; episode: number; title: string | null }
interface PlanItem { source: string; destArr: string; label: string; action: string; replaces: string | null; problem: string | null }

/** Carries out fix actions (mounted once, in the app shell): navigation, one-click calls, the import dialog. */
export function FixHost() {
  const toast = useToast();
  const [dialog, setDialog] = useState<null | { tvdbId?: number; movieId?: number; path?: string | null; episodeIds?: number[]; pick?: boolean }>(null);
  useEffect(() => {
    const call = async (path: string, body: unknown, ok: string, method = "POST") => {
      try {
        await api(path, { method, body });
        toast(ok);
        window.dispatchEvent(new Event("animearr:changed"));
      } catch (e) {
        toast((e as Error).message, true);
      }
    };
    const on = (e: Event) => {
      const f = (e as CustomEvent<Fix>).detail;
      const p = (f.params ?? {}) as { tvdbId?: number; movieId?: number; episodeIds?: number[]; path?: string | null; grabId?: number; service?: string; name?: string };
      switch (f.action) {
        case "importManual":
          return setDialog({ tvdbId: p.tvdbId, movieId: p.movieId, path: p.path ?? null, episodeIds: p.episodeIds });
        case "pickEpisode":
          return setDialog({ tvdbId: p.tvdbId, movieId: p.movieId, path: p.path ?? null, episodeIds: p.episodeIds, pick: true });
        case "regrab":
          return p.movieId ? void call(`/movies/${p.movieId}/autosearch`, { replace: false }, t("fix.searching")) : void call("/autosearch", { tvdbId: p.tvdbId, episodeIds: p.episodeIds }, t("fix.searching"));
        case "keepAnyway":
          return void call(`/grabs/${p.grabId}/keep`, {}, t("fix.kept"));
        case "tryNext":
          return void call(`/grabs/${p.grabId}/next`, {}, t("fix.next"));
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
          return navigate("/settings?tab=connections");
      }
    };
    window.addEventListener("animearr:fix", on);
    return () => window.removeEventListener("animearr:fix", on);
  }, [toast]);
  return dialog ? <ImportDialog {...dialog} onClose={() => setDialog(null)} /> : null;
}

/** "Import manually…" / "Pick episode…": the file (pre-filled) and its episode/movie, one confirm. */
function ImportDialog({ tvdbId, movieId, path: initialPath, episodeIds, pick, onClose }: { tvdbId?: number; movieId?: number; path?: string | null; episodeIds?: number[]; pick?: boolean; onClose: () => void }) {
  const toast = useToast();
  const [path, setPath] = useState(initialPath ?? "");
  const [eps, setEps] = useState<Ep[] | null>(null);
  const [chosen, setChosen] = useState<number[]>(episodeIds ?? []);
  const [items, setItems] = useState<PlanItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (tvdbId) void api<{ episodes: Ep[] }>(`/series/${tvdbId}`).then((s) => setEps(s.episodes), () => setEps([]));
  }, [tvdbId]);
  const plan = async () => {
    setBusy(true);
    try {
      if (movieId) setItems((await api<{ items: PlanItem[] }>("/import/movie-plan", { body: { movieId, path } })).items);
      else setItems((await api<{ items: PlanItem[] }>("/import/plan", { body: { tvdbId, path, episodeIds: chosen.length ? chosen : undefined } })).items);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (initialPath && !pick) void plan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const run = async () => {
    setBusy(true);
    try {
      const r = movieId
        ? await api<{ results: { done: boolean; why: string }[] }>("/import/movie-run", { body: { movieId, path } })
        : await api<{ results: { done: boolean; why: string }[] }>("/import/run", { body: { tvdbId, path, episodeIds: chosen.length ? chosen : undefined, dryRun: false } });
      const ok = r.results.filter((x) => x.done).length;
      toast(t("import.done", { ok, total: r.results.length }), ok < r.results.length);
      window.dispatchEvent(new Event("animearr:changed"));
      if (ok) onClose();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const label = (e: Ep) => `S${String(e.season).padStart(2, "0")}E${String(e.episode).padStart(2, "0")}${e.title ? ` · ${e.title}` : ""}`;
  return (
    <Modal title={t(pick ? "fix.pickTitle" : "fix.importTitle")} onClose={onClose}>
      <div className="stack">
        <label className="stack small">
          {t("import.path")}
          <input value={path} onChange={(e) => (setPath(e.target.value), setItems(null))} placeholder="/data/…" />
        </label>
        {tvdbId && (
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
        <button className="small self-start" disabled={busy || !path.trim()} onClick={() => void plan()}>
          {t("import.preview")}
        </button>
        {items && (
          <ul className="rename-list small">
            {items.map((i) => (
              <li key={i.source} className="stack">
                <span>
                  <b>{i.label}</b> · {i.action}
                </span>
                <span className="mono muted">{i.destArr || i.source}</span>
                {i.replaces && <span className="muted">{t("import.replaces")}</span>}
                {i.problem && <Chip tone="warn">{i.problem}</Chip>}
              </li>
            ))}
          </ul>
        )}
        <div className="row">
          <button onClick={onClose}>{t("common.cancel")}</button>
          <button className="primary" disabled={busy || !items?.some((i) => !i.problem)} onClick={() => void run()}>
            {t("import.run")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
