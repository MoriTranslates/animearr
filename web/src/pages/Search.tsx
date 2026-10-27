import { useEffect, useMemo, useState } from "react";
import { api, fmtSize, type SearchResponse, type SearchResult } from "../api";
import { EpisodePicker, ShowPicker, type PickedShow } from "../picker";
import { Link, query } from "../App";
import { t } from "../i18n";
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
    try {
      const { jobId } = await api<{ jobId: string }>("/search/start", { body: { tvdbId, episodeIds: ids, full } });
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
            <EpisodePicker key={series.tvdbId} show={series} initial={series.tvdbId === Number(qp.get("tvdbId")) ? initial : []} dryRun={status.data?.dryRun ?? true} onChange={() => undefined} onInteractive={(ids) => void run(ids)} />
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
      <p className="release"><ReleaseName name={r.title} /></p>
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
