/**
 * Show page → a season's menu → "Episode info source…": which TMDB show/season/offset that season's episode descriptions and
 * thumbnails come from (the media-server files only). Search TMDB, pick, check the first titles line up, save or reset.
 */
import { useEffect, useState } from "react";
import { api } from "./api";
import { t } from "./i18n";
import { Modal, Spinner, useToast } from "./ui";

interface Source { tmdbTv: number; tmdbSeason: number; tmdbOffset: number }
interface Current { override: (Source & { setAt: number }) | null; catalog: Source | null }
interface Hit { id: number; name: string; year: number | null; seasons: { season: number; episodes: number }[] | null }
interface Titles { seasons: Hit["seasons"]; titles: { episode: number; name: string }[] | null }

export function MetaSource({ tvdbId, season, episodes, onClose }: { tvdbId: number; season: number; episodes: { episode: number; title: string | null }[]; onClose: () => void }) {
  const toast = useToast();
  const base = `/series/${tvdbId}/meta-override/${season}`;
  const [cur, setCur] = useState<Current | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [pick, setPick] = useState<Hit | null>(null);
  const [tmSeason, setTmSeason] = useState("");
  const [offset, setOffset] = useState("0");
  const [titles, setTitles] = useState<Titles["titles"]>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const fail = (e: unknown) => setError((e as Error).message);

  useEffect(() => {
    api<Current>(base).then(setCur, fail);
  }, [base]);
  // The picked season's episode titles, for the side-by-side check.
  useEffect(() => {
    setTitles(null);
    if (!pick || tmSeason === "") return;
    let live = true;
    api<Titles>(`/tmdb/tv/${pick.id}?season=${Number(tmSeason)}`).then(
      (r) => live && setTitles(r.titles ?? []),
      () => live && setTitles([]),
    );
    return () => {
      live = false;
    };
  }, [pick, tmSeason]);

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await f();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const choose = (h: Hit) =>
    run(async () => {
      const seasons = h.seasons ?? (await api<Titles>(`/tmdb/tv/${h.id}`)).seasons;
      setPick({ ...h, seasons });
      setTmSeason(String(seasons?.find((s) => s.season === season)?.season ?? seasons?.find((s) => s.season > 0)?.season ?? ""));
    });
  const off = Number.isInteger(Number(offset)) ? Number(offset) : 0;
  const ours = [...episodes].sort((a, b) => a.episode - b.episode).slice(0, 3);

  return (
    <Modal title={t("metasrc.title", { n: season })} onClose={onClose}>
      <div className="stack">
        <p className="small muted">{t("metasrc.help")}</p>
        {!cur ? (
          <Spinner label={t("app.loading")} />
        ) : (
          <p>
            <b>{t("metasrc.current")}:</b>{" "}
            {cur.override
              ? t("metasrc.override", { tv: cur.override.tmdbTv, season: cur.override.tmdbSeason, offset: cur.override.tmdbOffset })
              : cur.catalog
                ? t("metasrc.auto", { tv: cur.catalog.tmdbTv, season: cur.catalog.tmdbSeason })
                : t("metasrc.autoNone")}
          </p>
        )}
        {error && <p className="error">{error}</p>}
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) void run(async () => (setPick(null), setHits(await api<Hit[]>(`/tmdb/search?q=${encodeURIComponent(q.trim())}`))));
          }}
        >
          <input className="grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("metasrc.search")} aria-label={t("metasrc.search")} />
          <button disabled={busy || !q.trim()}>{t("common.search")}</button>
        </form>
        {hits && !hits.length && <p className="small muted">{t("metasrc.none")}</p>}
        {hits && !pick && (
          <ul className="stack">
            {hits.map((h) => (
              <li key={h.id}>
                <button className="small ghost" disabled={busy} onClick={() => void choose(h)}>
                  {h.name}
                  {h.year ? ` (${h.year})` : ""} · TMDB {h.id}
                  {h.seasons ? ` · ${t("metasrc.seasonOf", { n: h.seasons.filter((s) => s.season > 0).length })}` : ""}
                </button>
              </li>
            ))}
          </ul>
        )}
        {pick && (
          <div className="stack">
            <p>
              <b>{pick.name}</b> · TMDB {pick.id}{" "}
              <button className="small ghost" onClick={() => setPick(null)}>
                {t("common.cancel")}
              </button>
            </p>
            <div className="row">
              <label>
                {t("metasrc.pickSeason")}
                <select value={tmSeason} onChange={(e) => setTmSeason(e.target.value)}>
                  {(pick.seasons ?? []).map((s) => (
                    <option key={s.season} value={s.season}>
                      {t("metasrc.epCount", { n: s.season, e: s.episodes })}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("metasrc.offset")}
                <input className="narrow" inputMode="numeric" value={offset} onChange={(e) => setOffset(e.target.value)} />
              </label>
            </div>
            <p className="small muted">{t("metasrc.offsetHelp")}</p>
            <p className="small">
              <b>{t("metasrc.preview")}</b>
            </p>
            <table className="small">
              <thead>
                <tr>
                  <th />
                  <th>{t("metasrc.ours")}</th>
                  <th>{t("metasrc.theirs")}</th>
                </tr>
              </thead>
              <tbody>
                {ours.map((e) => (
                  <tr key={e.episode}>
                    <td>{e.episode}</td>
                    <td>{e.title ?? "–"}</td>
                    <td>{titles === null ? "…" : (titles.find((x) => x.episode === e.episode + off)?.name ?? t("metasrc.missing"))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row end">
              <button
                className="primary"
                disabled={busy || tmSeason === ""}
                onClick={() =>
                  void run(async () => {
                    setCur(await api<Current>(base, { method: "PUT", body: { tmdbTv: pick.id, tmdbSeason: Number(tmSeason), tmdbOffset: off } }));
                    setSaved(true);
                    setPick(null);
                    setHits(null);
                    toast(t("metasrc.saved"));
                  })
                }
              >
                {t("common.save")}
              </button>
            </div>
          </div>
        )}
        <div className="row end">
          {cur?.override && (
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setCur(await api<Current>(base, { method: "DELETE" }));
                  setSaved(true);
                  toast(t("metasrc.resetDone"));
                })
              }
            >
              {t("metasrc.reset")}
            </button>
          )}
          {saved && (
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api(`/series/${tvdbId}/mediaout`, { method: "POST", body: {} });
                  setSaved(false);
                  toast(t("metasrc.rewritten"));
                })
              }
            >
              {t("metasrc.rewrite")}
            </button>
          )}
          <button onClick={onClose}>{t("common.close")}</button>
        </div>
      </div>
    </Modal>
  );
}
