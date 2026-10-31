import { useEffect, useMemo, useState } from "react";
import { api, fmtSize, type SearchResponse, type SearchResult } from "../api";
import { EpisodePicker, ShowPicker, type PickedShow } from "../picker";
import { Link, query } from "../App";
import { t, type I18nKey } from "../i18n";
import { compareQuality, libraryQuality, qualityName, splitPacks, type LibraryQuality, type Pack, type Quality } from "../packs";
import { Chip, Confirm, Cover, Empty, ErrorBox, FlagChips, Spinner, useLoad, usePageTitle, useToast, Why, ReleaseName } from "../ui";

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

function DeepSearch() {
  const toast = useToast();
  const qp = query();
  const [series, setSeries] = useState<PickedShow | null>(null);
  const initial = useMemo(() => (qp.get("eps") ?? "").split(",").filter(Boolean).map(Number), []); // eslint-disable-line react-hooks/exhaustive-deps
  const status = useLoad(() => api<{ dryRun: boolean }>("/status"), []);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [partial, setPartial] = useState<{ searched: number; total: number; tier: number; found: number; results: SearchResult[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [grab, setGrab] = useState<SearchResult | null>(null);
  // Replace season (from the season's ⋯ menu): a pack replaces every selected episode, old files go to the bin.
  const replaceMode = qp.get("replace") === "1";
  const [replace, setReplace] = useState(replaceMode);
  const [tab, setTab] = useState<"packs" | "singles" | null>(null);
  const [have, setHave] = useState<LibraryQuality | null>(null);
  const season = replaceMode && qp.has("season") ? Number(qp.get("season")) : res && new Set(res.targets.map((x) => x.season)).size === 1 && res.targets.some((x) => x.hasFile) ? res.targets[0].season : null;
  const haveFor = res?.series.tvdbId ?? Number(qp.get("tvdbId"));
  // What the season has now, for "better than what you have" on each result.
  useEffect(() => {
    setHave(null);
    if (season === null || !haveFor) return;
    void api<{ quality: (Quality & { n: number })[] }>(`/series/${haveFor}/replace-season?season=${season}`)
      .then((p) => setHave(libraryQuality(p.quality ?? [])))
      .catch(() => undefined);
  }, [haveFor, season]);

  useEffect(() => {
    const id = Number(qp.get("tvdbId"));
    if (!id) return;
    void api<{ tvdbId: number; title: string; cover: string | null }>(`/series/${id}`)
      .then((x) => {
        setSeries({ tvdbId: x.tvdbId, title: x.title, cover: x.cover });
        // Coming from a "needs a look" or 🔍 button: show the list right away.
        if (initial.length) void run(initial, false, x.tvdbId);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // "Open the list" / 🔍 from elsewhere while this page is open.
  useEffect(() => {
    const on = (e: Event) => {
      const { tvdbId, ids } = (e as CustomEvent<{ tvdbId: number; ids: number[] }>).detail;
      void api<{ tvdbId: number; title: string; cover: string | null }>(`/series/${tvdbId}`).then((x) => {
        setSeries({ tvdbId: x.tvdbId, title: x.title, cover: x.cover });
        void run(ids, false, tvdbId);
      });
    };
    window.addEventListener("animearr:interactive", on);
    return () => window.removeEventListener("animearr:interactive", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Starts a search job and polls it: progress and partial results show while it runs. */
  async function run(ids: number[], full = false, tvdbId = series?.tvdbId) {
    if (!tvdbId || !ids.length) return toast(t("search.selectEpisodes"), true);
    setBusy(true);
    setErr(null);
    setRes(null);
    setPartial(null);
    setTab(null);
    try {
      const { jobId } = await api<{ jobId: string }>("/search/start", { body: { tvdbId, episodeIds: ids, full, packs: replaceMode } });
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

  const split = res ? splitPacks(res.results, res.targets, have?.main) : null;
  const tabbed = !!split && (replaceMode || (!!split.packs.length && !!split.singles.length));
  const shown = tab ?? (replaceMode || (res?.targets.length ?? 0) > 1 ? "packs" : "singles");
  const packLabel = (p: Pack<SearchResult>) =>
    replaceMode
      ? p.whole ? t("packs.whole", { n: p.covered, total: p.total }) : t("packs.part", { eps: p.episodes })
      : p.total === 1 ? t("packs.pack", { n: p.r.episodeIds.length }) : p.whole ? t("packs.allPicked", { n: p.total }) : t("packs.somePicked", { eps: p.episodes });

  return (
    <div className="stack">
      {replaceMode && (
        <div className="card pad stack">
          <p className="strong">{t("packs.replaceIntro", { season: season ?? "", n: initial.length })}</p>
          {have && <p className="small muted">{haveLine(have)}</p>}
        </div>
      )}
      <p className="muted small">
        {t("search.introShort")} <span className="info-tip" title={t("search.intro")} aria-label={t("search.intro")}>ⓘ</span>
      </p>
      <div className="card pad stack">
        {!series ? (
          <ShowPicker onPick={(x) => (setRes(null), setSeries(x))} />
        ) : (
          <>
            <button className="link small self-end" onClick={() => (setSeries(null), setRes(null))}>
              {t("picker.change")}
            </button>
            <EpisodePicker key={series.tvdbId} show={series} initial={series.tvdbId === Number(qp.get("tvdbId")) ? initial : []} dryRun={status.data?.dryRun ?? true} onChange={() => undefined} onInteractive={(ids) => void run(ids)} noAuto={replaceMode} />
          </>
        )}
      </div>
      {busy && <Spinner label={partial ? t("search.progress", { searched: partial.searched, total: partial.total, found: partial.found }) : t("search.running")} />}
      {busy && partial && !!partial.results.length && (
        <div className="list">
          {partial.results.filter((r) => !replaceMode || r.episodeIds.length > 1).slice(0, 8).map((r) => (
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
              {!!res.ownedElsewhere?.length && <p className="warn-text small">{t("dup.pickWarn", { why: res.ownedElsewhere[0].why, n: res.ownedElsewhere.length })}</p>}
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
          {!replaceMode && have && <p className="small muted">{haveLine(have)}</p>}
          {!res.results.length && !replaceMode && <Empty>{t("search.none")}</Empty>}
          {tabbed && split ? (
            <>
              <div className="tabs" role="tablist">
                <button role="tab" aria-selected={shown === "packs"} className={shown === "packs" ? "on" : ""} onClick={() => setTab("packs")}>
                  {t("packs.tabPacks", { n: split.packs.length })}
                </button>
                <button role="tab" aria-selected={shown === "singles"} className={shown === "singles" ? "on" : ""} onClick={() => setTab("singles")}>
                  {t("packs.tabSingles", { n: split.singles.length })}
                </button>
              </div>
              {shown === "packs" ? (
                <>
                  {!split.packs.length && (
                    <Empty title={t("packs.noneTitle", { season: season ?? "" })} action={!res.complete ? { label: t("packs.deeper"), run: () => void run(res.targets.map((x) => x.id), true) } : undefined}>
                      {t(replaceMode ? "packs.noneNext" : "packs.noneNextSearch")}
                    </Empty>
                  )}
                  {replaceMode && !split.packs.length && (
                    <Link to={`/show/${res.series.tvdbId}`} className="small self-center">
                      {t("packs.backToShow")}
                    </Link>
                  )}
                  <div className="list">
                    {split.packs.map((p) => (
                      <ResultCard key={p.r.guid} r={p.r} onGrab={() => setGrab(p.r)} extra={<div className="row"><Chip tone={p.whole ? "good" : "warn"}>{packLabel(p)}</Chip><QualityBadge r={p.r} have={have} /></div>} />
                    ))}
                  </div>
                </>
              ) : (
                <>
                  {replaceMode && <p className="small muted">{t("packs.singlesNote")}</p>}
                  {!split.singles.length && <Empty>{t("packs.noSingles")}</Empty>}
                  <div className="list">
                    {split.singles.map((r) => (
                      <ResultCard key={r.guid} r={r} onGrab={() => setGrab(r)} extra={<QualityBadge r={r} have={have} />} />
                    ))}
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="list">
              {res.results.map((r) => (
                <ResultCard key={r.guid} r={r} onGrab={() => setGrab(r)} extra={<QualityBadge r={r} have={have} />} />
              ))}
            </div>
          )}
        </>
      )}
      {grab && res && (
        <Confirm
          title={t("search.grabTitle")}
          confirmLabel={t("search.grabConfirm")}
          onClose={() => setGrab(null)}
          onConfirm={async () => {
            try {
              const r = await api<{ message: string }>("/grab", { body: { tvdbId: res.series.tvdbId, episodeIds: res.targets.map((x) => x.id), guid: grab.guid, confirm: true, replace: replace && grab.episodeIds.length > 1 } });
              toast(t("search.grabDone", { message: r.message }));
              setGrab(null);
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          <p><ReleaseName name={grab.title} /></p>
          <FlagChips flags={grab.rank.flags} />
          <p>{res.dryRun ? t("search.grabDry") : t("search.grabLive", { client: grab.protocol === "usenet" ? "SABnzbd" : "qBittorrent", label: grab.label })}</p>
          {grab.episodeIds.length > 1 && res.targets.some((x) => x.hasFile) && (
            <label className="check">
              <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> {t("replace.check")}
            </label>
          )}
          {replace && grab.episodeIds.length > 1 && <p className="small muted">{t("replace.how")}</p>}
          {replaceMode && grab.episodeIds.length < 2 && <p className="small">{t("packs.singleGrab", { label: grab.label })}</p>}
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

/** "You have: WEB-DL 1080p (mixed: 10 WEB-DL, 2 TV)" */
function haveLine(h: LibraryQuality) {
  const mixed = h.bySource.length > 1 ? ` ${t("packs.mixed", { list: h.bySource.map((x) => `${x.n} ${x.name}`).join(", ") })}` : "";
  return t("packs.have", { q: qualityName(h.main) }) + mixed;
}

/** Better, same or lower than what the season has now (nothing when either side is unknown). */
function QualityBadge({ r, have }: { r: SearchResult; have: LibraryQuality | null }) {
  const c = compareQuality(r.quality, have?.main);
  if (c.verdict === "unknown") return null;
  return <Chip tone={c.verdict === "up" ? "good" : c.verdict === "down" ? "warn" : "info"}>{t(`packs.q.${c.verdict}` as I18nKey, { from: c.from, to: c.to })}</Chip>;
}

export function ResultCard({ r, onGrab, extra }: { r: SearchResult; onGrab?: () => void; extra?: React.ReactNode }) {
  const sd = r.rank.flags.find((f) => f.key === "seadex");
  return (
    <article className={`card pad result${r.rank.accept ? "" : " rejected"}`}>
      <p className="release"><ReleaseName name={r.title} /></p>
      {extra}
      <div className="row">
        <Chip tone={r.confidence >= 80 ? "good" : "warn"}>{t("search.mapping", { label: r.label, confidence: r.confidence })}</Chip>
        <span className="muted small">
          {fmtSize(r.size)} · {r.indexer}
          {r.ageHours !== null ? ` · ${Math.round(r.ageHours / 24)}d` : ""}
        </span>
      </div>
      {sd && <div className="chips"><Chip tone={/best/i.test(sd.label) ? "good" : "info"}>{t(/best/i.test(sd.label) ? "seadex.mark.best" : "seadex.mark.alt")}</Chip></div>}
      <FlagChips flags={r.rank.flags.filter((f) => f.key !== "seadex")} />
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
