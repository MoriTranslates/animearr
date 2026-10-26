import { useEffect, useMemo, useState } from "react";
import { api, store, type Settings as S } from "../api";
import { Link, navigate } from "../App";
import { t, type I18nKey } from "../i18n";
import { SIZE_PRESETS, type LanguageProfile, type SizePreset } from "../profiles";
import { ScopeFields, type Scope } from "../scope";
import { Chip, Confirm, Cover, Empty, ErrorBox, Modal, Spinner, useLoad, usePageTitle, useToast } from "../ui";

interface AddResult {
  anilistId: number;
  title: string;
  romaji: string | null;
  native: string | null;
  kind: string | null;
  year: number | null;
  episodes: number | null;
  status: string | null;
  cover: string | null;
  country: string | null;
  tvdbId: number | null;
  inLibrary: { kind: "series" | "movie"; tvdbId?: number; movieId?: number; native: boolean } | null;
  matchedBy: string;
}

const KIND: Record<string, string> = { TV: "TV", TV_SHORT: "TV short", ONA: "ONA", OVA: "OVA", SPECIAL: "Special", MOVIE: "Movie", MUSIC: "Music" };

interface LibHit { kind: "show" | "movie"; id: number; title: string; cover: string | null; year?: number | null }

const RECENT_KEY = "recentSearches";
const recent = (): string[] => store.get<string[]>(RECENT_KEY, []);
const remember = (q: string) => store.set(RECENT_KEY, [q, ...recent().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 8));

/**
 * One search for everything: what's already in your library (shows and movies), what you can add from AniList, and
 * release searches for a library show. (Add and Release search keep their own routes.)
 */
export function Add() {
  usePageTitle(t("find.title"));
  const [q, setQ] = useState(new URLSearchParams(location.search).get("q") ?? "");
  const [debounced, setDebounced] = useState(q);
  const [pick, setPick] = useState<AddResult | null>(null);
  useEffect(() => {
    const h = setTimeout(() => setDebounced(q.trim()), 450);
    return () => clearTimeout(h);
  }, [q]);
  useEffect(() => {
    if (debounced.length < 2) return;
    const h = setTimeout(() => remember(debounced), 1500);
    history.replaceState(null, "", `${location.pathname}?q=${encodeURIComponent(debounced)}`);
    return () => clearTimeout(h);
  }, [debounced]);
  const d = useLoad(() => (debounced.length >= 2 ? api<{ results: AddResult[]; anilist: string }>(`/add/search?q=${encodeURIComponent(debounced)}`) : Promise.resolve({ results: [] as AddResult[], anilist: "ok" })), [debounced]);
  // The library, loaded once when you start typing (then filtered locally).
  const started = debounced.length >= 2;
  const lib = useLoad(
    () =>
      started
        ? Promise.all([api<{ series: { tvdbId: number; title: string; cover: string | null }[] }>("/library/candidates"), api<{ id: number; title: string; year: number | null; cover: string | null }[]>("/movies")]).then(([sh, mv]) => [
            ...sh.series.map((x) => ({ kind: "show" as const, id: x.tvdbId, title: x.title, cover: x.cover })),
            ...mv.map((x) => ({ kind: "movie" as const, id: x.id, title: x.title, cover: x.cover, year: x.year })),
          ] as LibHit[])
        : Promise.resolve(null),
    [started],
  );
  const hits = useMemo(() => {
    if (!started) return [] as LibHit[];
    const ql = debounced.toLowerCase();
    const byTitle = (lib.data ?? []).filter((x) => x.title.toLowerCase().includes(ql));
    // AniList knows the alternative titles: its in-library matches count too (romaji, synonyms).
    const viaAnilist = (d.data?.results ?? [])
      .filter((r) => r.inLibrary)
      .map((r) => {
        const kind = r.inLibrary!.tvdbId ? ("show" as const) : ("movie" as const);
        const id = r.inLibrary!.tvdbId ?? r.inLibrary!.movieId!;
        const own = (lib.data ?? []).find((x) => x.kind === kind && x.id === id);
        return own ?? { kind, id, title: r.title, cover: r.cover, year: r.year };
      });
    const seen = new Set<string>();
    return [...viaAnilist, ...byTitle].filter((x) => (seen.has(`${x.kind}${x.id}`) ? false : (seen.add(`${x.kind}${x.id}`), true)));
  }, [started, debounced, lib.data, d.data]);
  const adds = (d.data?.results ?? []).filter((r) => !r.inLibrary);
  return (
    <section className="stack">
      <h1>{t("find.title")}</h1>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("find.placeholder")} aria-label={t("find.title")} autoFocus className="add-search" />
      {debounced.length < 2 && (
        <div className="stack">
          {!!recent().length && (
            <>
              <h2 className="eyebrow">{t("find.recent")}</h2>
              <div className="chips">
                {recent().map((r) => (
                  <button key={r} className="chip link" onClick={() => setQ(r)}>
                    {r}
                  </button>
                ))}
              </div>
            </>
          )}
          <h2 className="eyebrow">{t("find.tools")}</h2>
          <div className="tiles">
            <Link to="/search" className="card pad tile link-tile">
              <strong>{t("nav.deepSearch")}</strong>
              <span className="muted small">{t("find.deepHelp")}</span>
            </Link>
            <Link to="/search?tab=identify" className="card pad tile link-tile">
              <strong>{t("nav.identify")}</strong>
              <span className="muted small">{t("find.identifyHelp")}</span>
            </Link>
          </div>
          <p className="muted small">{t("add.help")}</p>
        </div>
      )}
      {debounced.length >= 2 && !!hits.length && (
        <>
          <h2 className="eyebrow">{t("find.inLibrary", { n: hits.length })}</h2>
          <ul className="plain find-hits">
            {hits.slice(0, 8).map((h) => (
              <li key={`${h.kind}${h.id}`} className="card find-hit">
                <Link to={h.kind === "show" ? `/show/${h.id}` : `/movie/${h.id}`} className="card-link grow">
                  <Cover src={h.cover} alt={h.title} size="sm" />
                  <span className="stack">
                    <span className="strong clamp2">{h.title}</span>
                    <span className="muted small">
                      {h.kind === "show" ? t("lib.shows") : t("lib.movies")}
                      {h.year ? ` · ${h.year}` : ""}
                    </span>
                  </span>
                </Link>
                {h.kind === "show" && (
                  <Link to={`/search?tvdbId=${h.id}`} className="button small">
                    {t("find.releases")}
                  </Link>
                )}
              </li>
            ))}
          </ul>
          {hits.length > 8 && (
            <Link to={`/shows`} className="small">
              {t("find.moreInLibrary", { n: hits.length - 8 })}
            </Link>
          )}
        </>
      )}
      {d.error && <ErrorBox error={d.error} retry={d.reload} />}
      {debounced.length >= 2 && !d.data && !d.error && <Spinner label={t("app.loading")} />}
      {d.data && (d.data.anilist === "busy" || d.data.anilist === "error") && <p className="banner warn">{t(d.data.anilist === "busy" ? "add.busy" : "add.aniError")}</p>}
      {d.data && debounced.length >= 2 && !adds.length && !hits.length && d.data.anilist !== "busy" && <Empty icon="⌕">{t("add.none")}</Empty>}
      {!!adds.length && <h2 className="eyebrow">{t("find.addFromAnilist", { n: adds.length })}</h2>}
      <div className="poster-grid">
        {adds.map((r) => (
          <article key={r.anilistId} className="poster-card">
            <button className="poster-select ghost" onClick={() => setPick(r)} aria-label={t("add.addThis", { title: r.title })}>
              <Cover src={r.cover} alt={r.title} size="lg" />
            </button>
            <div className="poster-body">
              <span className="poster-title clamp2">{r.title}</span>
              {r.romaji && r.romaji !== r.title && <span className="muted small clamp2">{r.romaji}</span>}
              <span className="muted small">
                {[KIND[r.kind ?? ""] ?? r.kind ?? "?", r.year, r.episodes && r.kind !== "MOVIE" ? t("add.eps", { n: r.episodes }) : null, r.country && r.country !== "JP" ? r.country : null].filter(Boolean).join(" · ")}
              </span>
              <button className="small" onClick={() => setPick(r)}>
                + {t("add.add")}
              </button>
            </div>
          </article>
        ))}
      </div>
      {pick && <AddSheet r={pick} onClose={() => setPick(null)} />}
    </section>
  );
}

/** The add sheet: root folder, profile, size, monitoring, and what happens next. Defaults from the settings. */
function AddSheet({ r, onClose }: { r: AddResult; onClose: () => void }) {
  const toast = useToast();
  const s = useLoad(() => api<S>("/settings"), []);
  const profiles = useLoad(() => api<{ profiles: LanguageProfile[]; defaultProfileId: string }>("/profiles"), []);
  const [root, setRoot] = useState("");
  const [profileId, setProfileId] = useState("");
  const [size, setSize] = useState<SizePreset | "">("");
  const [scope, setScope] = useState<Scope | null>(null);
  const [then, setThen] = useState<"search" | "queue" | "none">("search");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!s.data) return;
    const isMovie = r.kind === "MOVIE";
    setRoot((x) => x || s.data!.allowedRoots.find((a) => /movies/i.test(a) === isMovie) || s.data!.allowedRoots[0] || "");
    setScope((x) => x ?? (r.status === "FINISHED" ? s.data!.scope.ended : s.data!.scope.continuing));
  }, [s.data, r.status, r.kind]);
  const movie = r.kind === "MOVIE";
  return (
    <Modal title={t("add.sheetTitle", { title: r.title })} onClose={onClose}>
      {(!s.data || !profiles.data) && <Spinner label={t("app.loading")} />}
      {s.data && profiles.data && (
        <div className="stack">
          <div className="row">
            <Cover src={r.cover} alt={r.title} size="md" />
            <div className="stack small">
              <strong>{r.title}</strong>
              {r.native && <span className="muted">{r.native}</span>}
              <span className="muted">
                {KIND[r.kind ?? ""] ?? r.kind} · {r.year ?? "?"}
                {r.episodes && !movie ? ` · ${t("add.eps", { n: r.episodes })}` : ""}
              </span>
              <span className="muted">{r.tvdbId ? t("add.tvdbMapped", { id: r.tvdbId }) : t("add.noTvdb")}</span>
            </div>
          </div>
          {(
            <div className="form">
              <label>
                {t("add.root")}
                <select value={root} onChange={(e) => setRoot(e.target.value)}>
                  {s.data.allowedRoots.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("profiles.profile")}
                <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                  <option value="">{t("profiles.followDefault")}</option>
                  {profiles.data.profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              {!movie && (
              <label>
                {t("size.preset")}
                <select value={size} onChange={(e) => setSize(e.target.value as SizePreset | "")}>
                  <option value="">{t("size.profileDefault")}</option>
                  {SIZE_PRESETS.map((x) => (
                    <option key={x} value={x}>
                      {t(`size.${x}` as I18nKey)}
                    </option>
                  ))}
                </select>
              </label>
              )}
              {scope && !movie && <ScopeFields value={scope} onChange={setScope} />}
              <fieldset className="stack">
                <legend>{t("add.then")}</legend>
                {(movie ? (["search", "none"] as const) : (["search", "queue", "none"] as const)).map((x) => (
                  <label key={x} className="row small">
                    <input type="radio" name="then" checked={then === x} onChange={() => setThen(x)} />
                    {t(`add.then.${movie && x !== "queue" ? `movie.${x}` : x}` as I18nKey)}
                  </label>
                ))}
              </fieldset>
            </div>
          )}
          <div className="row">
            <button onClick={onClose}>{t("common.cancel")}</button>
            {(
              <button
                className="primary"
                disabled={busy || !root}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const res = await api<{ tvdbId?: number; movieId?: number; title: string; path: string }>("/add", { body: { anilistId: r.anilistId, rootFolder: root, kind: movie ? "movie" : "show", profileId: profileId || null, sizePreset: movie ? null : size || null, scope: movie ? null : scope, then } });
                    toast(t("add.added", { title: res.title, path: res.path }));
                    navigate(res.movieId ? `/movie/${res.movieId}` : `/show/${res.tvdbId}`);
                  } catch (e) {
                    toast((e as Error).message, true);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {then === "search" ? "⚡ " : ""}
                {t(movie ? "add.confirmMovie" : "add.confirm")}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Show page, shows added in AnimeArr: remove from AnimeArr (files stay on disk). */
export function RemoveNative({ tvdbId, movieId, title, asked, onClose }: { tvdbId?: number; movieId?: number; title: string; asked?: boolean; onClose?: () => void }) {
  const toast = useToast();
  const [askState, setAsk] = useState(false);
  const ask = asked ?? askState;
  return (
    <>
      {asked === undefined && (
        <button className="small ghost" onClick={() => setAsk(true)}>
          {t("add.remove")}
        </button>
      )}
      {ask && (
        <Confirm
          danger
          title={t("add.removeTitle", { title })}
          confirmLabel={t("add.remove")}
          onClose={() => (setAsk(false), onClose?.())}
          onConfirm={async () => {
            try {
              await api(movieId ? `/add/movie/${movieId}` : `/add/${tvdbId}`, { method: "DELETE" });
              navigate(movieId ? "/movies" : "/shows");
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          <p>{t(movieId ? "add.removeMovieBody" : "add.removeBody")}</p>
        </Confirm>
      )}
    </>
  );
}
