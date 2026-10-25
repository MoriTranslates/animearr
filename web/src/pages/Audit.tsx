import { useState } from "react";
import { api, sxe } from "../api";
import { Link, navigate, query } from "../App";
import { t } from "../i18n";
import { Chip, Cover, Empty, ErrorBox, Spinner, useLoad, usePageTitle, useToast, Why } from "../ui";

type Tab = "language" | "gaps" | "specials";

export function Audit() {
  usePageTitle(t("audit.title"));
  const initial = (query().get("tab") as Tab) || "gaps";
  const [tab, setTab] = useState<Tab>(["language", "gaps", "specials"].includes(initial) ? initial : "gaps");
  const pick = (x: Tab) => {
    setTab(x);
    history.replaceState(null, "", `/audit?tab=${x}`);
  };
  return (
    <section>
      <h1>{t("audit.title")}</h1>
      <p className="muted small">{t("audit.readOnly")}</p>
      <div className="tabs" role="tablist">
        {(["gaps", "language", "specials"] as Tab[]).map((x) => (
          <button key={x} role="tab" aria-selected={tab === x} className={tab === x ? "on" : ""} onClick={() => pick(x)}>
            {t(`audit.tab.${x}`)}
          </button>
        ))}
      </div>
      {tab === "gaps" && <Gaps />}
      {tab === "language" && <Language />}
      {tab === "specials" && <Specials />}
    </section>
  );
}

interface GapSeries { seriesId: number; tvdbId: number; title: string; cover: string | null; status: string; missing: { id: number; season: number; episode: number; title: string | null; airUtc: number | null }[]; missingSeasons: { season: number; aired: number; monitored: boolean }[] }

function Gaps() {
  const d = useLoad(() => api<{ series: GapSeries[]; episodes: number; seasons: number }>("/audit/gaps"), []);
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={t("app.loading")} />;
  return (
    <div className="stack">
      <p className="muted">{t("audit.gaps.intro")}</p>
      <p>
        <strong>{t("audit.gaps.total", { episodes: d.data.episodes, seasons: d.data.seasons })}</strong>
      </p>
      {!d.data.series.length && <Empty>{t("audit.gaps.empty")}</Empty>}
      <div className="list">
        {d.data.series.map((s) => (
          <article key={s.tvdbId} className="card show-card">
            <Cover src={s.cover} alt={s.title} size="sm" />
            <div className="show-body">
              <Link to={`/show/${s.tvdbId}`} className="strong">
                {s.title}
              </Link>
              {!!s.missingSeasons.length && (
                <div className="chips">
                  {s.missingSeasons.map((m) => (
                    <Chip key={m.season} tone="warn">
                      {t("audit.gaps.missingSeason", { n: m.season, aired: m.aired })}
                    </Chip>
                  ))}
                </div>
              )}
              {!!s.missing.length && (
                <div className="chips">
                  {s.missing.slice(0, 24).map((e) => (
                    <button key={e.id} className="chip link" title={e.title ?? ""} onClick={() => navigate(`/search?tvdbId=${s.tvdbId}&eps=${e.id}`)}>
                      {sxe(e.season, e.episode)}
                    </button>
                  ))}
                  {s.missing.length > 24 && <span className="muted small">+{s.missing.length - 24}</span>}
                </div>
              )}
              <button className="small self-start" onClick={() => navigate(`/search?tvdbId=${s.tvdbId}&eps=${s.missing.slice(0, 26).map((e) => e.id).join(",")}`)} disabled={!s.missing.length}>
                {t("audit.gaps.deep")}
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

interface LangGroup { seriesId: number; tvdbId: number; title: string; cover: string | null; season: number; files: { id: number; name: string; group: string | null; audio: string[]; subs: string[]; reason: string }[] }

function Language() {
  const toast = useToast();
  const [sidecars, setSidecars] = useState(false);
  const d = useLoad(() => api<{ profile: string[]; checkedFiles: number; series: LangGroup[]; confirmed: { tvdbId: number; title: string; season: number; files: number }[]; movies: { movieId: number; title: string; cover: string | null; group: string | null; reason: string }[] }>(`/audit/language${sidecars ? "?sidecars=1" : ""}`), [sidecars]);
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={t("app.loading")} />;
  const lang = d.data.profile[0] ?? "en";
  return (
    <div className="stack">
      <p className="muted">{t("audit.lang.intro", { langs: d.data.profile.join(", ") })}</p>
      <label className="check">
        <input type="checkbox" checked={sidecars} onChange={(e) => setSidecars(e.target.checked)} /> {t("audit.lang.sidecars")}
      </label>
      <p className="muted small">{t("audit.lang.checked", { n: d.data.checkedFiles })}</p>
      {!d.data.series.length && !d.data.movies.length && <Empty>{t("audit.lang.empty")}</Empty>}
      <div className="list">
        {d.data.series.map((g) => (
          <article key={`${g.tvdbId}-${g.season}`} className="card show-card">
            <Cover src={g.cover} alt={g.title} size="sm" />
            <div className="show-body">
              <div className="row between">
                <Link to={`/show/${g.tvdbId}`} className="strong">
                  {g.title}
                </Link>
                <Chip tone="info">
                  {t("common.season", { n: g.season })} · {t("audit.lang.files", { n: g.files.length })}
                </Chip>
              </div>
              <p className="small muted">{g.files[0].reason}</p>
              <Why summary={t("common.more")} lines={g.files.map((f) => `${f.name}${f.group ? ` [${f.group}]` : ""}: ${f.reason}`)} />
              <button
                className="small self-start"
                onClick={async () => {
                  try {
                    await api("/facts", { body: { tvdbId: g.tvdbId, season: g.season, kind: "burned_in", lang } });
                    toast(t("audit.lang.marked", { season: g.season }));
                    await d.reload();
                  } catch (e) {
                    toast((e as Error).message, true);
                  }
                }}
              >
                {t("audit.lang.markBurned", { lang })}
              </button>
            </div>
          </article>
        ))}
      </div>
      {!!d.data.movies.length && (
        <>
          <h2 className="section-title">{t("audit.lang.movies")}</h2>
          <div className="list">
            {d.data.movies.map((m) => (
              <article key={m.movieId} className="card show-card">
                <Cover src={m.cover} alt={m.title} size="sm" />
                <div className="show-body">
                  <strong>{m.title}</strong>
                  <p className="small muted">{m.reason}</p>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
      {!!d.data.confirmed.length && (
        <>
          <h2 className="section-title">{t("audit.lang.confirmed")}</h2>
          <div className="chips">
            {d.data.confirmed.map((c) => (
              <Chip key={`${c.tvdbId}-${c.season}`} tone="info">
                {c.title} · {t("common.season", { n: c.season })}
              </Chip>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

interface SpecialSeries { tvdbId: number; title: string; cover: string | null; items: { id: number; episode: number; title: string | null; runtime: number | null; hasFile: boolean; cls: "movie" | "real" | "junk" | "unknown"; why: string; radarr: { inRadarr: boolean; title?: string } | null }[] }

function Specials() {
  const [junk, setJunk] = useState(false);
  const d = useLoad(() => api<{ series: SpecialSeries[]; totals: Record<string, number> }>("/audit/specials"), []);
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={t("app.loading")} />;
  const tone = { movie: "accent", real: "good", junk: "info", unknown: "warn" } as const;
  return (
    <div className="stack">
      <p className="muted">{t("audit.specials.intro")}</p>
      <p>
        <strong>{t("audit.specials.totals", { movie: d.data.totals.movie, inRadarr: d.data.totals.movieInRadarr, real: d.data.totals.real, junk: d.data.totals.junk, unknown: d.data.totals.unknown })}</strong>
      </p>
      <label className="check">
        <input type="checkbox" checked={junk} onChange={(e) => setJunk(e.target.checked)} /> {t("audit.specials.showJunk")}
      </label>
      <div className="list">
        {d.data.series
          .map((s) => ({ ...s, items: s.items.filter((i) => junk || i.cls !== "junk") }))
          .filter((s) => s.items.length)
          .map((s) => (
            <article key={s.tvdbId} className="card show-card">
              <Cover src={s.cover} alt={s.title} size="sm" />
              <div className="show-body">
                <Link to={`/show/${s.tvdbId}`} className="strong">
                  {s.title}
                </Link>
                <ul className="plain">
                  {s.items.map((i) => (
                    <li key={i.id} className="special-row">
                      <span className="mono">S00E{String(i.episode).padStart(2, "0")}</span>
                      <Chip tone={tone[i.cls]}>{t(`audit.specials.${i.cls}`)}</Chip>
                      <span className="clamp2">{i.title ?? "—"}</span>
                      {i.hasFile && <Chip tone="good">✓</Chip>}
                      {i.radarr && <Chip tone={i.radarr.inRadarr ? "good" : "warn"}>{i.radarr.inRadarr ? t("audit.specials.inRadarr", { title: i.radarr.title }) : t("audit.specials.notInRadarr")}</Chip>}
                      <Why lines={[i.why]} />
                    </li>
                  ))}
                </ul>
              </div>
            </article>
          ))}
      </div>
    </div>
  );
}
