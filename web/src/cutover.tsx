import { useState } from "react";
import { api } from "./api";
import { t, type I18nKey } from "./i18n";
import { Chip, Confirm, ErrorBox, Spinner, Toggle, useLoad, useToast } from "./ui";

interface ShowCut { tvdbId: number; title: string; path: string; entries: number; sonarrEpisodes: number; animearrEpisodes: number; files: number; filesCovered: number; filesScanned: number; blockers: string[]; warnings: string[]; adopted: boolean }
interface MovieCut { movieId: number; title: string; year: number | null; anilistId: number | null; hasFile: boolean; blockers: string[]; warnings: string[]; adopted: boolean }
interface Plan {
  shows: ShowCut[];
  movies: MovieCut[];
  checklist: { item: string; ok: boolean; detail: string }[];
  summary: { shows: number; ready: number; adopted: number; movies: number; moviesReady: number; moviesAdopted: number };
  allowArrWrites: boolean;
}

/** Settings → Cutover: move anime from Sonarr/Radarr to AnimeArr (adopt first; the switch is separate). */
export function Cutover() {
  const toast = useToast();
  const d = useLoad(() => api<Plan>("/cutover"), []);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [msel, setMsel] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<"all" | "ready" | "blocked" | "adopted">("all");
  const [specials, setSpecials] = useState(false);
  const [ask, setAsk] = useState<null | { shows: ShowCut[]; movies: MovieCut[] }>(null);
  const [busy, setBusy] = useState(false);
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={t("app.loading")} />;
  const p = d.data;
  const shown = p.shows.filter((s) => (filter === "ready" ? !s.blockers.length && !s.adopted : filter === "blocked" ? s.blockers.length > 0 : filter === "adopted" ? s.adopted : true));
  const selShows = p.shows.filter((s) => sel.has(s.tvdbId));
  const selMovies = p.movies.filter((m) => msel.has(m.movieId));
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
  const canAdoptShows = selShows.length > 0 && selShows.every((s) => !s.adopted);
  const canSwitch = (list: { adopted: boolean }[]) => p.allowArrWrites && list.length > 0 && list.every((x) => x.adopted);
  const results = (r: unknown) => {
    const list = ((r as { results?: { ok: boolean; why: string }[] }).results ?? []) as { ok: boolean; why: string }[];
    const bad = list.filter((x) => !x.ok);
    return `${t("cut.switched", { n: list.length - bad.length })}${bad.length ? ` · ${bad.slice(0, 2).map((x) => x.why).join("; ")}` : ""}`;
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
        {!p.allowArrWrites && <p className="muted small">{t("cut.writesOff")}</p>}
        <Toggle checked={specials} onChange={setSpecials} label={t("cut.acceptSpecials")} />
      </div>

      <div className="card pad stack">
        <div className="row between">
          <h2>{t("cut.shows")}</h2>
          <select value={filter} onChange={(e) => (setFilter(e.target.value as typeof filter), setSel(new Set()))} aria-label={t("cut.filter")}>
            {(["all", "ready", "blocked", "adopted"] as const).map((f) => (
              <option key={f} value={f}>
                {t(`cut.filter.${f}` as I18nKey)}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <button className="small" disabled={busy} onClick={() => setSel(new Set(shown.filter((s) => !s.blockers.length && !s.adopted).map((s) => s.tvdbId)))}>
            {t("cut.selectReady")}
          </button>
          <button className="small" disabled={busy} onClick={() => setSel(new Set(shown.filter((s) => s.adopted).map((s) => s.tvdbId)))}>
            {t("cut.selectAdopted")}
          </button>
          <button className="primary small" disabled={busy || !canAdoptShows} onClick={() => run("/cutover/adopt", { tvdbIds: [...sel], acceptSpecials: specials }, (r) => t("cut.adopted", { n: (r as { shows: { ok: boolean }[] }).shows.filter((x) => x.ok).length }))}>
            {t("cut.adopt", { n: sel.size })}
          </button>
          <button className="small" disabled={busy || !canSwitch(selShows)} onClick={() => setAsk({ shows: selShows, movies: [] })}>
            {t("cut.remove", { n: sel.size })}
          </button>
        </div>
        <ul className="rename-list small">
          {shown.map((s) => (
            <li key={s.tvdbId}>
              <label className="row">
                <input type="checkbox" checked={sel.has(s.tvdbId)} disabled={!s.adopted && s.blockers.length > 0} onChange={() => toggle(sel, setSel, s.tvdbId)} />
                <span className="stack">
                  <span>
                    <strong>{s.title}</strong> {s.adopted ? <Chip tone="good">{t("cut.isAdopted")}</Chip> : s.blockers.length ? <Chip tone="warn">{t("cut.blocked")}</Chip> : <Chip tone="info">{t("cut.ready")}</Chip>}
                  </span>
                  <span className="muted">{t("cut.counts", { sonarr: s.sonarrEpisodes, ours: s.animearrEpisodes, covered: s.filesCovered, files: s.files, scanned: s.filesScanned })}</span>
                  {s.blockers.map((b) => (
                    <span key={b} className="warn-text">
                      {b}
                    </span>
                  ))}
                  {s.warnings.map((b) => (
                    <span key={b} className="muted">
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
          <button className="small" disabled={busy} onClick={() => setMsel(new Set(p.movies.filter((m) => !m.blockers.length && !m.adopted).map((m) => m.movieId)))}>
            {t("cut.selectReady")}
          </button>
          <button className="small" disabled={busy} onClick={() => setMsel(new Set(p.movies.filter((m) => m.adopted).map((m) => m.movieId)))}>
            {t("cut.selectAdopted")}
          </button>
          <button className="primary small" disabled={busy || !selMovies.length || selMovies.some((m) => m.adopted)} onClick={() => run("/cutover/adopt", { movieIds: [...msel] }, (r) => t("cut.adopted", { n: (r as { movies: { ok: boolean }[] }).movies.filter((x) => x.ok).length }))}>
            {t("cut.adopt", { n: msel.size })}
          </button>
          <button className="small" disabled={busy || !canSwitch(selMovies)} onClick={() => setAsk({ shows: [], movies: selMovies })}>
            {t("cut.removeMovies", { n: msel.size })}
          </button>
        </div>
        <ul className="rename-list small">
          {p.movies.map((m) => (
            <li key={m.movieId}>
              <label className="row">
                <input type="checkbox" checked={msel.has(m.movieId)} disabled={!m.adopted && m.blockers.length > 0} onChange={() => toggle(msel, setMsel, m.movieId)} />
                <span className="stack">
                  <span>
                    {m.title} {m.year ? `(${m.year})` : ""} {m.adopted ? <Chip tone="good">{t("cut.isAdopted")}</Chip> : m.blockers.length ? <Chip tone="warn">{t("cut.blocked")}</Chip> : <Chip tone="info">{t("cut.ready")}</Chip>}
                  </span>
                  {[...m.blockers, ...m.warnings].map((b) => (
                    <span key={b} className="muted">
                      {b}
                    </span>
                  ))}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>
      {ask && (
        <Confirm
          danger
          title={t("cut.removeTitle")}
          confirmLabel={t("cut.removeConfirm")}
          onClose={() => setAsk(null)}
          onConfirm={async () => {
            const a = ask;
            setAsk(null);
            await run("/cutover/remove", { tvdbIds: a.shows.map((s) => s.tvdbId), movieIds: a.movies.map((m) => m.movieId), acceptSpecials: specials }, results);
          }}
        >
          <p>{t("cut.removeBody")}</p>
          <ul className="small">
            {[...ask.shows.map((s) => s.title), ...ask.movies.map((m) => m.title)].slice(0, 12).map((x) => (
              <li key={x}>{x}</li>
            ))}
            {ask.shows.length + ask.movies.length > 12 && <li>{t("cut.andMore", { n: ask.shows.length + ask.movies.length - 12 })}</li>}
          </ul>
        </Confirm>
      )}
    </div>
  );
}
