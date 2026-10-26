import { useEffect, useState } from "react";
import { api, type Settings as S } from "../api";
import { Link, navigate } from "../App";
import { t, type I18nKey } from "../i18n";
import { SIZE_PRESETS, type LanguageProfile, type SizePreset } from "../profiles";
import { ScopeFields, type Scope } from "../scope";
import { Chip, Confirm, Cover, ErrorBox, Modal, Spinner, useLoad, usePageTitle, useToast } from "../ui";

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

/** Add: one search box for shows and movies (AniList titles in every language, synonyms, abbreviations). */
export function Add() {
  usePageTitle(t("add.title"));
  const [q, setQ] = useState(new URLSearchParams(location.search).get("q") ?? "");
  const [debounced, setDebounced] = useState(q);
  const [pick, setPick] = useState<AddResult | null>(null);
  useEffect(() => {
    const h = setTimeout(() => setDebounced(q.trim()), 450);
    return () => clearTimeout(h);
  }, [q]);
  const d = useLoad(() => (debounced.length >= 2 ? api<{ results: AddResult[]; anilist: string }>(`/add/search?q=${encodeURIComponent(debounced)}`) : Promise.resolve({ results: [] as AddResult[], anilist: "ok" })), [debounced]);
  return (
    <section className="stack">
      <h1>{t("add.title")}</h1>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("add.placeholder")} aria-label={t("add.title")} autoFocus className="add-search" />
      <p className="muted small">{t("add.help")}</p>
      {d.error && <ErrorBox error={d.error} retry={d.reload} />}
      {debounced.length >= 2 && !d.data && !d.error && <Spinner label={t("app.loading")} />}
      {d.data && (d.data.anilist === "busy" || d.data.anilist === "error") && <p className="banner warn">{t(d.data.anilist === "busy" ? "add.busy" : "add.aniError")}</p>}
      {d.data && debounced.length >= 2 && !d.data.results.length && d.data.anilist !== "busy" && <p className="muted">{t("add.none")}</p>}
      <div className="poster-grid">
        {d.data?.results.map((r) => (
          <article key={r.anilistId} className="poster-card">
            <button className="poster-select ghost" onClick={() => (r.inLibrary?.tvdbId ? navigate(`/show/${r.inLibrary.tvdbId}`) : r.inLibrary?.movieId ? navigate(`/movie/${r.inLibrary.movieId}`) : setPick(r))} aria-label={r.inLibrary ? t("add.open") : t("add.addThis", { title: r.title })}>
              <Cover src={r.cover} alt={r.title} size="lg" />
            </button>
            <div className="poster-body">
              <span className="poster-title clamp2">{r.title}</span>
              {r.romaji && r.romaji !== r.title && <span className="muted small clamp2">{r.romaji}</span>}
              <div className="chips">
                <Chip tone={r.kind === "MOVIE" ? "accent" : "info"}>{KIND[r.kind ?? ""] ?? r.kind ?? "?"}</Chip>
                {r.year && <Chip>{r.year}</Chip>}
                {r.episodes && r.kind !== "MOVIE" && <Chip>{t("add.eps", { n: r.episodes })}</Chip>}
                {r.country && r.country !== "JP" && <Chip>{r.country}</Chip>}
                {r.inLibrary && <Chip tone="good">{t("add.inLibrary")}</Chip>}
              </div>
              {r.inLibrary?.tvdbId ? (
                <Link to={`/show/${r.inLibrary.tvdbId}`} className="small">
                  {t("add.open")}
                </Link>
              ) : r.inLibrary?.movieId ? (
                <Link to={`/movie/${r.inLibrary.movieId}`} className="small">
                  {t("add.open")}
                </Link>
              ) : (
                <button className="small" onClick={() => setPick(r)}>
                  + {t("add.add")}
                </button>
              )}
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
    setRoot((x) => x || s.data!.allowedRoots.find((a) => !/movies/i.test(a)) || s.data!.allowedRoots[0] || "");
    setScope((x) => x ?? (r.status === "FINISHED" ? s.data!.scope.ended : s.data!.scope.continuing));
  }, [s.data, r.status]);
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
          {movie ? (
            <p className="banner warn">{t("add.movieLater")}</p>
          ) : (
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
              {scope && <ScopeFields value={scope} onChange={setScope} />}
              <fieldset className="stack">
                <legend>{t("add.then")}</legend>
                {(["search", "queue", "none"] as const).map((x) => (
                  <label key={x} className="row small">
                    <input type="radio" name="then" checked={then === x} onChange={() => setThen(x)} />
                    {t(`add.then.${x}` as I18nKey)}
                  </label>
                ))}
              </fieldset>
            </div>
          )}
          <div className="row">
            <button onClick={onClose}>{t("common.cancel")}</button>
            {!movie && (
              <button
                className="primary"
                disabled={busy || !root}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const res = await api<{ tvdbId: number; title: string; path: string }>("/add", { body: { anilistId: r.anilistId, rootFolder: root, profileId: profileId || null, sizePreset: size || null, scope, then } });
                    toast(t("add.added", { title: res.title, path: res.path }));
                    navigate(`/show/${res.tvdbId}`);
                  } catch (e) {
                    toast((e as Error).message, true);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {then === "search" ? "⚡ " : ""}
                {t("add.confirm")}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Show page, shows added in AnimeArr: remove from AnimeArr (files stay on disk). */
export function RemoveNative({ tvdbId, title }: { tvdbId: number; title: string }) {
  const toast = useToast();
  const [ask, setAsk] = useState(false);
  return (
    <>
      <button className="small ghost" onClick={() => setAsk(true)}>
        {t("add.remove")}
      </button>
      {ask && (
        <Confirm
          danger
          title={t("add.removeTitle", { title })}
          confirmLabel={t("add.remove")}
          onClose={() => setAsk(false)}
          onConfirm={async () => {
            try {
              await api(`/add/${tvdbId}`, { method: "DELETE" });
              navigate("/shows");
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          <p>{t("add.removeBody")}</p>
        </Confirm>
      )}
    </>
  );
}
