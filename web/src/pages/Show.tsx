import { useState } from "react";
import { api, sxe, type Decision, type Episode } from "../api";
import { navigate } from "../App";
import { t } from "../i18n";
import { Chip, Cover, ErrorBox, Spinner, useLoad, usePageTitle, useToast } from "../ui";
import { DecisionCard } from "./Activity";

interface ShowData {
  id: number;
  tvdbId: number;
  title: string;
  path: string;
  cover: string | null;
  managed: { dryRun: boolean } | null;
  episodes: Episode[];
  anidb: { aid: number; season: number | "a" | null; offset: number; title: string | null }[];
  aliases: { id: number; title: string; season: number | null; source: string }[];
  rules: { id: number; grp: string | null; mode: string; season: number | null; offset: number }[];
  facts: { id: number; season: number | null; kind: string; lang: string; note: string }[];
}

export function Show({ tvdbId }: { tvdbId: number }) {
  const toast = useToast();
  const d = useLoad(() => api<ShowData>(`/series/${tvdbId}`), [tvdbId]);
  const act = useLoad(() => api<Decision[]>(`/activity?tvdbId=${tvdbId}`), [tvdbId]);
  usePageTitle(d.data?.title ?? "…");
  const [alias, setAlias] = useState({ title: "", season: "" });
  const [rule, setRule] = useState({ mode: "season", season: "", offset: "0", group: "" });
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={t("app.loading")} />;
  const s = d.data;
  const seasons = [...new Set(s.episodes.map((e) => e.season))].sort((a, b) => a - b);
  const now = Date.now();
  const call = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      toast(t("common.saved"));
      await d.reload();
      await act.reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <section>
      <div className="hero-row">
        <Cover src={s.cover} alt={s.title} size="lg" />
        <div className="stack">
          <h1>{s.title}</h1>
          <p className="mono small muted">{s.path}</p>
          <div className="chips">{s.managed ? <Chip tone="accent">{t("chip.managed")}{s.managed.dryRun ? ` · ${t("chip.dryRun")}` : ""}</Chip> : null}</div>
        </div>
      </div>

      <div className="card pad stack">
        <h2>{t("show.episodes")}</h2>
        {seasons.map((n) => {
          const list = s.episodes.filter((e) => e.season === n);
          const missing = list.filter((e) => !e.hasFile && e.airUtc !== null && e.airUtc <= now);
          return (
            <div key={n} className="season-row">
              <div className="row between">
                <strong>{n === 0 ? "S00" : t("common.season", { n })}</strong>
                {!!missing.length && (
                  <button className="small" onClick={() => navigate(`/search?tvdbId=${tvdbId}&eps=${missing.slice(0, 26).map((e) => e.id).join(",")}`)}>
                    {t("show.searchSeason")} ({missing.length})
                  </button>
                )}
              </div>
              <div className="ep-dots">
                {list.map((e) => (
                  <span key={e.id} title={`${sxe(e.season, e.episode)} ${e.title ?? ""}`} className={`ep ${e.hasFile ? "have" : e.airUtc !== null && e.airUtc <= now ? "miss" : "future"}`}>
                    {e.episode}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="two-col">
        <div className="card pad stack">
          <h2>{t("show.anidb")}</h2>
          {!s.anidb.length && <p className="muted">{t("show.noAnidb")}</p>}
          <ul className="plain">
            {s.anidb.map((a) => (
              <li key={a.aid}>
                <a href={`https://anidb.net/anime/${a.aid}`} target="_blank" rel="noreferrer">
                  {a.aid}
                </a>{" "}
                {a.title} → {a.season === "a" ? "absolute" : a.season === null ? "—" : `S${a.season}`}
                {a.offset ? ` (+${a.offset})` : ""}
              </li>
            ))}
          </ul>
        </div>

        <div className="card pad stack">
          <h2>{t("show.aliases")}</h2>
          <ul className="plain">
            {s.aliases.map((a) => (
              <li key={a.id} className="row between">
                <span>
                  {a.title}
                  {a.season !== null ? ` (S${a.season})` : ""} <Chip>{a.source}</Chip>
                </span>
                <button className="small ghost" onClick={() => call(() => api(`/aliases/${a.id}`, { method: "DELETE" }))}>
                  {t("common.delete")}
                </button>
              </li>
            ))}
          </ul>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void call(() => api("/aliases", { body: { tvdbId, title: alias.title, season: alias.season ? Number(alias.season) : null } })).then(() => setAlias({ title: "", season: "" }));
            }}
          >
            <input className="grow" value={alias.title} onChange={(e) => setAlias({ ...alias, title: e.target.value })} placeholder={t("show.aliasAdd")} aria-label={t("show.aliasAdd")} />
            <input className="narrow" inputMode="numeric" value={alias.season} onChange={(e) => setAlias({ ...alias, season: e.target.value })} placeholder={t("show.aliasSeason")} aria-label={t("show.aliasSeason")} />
            <button>{t("common.add")}</button>
          </form>
        </div>

        <div className="card pad stack">
          <h2>{t("show.rules")}</h2>
          <ul className="plain">
            {s.rules.map((r) => (
              <li key={r.id} className="row between">
                <span>
                  {r.grp ? `${r.grp}: ` : ""}
                  {r.mode}
                  {r.season !== null ? ` S${r.season}` : ""}
                  {r.offset ? ` offset ${r.offset}` : ""}
                </span>
                <button className="small ghost" onClick={() => call(() => api(`/rules/${r.id}`, { method: "DELETE" }))}>
                  {t("common.delete")}
                </button>
              </li>
            ))}
          </ul>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void call(() => api("/rules", { body: { tvdbId, mode: rule.mode, season: rule.season ? Number(rule.season) : null, offset: Number(rule.offset) || 0, group: rule.group } }));
            }}
          >
            <label>
              {t("show.ruleMode")}
              <select value={rule.mode} onChange={(e) => setRule({ ...rule, mode: e.target.value })}>
                <option value="absolute">{t("show.ruleMode.absolute")}</option>
                <option value="season">{t("show.ruleMode.season")}</option>
                <option value="offset">{t("show.ruleMode.offset")}</option>
              </select>
            </label>
            {rule.mode !== "absolute" && (
              <label>
                {t("show.aliasSeason")}
                <input inputMode="numeric" value={rule.season} onChange={(e) => setRule({ ...rule, season: e.target.value })} />
              </label>
            )}
            {rule.mode === "offset" && (
              <label>
                {t("show.ruleOffset")}
                <input inputMode="numeric" value={rule.offset} onChange={(e) => setRule({ ...rule, offset: e.target.value })} />
              </label>
            )}
            <label>
              {t("show.ruleGroup")}
              <input value={rule.group} onChange={(e) => setRule({ ...rule, group: e.target.value })} />
            </label>
            <button className="self-start">{t("common.add")}</button>
          </form>
        </div>

        <div className="card pad stack">
          <h2>{t("show.facts")}</h2>
          {!s.facts.length && <p className="muted">{t("common.none")}</p>}
          <ul className="plain">
            {s.facts.map((f) => (
              <li key={f.id} className="row between">
                <span>
                  {f.season !== null ? `S${f.season}: ` : ""}
                  {f.kind === "burned_in" ? `burned-in ${f.lang}` : f.kind} {f.note && <span className="muted small">({f.note})</span>}
                </span>
                <button className="small ghost" onClick={() => call(() => api(`/facts/${f.id}`, { method: "DELETE" }))}>
                  {t("common.delete")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <h2 className="section-title">{t("nav.activity")}</h2>
      <div className="list">{(act.data ?? []).slice(0, 10).map((x) => <DecisionCard key={x.id} d={x} onUndone={act.reload} />)}</div>
    </section>
  );
}
