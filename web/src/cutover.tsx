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
  builtAt?: number;
}

/** Settings → Cutover: move anime from Sonarr/Radarr to AnimeArr (adopt first; the switch is separate). */
export function Cutover() {
  const toast = useToast();
  // The plan takes a while on a big library: built when asked, then cached on the server.
  const [build, setBuild] = useState<"cached" | "build" | "fresh">("cached");
  const d = useLoad(() => api<Plan | { built: false }>(`/cutover${build === "cached" ? "?cached=1" : build === "fresh" ? "?fresh=1" : ""}`), [build]);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [msel, setMsel] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<"all" | "ready" | "blocked" | "adopted">("all");
  const [specials, setSpecials] = useState(false);
  const [ask, setAsk] = useState<null | { shows: ShowCut[]; movies: MovieCut[] }>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState<null | { kind: "show" | "movie"; id: number; title: string }>(null);
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={build === "cached" ? t("app.loading") : t("cut.building")} />;
  if ("built" in d.data && d.data.built === false)
    return (
      <div className="card pad stack">
        <p>{t("cut.buildIntro")}</p>
        <button className="primary self-start" onClick={() => setBuild("build")}>
          {t("cut.build")}
        </button>
      </div>
    );
  const p = d.data as Plan;
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
                  {!s.adopted && (
                    <span className="row">
                      {s.blockers.some((b) => /no AniList entry|numbering/.test(b)) && (
                        <button className="small" onClick={(e) => (e.preventDefault(), setPicking({ kind: "show", id: s.tvdbId, title: s.title }))}>
                          {t("cut.pickShow")}
                        </button>
                      )}
                      {s.blockers.some((b) => /special/.test(b)) && (
                        <button className="small" onClick={(e) => (e.preventDefault(), void run("/cutover/ack-specials", { tvdbId: s.tvdbId }, () => t("cut.acked")))}>
                          {t("cut.ackSpecials")}
                        </button>
                      )}
                    </span>
                  )}
                  {picking?.kind === "show" && picking.id === s.tvdbId && (
                    <AniPicker
                      initial={s.title}
                      movie={false}
                      onClose={() => setPicking(null)}
                      onPick={async (anilistId, season, offset) => {
                        setPicking(null);
                        await run("/cutover/match-show", { tvdbId: s.tvdbId, anilistId, season, offset }, () => t("cut.matched"));
                      }}
                    />
                  )}
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
        <p className="muted small">{t("cut.matchHelp")}</p>
        <div className="row">
          <button className="small" disabled={busy} onClick={() => void run("/cutover/match-movies", {}, () => t("cut.matching"))}>
            {t("cut.matchMovies")}
          </button>
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
                  {!m.adopted && m.blockers.some((b) => /AniList/.test(b)) && (
                    <button className="small self-start" onClick={(e) => (e.preventDefault(), setPicking({ kind: "movie", id: m.movieId, title: m.title }))}>
                      {t("cut.pickMovie")}
                    </button>
                  )}
                  {picking?.kind === "movie" && picking.id === m.movieId && (
                    <AniPicker
                      initial={m.title}
                      movie
                      onClose={() => setPicking(null)}
                      onPick={async (anilistId) => {
                        setPicking(null);
                        await run("/cutover/match-movie", { movieId: m.movieId, anilistId }, () => t("cut.matched"));
                      }}
                    />
                  )}
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

interface Hit { anilistId: number; title: string; romaji: string | null; kind: string | null; year: number | null; episodes: number | null }

/** A small AniList picker (search, pick one), for matching a blocked show or movie by hand. */
function AniPicker({ initial, movie, onPick, onClose }: { initial: string; movie: boolean; onPick: (anilistId: number, season: number, offset: number) => Promise<void>; onClose: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState(initial);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [season, setSeason] = useState(1);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const search = async () => {
    setBusy(true);
    try {
      const r = await api<{ results: Hit[]; anilist: string }>(`/add/search?q=${encodeURIComponent(q)}`);
      if (r.anilist === "busy" || r.anilist === "error") toast(t("add.busy"), true);
      setHits(r.results.filter((h) => (movie ? h.kind === "MOVIE" : h.kind !== "MOVIE")));
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  // Inside a row's <label>: keep clicks here from ticking the row's checkbox.
  return (
    <div className="card pad stack" onClick={(e) => e.preventDefault()}>
      <div className="row">
        <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void search()} aria-label={t("cut.pickSearch")} className="grow" />
        <button className="small" disabled={busy} onClick={() => void search()}>
          {t("cut.pickSearch")}
        </button>
        {!movie && (
          <span className="row small">
            {t("cut.season")}
            <input type="number" min={1} max={99} value={season} onChange={(e) => setSeason(Number(e.target.value) || 1)} style={{ width: 60 }} aria-label={t("cut.season")} />
            {t("cut.offset")}
            <input type="number" min={0} max={5000} value={offset} onChange={(e) => setOffset(Math.max(0, Number(e.target.value) || 0))} style={{ width: 70 }} aria-label={t("cut.offset")} />
          </span>
        )}
        <button className="small ghost" onClick={onClose}>
          {t("common.cancel")}
        </button>
      </div>
      {hits && !hits.length && <p className="muted small">{t("add.none")}</p>}
      <ul className="small">
        {hits?.slice(0, 10).map((h) => (
          <li key={h.anilistId} className="row">
            <button className="small" disabled={busy} onClick={async () => (setBusy(true), await onPick(h.anilistId, season, offset).finally(() => setBusy(false)))}>
              {t("cut.pick")}
            </button>
            <span>
              {h.title} {h.romaji && h.romaji !== h.title ? <span className="muted">({h.romaji})</span> : null} · {h.kind} · {h.year ?? "?"}
              {h.episodes ? ` · ${h.episodes} eps` : ""} · <a href={`https://anilist.co/anime/${h.anilistId}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>AniList ↗</a>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
