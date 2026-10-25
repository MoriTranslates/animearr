import { useEffect, useMemo, useState } from "react";
import { api, fmtSize, sxe, type Episode, type SearchResponse, type SearchResult } from "../api";
import { Link, query } from "../App";
import { t } from "../i18n";
import { Chip, Confirm, Cover, Empty, ErrorBox, FlagChips, Spinner, usePageTitle, useToast, Why } from "../ui";

export function Search() {
  usePageTitle(t("search.title"));
  const [tab, setTab] = useState<"deep" | "identify">(query().get("tab") === "identify" ? "identify" : "deep");
  return (
    <section>
      <h1>{t("search.title")}</h1>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "deep"} className={tab === "deep" ? "on" : ""} onClick={() => setTab("deep")}>
          {t("search.title")}
        </button>
        <button role="tab" aria-selected={tab === "identify"} className={tab === "identify" ? "on" : ""} onClick={() => setTab("identify")}>
          {t("search.identify")}
        </button>
      </div>
      {tab === "deep" ? <DeepSearch /> : <Identify />}
    </section>
  );
}

function SeriesPicker({ value, onPick }: { value: { tvdbId: number; title: string } | null; onPick: (s: { tvdbId: number; title: string }) => void }) {
  const [q, setQ] = useState(value?.title ?? "");
  const [list, setList] = useState<{ tvdbId: number; title: string }[]>([]);
  useEffect(() => setQ(value?.title ?? ""), [value]);
  useEffect(() => {
    if (!q.trim() || q === value?.title) return setList([]);
    const ac = new AbortController();
    const id = setTimeout(() => void api<{ tvdbId: number; title: string }[]>(`/series?q=${encodeURIComponent(q)}`, { signal: ac.signal }).then(setList).catch(() => undefined), 200);
    return () => (clearTimeout(id), ac.abort());
  }, [q, value]);
  return (
    <div className="picker">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search.pickShowPlaceholder")} aria-label={t("search.pickShow")} />
      {!!list.length && (
        <ul className="picker-list card">
          {list.slice(0, 8).map((s) => (
            <li key={s.tvdbId}>
              <button className="ghost block" onClick={() => (onPick(s), setList([]))}>
                {s.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DeepSearch() {
  const toast = useToast();
  const qp = query();
  const [series, setSeries] = useState<{ tvdbId: number; title: string; cover?: string | null } | null>(null);
  const [eps, setEps] = useState<Episode[]>([]);
  const [sel, setSel] = useState<Set<number>>(new Set((qp.get("eps") ?? "").split(",").filter(Boolean).map(Number)));
  const [missingOnly, setMissingOnly] = useState(true);
  const [season, setSeason] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [partial, setPartial] = useState<{ searched: number; total: number; tier: number; found: number; results: SearchResult[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [grab, setGrab] = useState<SearchResult | null>(null);

  useEffect(() => {
    const id = Number(qp.get("tvdbId"));
    if (id) void api<{ tvdbId: number; title: string; cover: string | null }>(`/series/${id}`).then((s) => setSeries({ tvdbId: s.tvdbId, title: s.title, cover: s.cover })).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!series) return;
    void api<{ episodes: Episode[]; cover: string | null }>(`/series/${series.tvdbId}`).then((s) => {
      setEps(s.episodes);
      const first = s.episodes.find((e) => sel.has(e.id));
      setSeason(first?.season ?? s.episodes.filter((e) => e.season > 0).at(-1)?.season ?? null);
      if (sel.size && first) void run([...sel]);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series]);

  const seasons = useMemo(() => [...new Set(eps.map((e) => e.season))].sort((a, b) => a - b), [eps]);
  const shown = eps.filter((e) => e.season === season && (!missingOnly || !e.hasFile || sel.has(e.id)));

  /** Starts a search job and polls it: progress and partial results show while it runs. */
  async function run(ids = [...sel], full = false) {
    if (!series || !ids.length) return toast(t("search.selectEpisodes"), true);
    setBusy(true);
    setErr(null);
    setRes(null);
    setPartial(null);
    try {
      const { jobId } = await api<{ jobId: string }>("/search/start", { body: { tvdbId: series.tvdbId, episodeIds: ids, full } });
      for (;;) {
        await new Promise((r) => setTimeout(r, 700));
        const j = await api<{ done: boolean; progress: { searched: number; total: number; tier: number; found: number }; results?: SearchResult[]; result: SearchResponse | null; error: string | null }>(`/search/job/${jobId}`);
        if (j.done) {
          if (j.error) throw new Error(j.error);
          setRes(j.result);
          setPartial(null);
          break;
        }
        setPartial({ ...j.progress, results: j.results ?? [] });
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <p className="muted">{t("search.intro")}</p>
      <div className="card pad stack">
        <SeriesPicker
          value={series}
          onPick={(s) => {
            setSel(new Set());
            setRes(null);
            setSeries(s);
          }}
        />
        {series && (
          <>
            <div className="row between">
              <div className="chips pickable" role="group" aria-label={t("search.pickEpisodes")}>
                {seasons.map((s) => (
                  <button key={s} className={`chip${season === s ? " on" : ""}`} onClick={() => setSeason(s)}>
                    {s === 0 ? "S00" : t("common.season", { n: s })}
                  </button>
                ))}
              </div>
              <label className="check">
                <input type="checkbox" checked={missingOnly} onChange={(e) => setMissingOnly(e.target.checked)} /> {t("search.missingOnly")}
              </label>
            </div>
            <div className="chips pickable">
              {shown.map((e) => {
                const on = sel.has(e.id);
                return (
                  <button
                    key={e.id}
                    className={`chip${on ? " on" : ""}${e.hasFile ? "" : " missing"}`}
                    aria-pressed={on}
                    title={e.title ?? ""}
                    onClick={() =>
                      setSel((x) => {
                        const n = new Set(x);
                        if (on) n.delete(e.id);
                        else n.add(e.id);
                        return n;
                      })
                    }
                  >
                    {sxe(e.season, e.episode)}
                  </button>
                );
              })}
            </div>
            <button className="primary self-start" disabled={busy || !sel.size} onClick={() => run()}>
              {t("search.run")}
            </button>
          </>
        )}
      </div>
      {busy && <Spinner label={partial ? t("search.progress", { searched: partial.searched, total: partial.total, found: partial.found }) : t("search.running")} />}
      {busy && partial && !!partial.results.length && (
        <div className="list">
          {partial.results.slice(0, 8).map((r) => (
            <ResultCard key={r.guid} r={r} />
          ))}
        </div>
      )}
      {err && <ErrorBox error={err} />}
      {res && (
        <>
          <div className="row">
            <Cover src={res.series.cover} alt={res.series.title} size="sm" />
            <div>
              <Link to={`/show/${res.series.tvdbId}`} className="strong">
                {res.series.title}
              </Link>
              <p className="muted small">{t("search.summary", { found: res.found, matched: res.matched, queries: res.queries.length, secs: Math.round(res.tookMs / 1000) })}</p>
              {!!Object.keys(res.skipped).length && <p className="muted small">{t("search.skipped", { list: Object.entries(res.skipped).map(([k, v]) => `${v} ${k}`).join(", ") })}</p>}
            </div>
          </div>
          <div className="row between">
            <Why summary={t("common.more")} lines={res.queries} />
            {!res.complete && (
              <button className="small" onClick={() => run(res.targets.map((x) => x.id), true)}>
                {t("search.more")}
              </button>
            )}
          </div>
          {!res.results.length && <Empty>{t("search.none")}</Empty>}
          <div className="list">
            {res.results.map((r) => (
              <ResultCard key={r.guid} r={r} onGrab={() => setGrab(r)} />
            ))}
          </div>
        </>
      )}
      {grab && res && (
        <Confirm
          title={t("search.grabTitle")}
          confirmLabel={t("search.grabConfirm")}
          onClose={() => setGrab(null)}
          onConfirm={async () => {
            try {
              const r = await api<{ message: string }>("/grab", { body: { tvdbId: res.series.tvdbId, episodeIds: res.targets.map((x) => x.id), guid: grab.guid, confirm: true } });
              toast(t("search.grabDone", { message: r.message }));
              setGrab(null);
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          <p className="mono">{grab.title}</p>
          <FlagChips flags={grab.rank.flags} />
          <p>{res.dryRun ? t("search.grabDry") : t("search.grabLive", { client: grab.protocol === "usenet" ? "SABnzbd" : "qBittorrent", label: grab.label })}</p>
        </Confirm>
      )}
    </div>
  );
}

interface IdentifyResult { summary: string; series: { tvdbId: number; title: string; cover: string | null } | null; mapping: { ok: boolean; label: string; confidence: number; why: string[] } | null; parsed: Record<string, unknown> & { hints: Record<string, unknown> }; others: { tvdbId: number; title: string }[] }

function Identify() {
  const [name, setName] = useState("");
  const [r, setR] = useState<IdentifyResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function run(e: React.FormEvent) {
    e.preventDefault();
    try {
      setErr(null);
      setR(await api<IdentifyResult>("/identify", { body: { name } }));
    } catch (x) {
      setErr((x as Error).message);
    }
  }
  const p = r?.parsed;
  return (
    <div className="stack">
      <p className="muted">{t("search.identifyHelp")}</p>
      <form className="row" onSubmit={run}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="[SubsPlease] Quanzhi Fashi S7 - 05 (1080p)" aria-label={t("search.identify")} className="grow" />
        <button className="primary">{t("search.identifyRun")}</button>
      </form>
      {err && <ErrorBox error={err} />}
      {r && p && (
        <article className="card pad stack">
          <div className="row">
            {r.series && <Cover src={r.series.cover} alt={r.series.title} size="sm" />}
            <div>
              <strong>{r.summary}</strong>
              {r.mapping && <p>{r.mapping.ok ? <Chip tone={r.mapping.confidence >= 80 ? "good" : "warn"}>{r.mapping.label}</Chip> : <Chip tone="bad">✕</Chip>}</p>}
            </div>
          </div>
          <dl className="facts">
            {(["group", "title", "season", "episodes", "absolute", "version", "resolution", "source", "platform"] as const).map((k) => {
              const v = p[k];
              if (v === null || v === undefined || (Array.isArray(v) && !v.length)) return null;
              return (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{Array.isArray(v) ? v.join(", ") : String(v)}</dd>
                </div>
              );
            })}
            {!!(p.hints.subs as string[]).length && (
              <div>
                <dt>subs</dt>
                <dd>{(p.hints.subs as string[]).join(", ")}</dd>
              </div>
            )}
          </dl>
          {r.mapping && <Why lines={r.mapping.why} />}
          {!!r.others.length && <p className="muted small">{r.others.map((o) => o.title).join(", ")}</p>}
        </article>
      )}
    </div>
  );
}

export function ResultCard({ r, onGrab }: { r: SearchResult; onGrab?: () => void }) {
  return (
    <article className={`card pad result${r.rank.accept ? "" : " rejected"}`}>
      <p className="mono release">{r.title}</p>
      <div className="row">
        <Chip tone={r.confidence >= 80 ? "good" : "warn"}>{t("search.mapping", { label: r.label, confidence: r.confidence })}</Chip>
        <span className="muted small">
          {fmtSize(r.size)} · {r.indexer}
          {r.ageHours !== null ? ` · ${Math.round(r.ageHours / 24)}d` : ""}
        </span>
      </div>
      <FlagChips flags={r.rank.flags} />
      <p className="small">{r.rank.why}</p>
      <div className="row between">
        <Why lines={r.mappingWhy} />
        {onGrab && (
          <button className={r.rank.accept ? "primary" : ""} onClick={onGrab}>
            {t("search.grab")}
          </button>
        )}
      </div>
    </article>
  );
}
