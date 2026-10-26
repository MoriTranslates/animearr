import { useState } from "react";
import { api } from "./api";
import { t } from "./i18n";
import { Chip, Confirm, ErrorBox, Spinner, useLoad, useToast } from "./ui";

interface ShowCut { tvdbId: number; title: string; path: string; entries: number; sonarrEpisodes: number; animearrEpisodes: number; files: number; filesCovered: number; blockers: string[]; warnings: string[]; adopted: boolean }
interface MovieCut { movieId: number; title: string; year: number | null; anilistId: number | null; hasFile: boolean; blockers: string[]; adopted: boolean }
interface Plan {
  shows: ShowCut[];
  movies: MovieCut[];
  checklist: { item: string; ok: boolean; detail: string }[];
  summary: { shows: number; ready: number; adopted: number; movies: number; moviesReady: number; moviesAdopted: number };
  allowArrWrites: boolean;
}

/** Settings → Cutover: move anime from Sonarr/Radarr to AnimeArr (adopt first; removing there is separate). */
export function Cutover() {
  const toast = useToast();
  const d = useLoad(() => api<Plan>("/cutover"), []);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [msel, setMsel] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<"all" | "ready" | "blocked" | "adopted">("all");
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={t("app.loading")} />;
  const p = d.data;
  const shown = p.shows.filter((s) => (filter === "ready" ? !s.blockers.length && !s.adopted : filter === "blocked" ? s.blockers.length > 0 : filter === "adopted" ? s.adopted : true));
  const toggle = (set: Set<number>, fn: (s: Set<number>) => void, id: number) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    fn(n);
  };
  const run = async (path: string, body: unknown, done: (r: unknown) => string) => {
    setBusy(true);
    try {
      const r = await api(path, { body });
      toast(done(r));
      setSel(new Set());
      setMsel(new Set());
      await d.reload();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <div className="card pad stack">
        <h2>{t("cut.title")}</h2>
        <p className="muted small">{t("cut.help")}</p>
        <p className="small">{t("cut.summary", { ...p.summary })}</p>
        <ul className="small">
          {p.checklist.map((c) => (
            <li key={c.item}>
              <Chip tone={c.ok ? "good" : "warn"}>{c.ok ? "✓" : "!"}</Chip> <strong>{c.item}</strong> — <span className="muted">{c.detail}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="card pad stack">
        <div className="row between">
          <h2>{t("cut.shows")}</h2>
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} aria-label={t("cut.filter")}>
            {(["all", "ready", "blocked", "adopted"] as const).map((f) => (
              <option key={f} value={f}>
                {t(`cut.filter.${f}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <button className="small" onClick={() => setSel(new Set(shown.filter((s) => !s.blockers.length && !s.adopted).map((s) => s.tvdbId)))}>
            {t("cut.selectReady")}
          </button>
          <button className="primary small" disabled={busy || !sel.size} onClick={() => run("/cutover/adopt", { tvdbIds: [...sel] }, (r) => t("cut.adopted", { n: (r as { shows: { ok: boolean }[] }).shows.filter((x) => x.ok).length }))}>
            {t("cut.adopt", { n: sel.size })}
          </button>
          <button className="small" disabled={busy || !p.allowArrWrites || !(sel.size + msel.size)} onClick={() => setAsk(true)} title={p.allowArrWrites ? "" : t("cut.writesOff")}>
            {t("cut.remove", { n: sel.size + msel.size })}
          </button>
        </div>
        {!p.allowArrWrites && <p className="muted small">{t("cut.writesOff")}</p>}
        <ul className="rename-list small">
          {shown.map((s) => (
            <li key={s.tvdbId}>
              <label className="row">
                <input type="checkbox" checked={sel.has(s.tvdbId)} disabled={s.blockers.length > 0} onChange={() => toggle(sel, setSel, s.tvdbId)} />
                <span className="stack">
                  <span>
                    <strong>{s.title}</strong> {s.adopted ? <Chip tone="good">{t("cut.isAdopted")}</Chip> : s.blockers.length ? <Chip tone="warn">{t("cut.blocked")}</Chip> : <Chip tone="info">{t("cut.ready")}</Chip>}
                  </span>
                  <span className="muted">{t("cut.counts", { sonarr: s.sonarrEpisodes, ours: s.animearrEpisodes, covered: s.filesCovered, files: s.files })}</span>
                  {[...s.blockers, ...s.warnings].map((b) => (
                    <span key={b} className="warn-text">
                      {b}
                    </span>
                  ))}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      <div className="card pad stack">
        <h2>{t("cut.movies")}</h2>
        <div className="row">
          <button className="small" onClick={() => setMsel(new Set(p.movies.filter((m) => !m.blockers.length && !m.adopted).map((m) => m.movieId)))}>
            {t("cut.selectReady")}
          </button>
          <button className="primary small" disabled={busy || !msel.size} onClick={() => run("/cutover/adopt", { movieIds: [...msel] }, (r) => t("cut.adopted", { n: (r as { movies: { ok: boolean }[] }).movies.filter((x) => x.ok).length }))}>
            {t("cut.adopt", { n: msel.size })}
          </button>
        </div>
        <ul className="rename-list small">
          {p.movies.map((m) => (
            <li key={m.movieId}>
              <label className="row">
                <input type="checkbox" checked={msel.has(m.movieId)} disabled={m.blockers.length > 0} onChange={() => toggle(msel, setMsel, m.movieId)} />
                <span>
                  {m.title} {m.year ? `(${m.year})` : ""} {m.adopted ? <Chip tone="good">{t("cut.isAdopted")}</Chip> : m.blockers.length ? <Chip tone="warn">{m.blockers[0]}</Chip> : <Chip tone="info">{t("cut.ready")}</Chip>}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>
      {ask && (
        <Confirm danger title={t("cut.removeTitle")} confirmLabel={t("cut.removeConfirm")} onClose={() => setAsk(false)} onConfirm={async () => (setAsk(false), await run("/cutover/remove", { tvdbIds: [...sel], movieIds: [...msel] }, (r) => t("cut.removed", { n: (r as { results: { ok: boolean }[] }).results.filter((x) => x.ok).length })))}>
          <p>{t("cut.removeBody")}</p>
        </Confirm>
      )}
    </div>
  );
}
