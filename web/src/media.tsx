import { useEffect, useState } from "react";
import { api, type MediaSettings, type Settings as S } from "./api";
import { Link } from "./App";
import { t, type I18nKey } from "./i18n";
import { ImportBrowser } from "./importBrowser";
import { Chip, Confirm, ErrorBox, NumberInput, Spinner, Toggle, useLoad, useToast } from "./ui";

type Upd = (fn: (x: S) => S) => void;
type Preview = Record<"standard" | "daily" | "anime" | "multi" | "seriesFolder" | "seasonFolder" | "specialsFolder" | "movie" | "movieFolder", string>;

const COLON: MediaSettings["colonReplacement"][] = ["smart", "delete", "dash", "spaceDash", "spaceDashSpace"];
const MULTI: MediaSettings["multiEpisodeStyle"][] = ["prefixedRange", "extend", "duplicate", "repeat", "scene", "range"];

/** Settings → Media management: mirrors Sonarr/Radarr (naming, folders, importing, file management, permissions). */
export function MediaManagement({ s, upd }: { s: S; upd: Upd }) {
  const toast = useToast();
  const m = s.media;
  const set = (patch: Partial<MediaSettings>) => upd((x) => ({ ...x, media: { ...x.media, ...patch } }));
  const [adv, setAdv] = useState(false);
  const [pv, setPv] = useState<Preview | null>(null);
  useEffect(() => {
    const c = new AbortController();
    const h = setTimeout(() => {
      api<Preview>("/media/preview", { body: m, signal: c.signal }).then(setPv, () => undefined);
    }, 250);
    return () => (clearTimeout(h), c.abort());
  }, [m]);
  const fmt = (key: keyof MediaSettings, label: I18nKey, ex: keyof Preview) => (
    <label>
      {t(label)}
      <input value={String(m[key])} onChange={(e) => set({ [key]: e.target.value } as Partial<MediaSettings>)} spellCheck={false} />
      <span className="muted small mono">{pv ? pv[ex] : "…"}</span>
    </label>
  );
  const sel = <K extends keyof MediaSettings>(key: K, label: I18nKey, options: readonly string[]) => (
    <label>
      {t(label)}
      <select value={String(m[key])} onChange={(e) => set({ [key]: e.target.value } as Partial<MediaSettings>)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {t(`media.opt.${o}` as I18nKey)}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="stack">
      <ImporterCard s={s} />
      <div className="row">
        <button
          className="small"
          onClick={async () => {
            try {
              const r = await api<{ sonarr: boolean; radarr: boolean; media: MediaSettings }>("/media/import-defaults", { body: {} });
              upd((x) => ({ ...x, media: r.media }));
              toast(t("media.copied"));
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          ⇣ {t("media.copyFromArr")}
        </button>
        <Toggle checked={adv} onChange={setAdv} label={t("media.showAdvanced")} />
      </div>

      <div className="card pad form">
        <h2>{t("media.episodeNaming")}</h2>
        <Toggle checked={m.renameEpisodes} onChange={(v) => set({ renameEpisodes: v })} label={t("media.renameEpisodes")} />
        <Toggle checked={m.replaceIllegalCharacters} onChange={(v) => set({ replaceIllegalCharacters: v })} label={t("media.replaceIllegal")} />
        {sel("colonReplacement", "media.colon", COLON)}
        {fmt("standardEpisodeFormat", "media.standardFormat", "standard")}
        {fmt("dailyEpisodeFormat", "media.dailyFormat", "daily")}
        {fmt("animeEpisodeFormat", "media.animeFormat", "anime")}
        {fmt("seriesFolderFormat", "media.seriesFolder", "seriesFolder")}
        {fmt("seasonFolderFormat", "media.seasonFolder", "seasonFolder")}
        {fmt("specialsFolderFormat", "media.specialsFolder", "specialsFolder")}
        <label>
          {t("media.creditlessAs")}
          <select value={m.creditlessAs ?? "s00"} onChange={(e) => set({ creditlessAs: e.target.value as "s00" | "extras" })}>
            <option value="s00">{t("media.creditlessAs.s00")}</option>
            <option value="extras">{t("media.creditlessAs.extras")}</option>
          </select>
          <span className="muted small">{t("media.creditlessAsHelp")}</span>
        </label>
        <label>
          {t("media.multiStyle")}
          <select value={m.multiEpisodeStyle} onChange={(e) => set({ multiEpisodeStyle: e.target.value as MediaSettings["multiEpisodeStyle"] })}>
            {MULTI.map((o) => (
              <option key={o} value={o}>
                {t(`media.opt.${o}` as I18nKey)}
              </option>
            ))}
          </select>
          <span className="muted small mono">{pv?.multi ?? "…"}</span>
        </label>
        <p className="muted small">{t("media.tokensHelp")}</p>
      </div>

      <div className="card pad form">
        <h2>{t("media.movieNaming")}</h2>
        <Toggle checked={m.renameMovies} onChange={(v) => set({ renameMovies: v })} label={t("media.renameMovies")} />
        {sel("movieColonReplacement", "media.colon", COLON)}
        {fmt("movieFormat", "media.movieFormat", "movie")}
        {fmt("movieFolderFormat", "media.movieFolder", "movieFolder")}
      </div>

      <div className="card pad form">
        <h2>{t("media.folders")}</h2>
        <Toggle checked={m.createEmptyFolders} onChange={(v) => set({ createEmptyFolders: v })} label={t("media.createEmpty")} />
        <Toggle checked={m.deleteEmptyFolders} onChange={(v) => set({ deleteEmptyFolders: v })} label={t("media.deleteEmpty")} />
      </div>

      <div className="card pad form">
        <h2>{t("media.importing")}</h2>
        {sel("episodeTitleRequired", "media.titleRequired", ["always", "bulkSeasonReleases", "never"])}
        {adv && <Toggle checked={m.skipFreeSpaceCheck} onChange={(v) => set({ skipFreeSpaceCheck: v })} label={t("media.skipFreeSpace")} />}
        {adv && (
          <label>
            {t("media.minFreeSpace")}
            <NumberInput value={m.minimumFreeSpaceMb} min={0} max={1_000_000} onChange={(v) => set({ minimumFreeSpaceMb: v })} label={t("media.minFreeSpace")} />
          </label>
        )}
        <Toggle checked={m.useHardlinks} onChange={(v) => set({ useHardlinks: v })} label={t("media.hardlinks")} help={t("media.hardlinksHelp")} />
        <Toggle checked={m.importExtraFiles} onChange={(v) => set({ importExtraFiles: v })} label={t("media.extraFiles")} />
        {m.importExtraFiles && (
          <label>
            {t("media.extraExt")}
            <input value={m.extraFileExtensions} onChange={(e) => set({ extraFileExtensions: e.target.value })} />
          </label>
        )}
        {sel("propers", "media.propers", ["preferAndUpgrade", "doNotUpgrade", "doNotPrefer"])}
        <Toggle checked={m.renameAfterReencode} onChange={(v) => set({ renameAfterReencode: v })} label={t("media.renameAfterReencode")} help={t("media.renameAfterReencodeHelp")} />
      </div>

      <div className="card pad form">
        <h2>{t("media.fileManagement")}</h2>
        <Toggle checked={m.unmonitorDeleted} onChange={(v) => set({ unmonitorDeleted: v })} label={t("media.unmonitorDeleted")} />
        {adv && sel("fileDate", "media.fileDate", ["none", "localAirDate", "utcAirDate"])}
        <label>
          {t("media.recycleBin")}
          <input value={m.recycleBin} onChange={(e) => set({ recycleBin: e.target.value })} placeholder="/media/Recycle/animearr/" />
        </label>
        <label>
          {t("media.recycleDays")}
          <NumberInput value={m.recycleBinCleanupDays} min={0} max={365} onChange={(v) => set({ recycleBinCleanupDays: v })} label={t("media.recycleDays")} />
        </label>
        {adv && sel("rescanAfterRefresh", "media.rescan", ["always", "afterManual", "never"])}
        {adv && <Toggle checked={m.analyseVideoFiles} onChange={(v) => set({ analyseVideoFiles: v })} label={t("media.analyse")} />}
      </div>

      {adv && (
        <div className="card pad form">
          <h2>{t("media.permissions")}</h2>
          <Toggle checked={m.setPermissions} onChange={(v) => set({ setPermissions: v })} label={t("media.setPermissions")} />
          <label>
            {t("media.chmod")}
            <input value={m.chmodFolder} onChange={(e) => set({ chmodFolder: e.target.value.replace(/[^0-7]/g, "").slice(0, 4) })} inputMode="numeric" />
          </label>
          <label>
            {t("media.chown")}
            <input value={m.chownGroup} onChange={(e) => set({ chownGroup: e.target.value })} />
          </label>
        </div>
      )}
      <RenameAll />
    </div>
  );
}

/** Who imports, and the real-import/rename switches (each needs a confirmation). */
function ImporterCard({ s }: { s: S }) {
  const toast = useToast();
  const [imp, setImp] = useState(s.importer);
  const [ask, setAsk] = useState<null | Partial<S["importer"]>>(null);
  const put = async (patch: Partial<S["importer"]>) => {
    try {
      setImp(await api<S["importer"]>("/media/importer", { method: "PUT", body: patch }));
      toast(t("common.saved"));
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="card pad stack">
      <h2>{t("media.importer")}</h2>
      {imp.engine !== "animearr" && <p className="warn-text small">{t("media.engine.sonarr")}</p>}
      {/* One control for one decision: what AnimeArr's importer may do. */}
      <div className="seg mode-seg" role="radiogroup" aria-label={t("media.importer")}>
        {(
          [
            ["preview", { allowReal: false, allowRename: false }],
            ["import", { allowReal: true, allowRename: false }],
            ["rename", { allowReal: true, allowRename: true }],
          ] as const
        ).map(([k, patch]) => {
          const on = k === (!imp.allowReal ? "preview" : !imp.allowRename ? "import" : "rename");
          return (
            <button key={k} type="button" role="radio" aria-checked={on} className={on ? "on" : ""} onClick={() => !on && setAsk(patch)}>
              {t(`media.mode.${k}` as I18nKey)}
            </button>
          );
        })}
      </div>
      <p className="muted small">{t(`media.mode.${!imp.allowReal ? "preview" : !imp.allowRename ? "import" : "rename"}.help` as I18nKey)}</p>
      {imp.allowReal && imp.realBudget >= 0 && <Chip tone="warn">{t("media.budget", { n: imp.realBudget })}</Chip>}
      <p className="muted small">{t("media.importerHelp")}</p>
      {ask && (
        <Confirm title={t("media.confirmTitle")} confirmLabel={t("common.save")} danger={!!(ask.allowReal || ask.allowRename || ask.engine === "animearr")} onClose={() => setAsk(null)} onConfirm={async () => (await put(ask), setAsk(null))}>
          <p>{t("media.confirmBody")}</p>
        </Confirm>
      )}
    </div>
  );
}

/** Bulk: which shows have files whose names differ from the naming settings. */
function RenameAll() {
  const [go, setGo] = useState(false);
  const d = useLoad(() => (go ? api<{ series: { tvdbId: number; title: string; count: number }[]; total: number }>("/media/rename-all") : Promise.resolve(null)), [go]);
  return (
    <div className="card pad stack">
      <h2>{t("media.renameAll")}</h2>
      <p className="muted small">{t("media.renameAllHelp")}</p>
      {!go && (
        <button className="small self-start" onClick={() => setGo(true)}>
          {t("media.renameAllCheck")}
        </button>
      )}
      {go && d.error && <ErrorBox error={d.error} retry={d.reload} />}
      {go && !d.data && !d.error && <Spinner label={t("app.loading")} />}
      {d.data && (
        <>
          <p className="small">{t("media.renameAllCount", { files: d.data.total, shows: d.data.series.length })}</p>
          <ul className="small">
            {d.data.series.slice(0, 200).map((x) => (
              <li key={x.tvdbId}>
                <Link to={`/show/${x.tvdbId}?rename=1`}>{x.title}</Link> · {x.count}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

interface RenameItem { fileId: number; from: string; to: string; episodes: string; problem: string | null; sidecars: { from: string; to: string }[] }

/** Show page: "Preview rename" — old → new per file, pick which to apply. */
export function RenamePreview({ tvdbId, onDone, initiallyOpen }: { tvdbId: number; onDone: () => void; initiallyOpen?: boolean }) {
  const toast = useToast();
  const [open, setOpen] = useState(!!initiallyOpen);
  const d = useLoad(() => (open ? api<{ route: "sonarr" | "animearr"; items: RenameItem[] }>(`/series/${tvdbId}/rename`) : Promise.resolve(null)), [open, tvdbId]);
  const [pick, setPick] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => setPick(new Set((d.data?.items ?? []).filter((i) => !i.problem).map((i) => i.fileId))), [d.data]);
  const base = (p: string) => p.split("/").pop();
  return (
    <details className="card pad stack" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>{t("rename.title")}</summary>
      {d.error && <ErrorBox error={d.error} retry={d.reload} />}
      {open && !d.data && !d.error && <Spinner label={t("app.loading")} />}
      {d.data && <p className="muted small">{t(d.data.route === "sonarr" ? "rename.routeSonarr" : "rename.routeOwn")}</p>}
      {d.data && !d.data.items.length && <p className="muted small">{t("rename.none")}</p>}
      {d.data && d.data.items.length > 0 && (
        <>
          <ul className="rename-list">
            {d.data.items.map((i) => (
              <li key={i.fileId}>
                <label className="row small">
                  <input
                    type="checkbox"
                    disabled={!!i.problem}
                    checked={pick.has(i.fileId)}
                    onChange={(e) => setPick((p) => {
                      const n = new Set(p);
                      if (e.target.checked) n.add(i.fileId);
                      else n.delete(i.fileId);
                      return n;
                    })}
                  />
                  <span className="stack">
                    <span className="muted mono">− {base(i.from)}</span>
                    <span className="mono">+ {base(i.to)}</span>
                    {i.sidecars.length > 0 && <span className="muted">{t("rename.sidecars", { n: i.sidecars.length })}</span>}
                    {i.problem && <Chip tone="warn">{i.problem}</Chip>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="row">
            <button
              className="primary small"
              disabled={busy || !pick.size}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await api<{ results: { done: boolean; why: string }[] }>(`/series/${tvdbId}/rename`, { body: { fileIds: [...pick] } });
                  const ok = r.results.filter((x) => x.done).length;
                  toast(t(d.data?.route === "sonarr" ? "rename.doneSonarr" : "rename.done", { ok, total: r.results.length }), ok < r.results.length);
                  await d.reload();
                  onDone();
                } catch (e) {
                  toast((e as Error).message, true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("rename.apply", { n: pick.size })}
            </button>
          </div>
        </>
      )}
    </details>
  );
}

interface PlanItem { source: string; destArr: string; label: string; action: string; sidecars: unknown[]; replaces: string | null; problem: string | null }

/** Show page: manual import of a folder or file (plan first; importing needs real imports switched on). */
export function ManualImport({ tvdbId, onDone, initiallyOpen }: { tvdbId: number; onDone: () => void; initiallyOpen?: boolean }) {
  const toast = useToast();
  const [p, setP] = useState("");
  const [plan, setPlan] = useState<{ items: PlanItem[]; notes: string[]; path: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (dryRun: boolean) => {
    setBusy(true);
    try {
      if (dryRun) setPlan({ ...(await api<{ items: PlanItem[]; notes: string[] }>(`/import/plan`, { body: { tvdbId, path: p } })), path: p });
      else {
        const r = await api<{ results: { label: string; done: boolean; why: string }[] }>(`/import/run`, { body: { tvdbId, path: plan?.path ?? p, dryRun: false, only: plan?.items.filter((i) => !i.problem).map((i) => i.source) } });
        const ok = r.results.filter((x) => x.done).length;
        toast(t("import.done", { ok, total: r.results.length }), ok < r.results.length);
        setPlan(null);
        onDone();
      }
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="card pad stack" open={initiallyOpen}>
      <summary>{t("import.title")}</summary>
      <p className="muted small">{t("import.help")}</p>
      <ImportBrowser selected={p} onSelect={(x) => (setP(x), setPlan(null))} />
      <details className="small">
        <summary>{t("import.typePath")}</summary>
        <input value={p} onChange={(e) => (setP(e.target.value), setPlan(null))} placeholder="/data/completed/animearr/…" aria-label={t("import.path")} className="grow" spellCheck={false} />
      </details>
      <div className="row">
        {p && <span className="mono small grow">{p}</span>}
        <button className="small" disabled={busy || !p.trim()} onClick={() => run(true)}>
          {t("import.preview")}
        </button>
      </div>
      {plan && (
        <>
          {plan.notes.map((n) => (
            <p key={n} className="small warn-text">
              {n}
            </p>
          ))}
          <ul className="rename-list small">
            {plan.items.map((i) => (
              <li key={i.source} className="stack">
                <span>
                  <b>{i.label}</b> · {t(`import.action.${i.action}` as I18nKey)}
                </span>
                <span className="mono muted">{i.destArr || i.source.split(/[\\/]/).pop()}</span>
                {i.replaces && <span className="muted">{t("import.replaces")}</span>}
                {i.problem && <Chip tone="warn">{i.problem}</Chip>}
              </li>
            ))}
          </ul>
          <button className="primary small self-start" disabled={busy || !plan.items.some((i) => !i.problem)} onClick={() => run(false)}>
            {t("import.run")}
          </button>
        </>
      )}
    </details>
  );
}
