import { useState } from "react";
import { api, fmtSize, type Settings as S } from "./api";
import { t, type I18nKey } from "./i18n";
import { Chip, ErrorBox, NumberInput, Spinner, Toggle, useLoad, useToast } from "./ui";

type Upd = (fn: (x: S) => S) => void;
export interface FolderRule { id: string; name: string; metric: "sizeGb" | "items"; threshold: number; action: "pauseUntilUnder" | "pauseUntilCleared" | "pauseAndClean"; resumeAt: number | null; scope: "shows" | "movies" | "both"; applies: "all" | "backlog"; enabled: boolean }
interface Status {
  measure: { byScope: Record<"shows" | "movies" | "both", { sizeGb: number; items: number }>; disk: { totalGb: number; freeGb: number; animearrGb: number; otherGb: number } | null; errors: string[] } | null;
  rules: { id: string; paused: boolean; value: number }[];
  why: string | null;
  presets: Record<string, Omit<FolderRule, "id">[]>;
}
interface Action { step: "retry" | "leftover" | "quarantine"; target: string; why: string; bytes: number; destructive: boolean }

const GB = 1024 ** 3;

/** Settings → Downloads: folder rules (pause grabs when AnimeArr's download folders fill up) and the clean-up. */
export function DownloadRules({ s, upd }: { s: S; upd: Upd }) {
  const d = s.downloads;
  const set = (patch: Partial<S["downloads"]>) => upd((x) => ({ ...x, downloads: { ...x.downloads, ...patch } }));
  const st = useLoad(() => api<Status>("/downloads/status"), []);
  const setRule = (id: string, patch: Partial<FolderRule>) => set({ rules: d.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  const addRules = (list: Omit<FolderRule, "id">[]) => set({ rules: [...d.rules, ...list.map((r, i) => ({ ...r, id: `rule-${Date.now().toString(36)}-${i}` }))] });
  return (
    <div className="stack">
      <div className="card pad stack">
        <h2>{t("dl.now")}</h2>
        {st.error && <ErrorBox error={st.error} retry={st.reload} />}
        {!st.data && !st.error && <Spinner label={t("app.loading")} />}
        {st.data?.measure && (
          <>
            <p className="small">
              {t("dl.counts", { size: st.data.measure.byScope.both.sizeGb.toFixed(1), items: st.data.measure.byScope.both.items, shows: st.data.measure.byScope.shows.sizeGb.toFixed(1), movies: st.data.measure.byScope.movies.sizeGb.toFixed(1) })}
            </p>
            {st.data.measure.disk && <p className="small muted">{t("dl.disk", { free: Math.round(st.data.measure.disk.freeGb), ours: Math.round(st.data.measure.disk.animearrGb), other: Math.round(st.data.measure.disk.otherGb) })}</p>}
            {st.data.measure.errors.map((e) => (
              <p key={e} className="small warn-text">
                {e}
              </p>
            ))}
          </>
        )}
        {st.data && <Chip tone={st.data.why ? "warn" : "good"}>{st.data.why ? t("dl.paused", { why: st.data.why }) : t("dl.running")}</Chip>}
      </div>

      <div className="card pad form">
        <h2>{t("dl.freeTitle")}</h2>
        <label>
          {t("dl.free")}
          <NumberInput value={d.freeSpaceGb} min={1} max={100000} onChange={(v) => set({ freeSpaceGb: v })} label={t("dl.free")} />
          <span className="muted small">{t("dl.freeHelp")}</span>
        </label>
        <Toggle checked={d.excludeSeeding} onChange={(v) => set({ excludeSeeding: v })} label={t("dl.excludeSeeding")} help={t("dl.excludeSeedingHelp")} />
      </div>

      <div className="card pad stack">
        <h2>{t("dl.rules")}</h2>
        <p className="muted small">{t("dl.rulesHelp")}</p>
        {d.rules.map((r) => {
          const live = st.data?.rules.find((x) => x.id === r.id);
          return (
            <div key={r.id} className="card pad form">
              <div className="row between">
                <input value={r.name} onChange={(e) => setRule(r.id, { name: e.target.value })} aria-label={t("dl.name")} />
                {live?.paused && <Chip tone="warn">{t("dl.pausing")}</Chip>}
                <Toggle checked={r.enabled} onChange={(v) => setRule(r.id, { enabled: v })} label={t("dl.enabled")} />
              </div>
              <label>
                {t("dl.when")}
                <span className="row">
                  <select value={r.metric} onChange={(e) => setRule(r.id, { metric: e.target.value as FolderRule["metric"] })}>
                    <option value="sizeGb">{t("dl.metric.sizeGb")}</option>
                    <option value="items">{t("dl.metric.items")}</option>
                  </select>
                  <NumberInput value={r.threshold} min={0} max={1000000} onChange={(v) => setRule(r.id, { threshold: v })} label={t("dl.threshold")} />
                </span>
              </label>
              <label>
                {t("dl.then")}
                <select value={r.action} onChange={(e) => setRule(r.id, { action: e.target.value as FolderRule["action"], resumeAt: e.target.value === "pauseUntilCleared" ? (r.resumeAt ?? Math.round(r.threshold * 0.8)) : r.resumeAt })}>
                  {(["pauseUntilUnder", "pauseUntilCleared", "pauseAndClean"] as const).map((a) => (
                    <option key={a} value={a}>
                      {t(`dl.action.${a}` as I18nKey)}
                    </option>
                  ))}
                </select>
              </label>
              {r.action === "pauseUntilCleared" && (
                <label>
                  {t("dl.resumeAt")}
                  <NumberInput value={r.resumeAt ?? r.threshold} min={0} max={1000000} onChange={(v) => setRule(r.id, { resumeAt: v })} label={t("dl.resumeAt")} />
                </label>
              )}
              <label>
                {t("dl.scope")}
                <select value={r.scope} onChange={(e) => setRule(r.id, { scope: e.target.value as FolderRule["scope"] })}>
                  {(["both", "shows", "movies"] as const).map((x) => (
                    <option key={x} value={x}>
                      {t(`dl.scope.${x}` as I18nKey)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("dl.applies")}
                <select value={r.applies} onChange={(e) => setRule(r.id, { applies: e.target.value as FolderRule["applies"] })}>
                  <option value="all">{t("dl.applies.all")}</option>
                  <option value="backlog">{t("dl.applies.backlog")}</option>
                </select>
              </label>
              <button className="small ghost self-start" onClick={() => set({ rules: d.rules.filter((x) => x.id !== r.id) })}>
                {t("common.delete")}
              </button>
            </div>
          );
        })}
        <div className="row">
          <button className="small" onClick={() => addRules([{ name: t("dl.newRule"), metric: "sizeGb", threshold: 200, action: "pauseUntilUnder", resumeAt: null, scope: "both", applies: "all", enabled: true }])}>
            + {t("dl.addRule")}
          </button>
          {st.data &&
            Object.entries(st.data.presets).map(([k, list]) => (
              <button key={k} className="small" onClick={() => addRules(list)}>
                + {t(`dl.preset.${k}` as I18nKey)}
              </button>
            ))}
        </div>
      </div>

      <Cleanup s={s} set={set} onRan={() => void st.reload()} />
    </div>
  );
}

function Cleanup({ s, set, onRan }: { s: S; set: (p: Partial<S["downloads"]>) => void; onRan: () => void }) {
  const toast = useToast();
  const [plan, setPlan] = useState<{ actions: Action[]; allowDelete: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const d = s.downloads;
  return (
    <div className="card pad stack">
      <h2>{t("dl.cleanup")}</h2>
      <p className="muted small">{t("dl.cleanupHelp")}</p>
      <label className="form">
        {t("dl.cleanupMode")}
        <select value={d.cleanup} onChange={(e) => set({ cleanup: e.target.value as S["downloads"]["cleanup"] })}>
          {(["off", "plan", "auto"] as const).map((x) => (
            <option key={x} value={x}>
              {t(`dl.cleanup.${x}` as I18nKey)}
            </option>
          ))}
        </select>
      </label>
      <Chip tone={d.allowDelete ? "good" : "warn"}>{d.allowDelete ? t("dl.deleteOn") : t("dl.deleteOff")}</Chip>
      <button
        className="small self-start"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            setPlan(await api("/downloads/cleanup/plan", { body: {} }));
            onRan();
          } catch (e) {
            toast((e as Error).message, true);
          } finally {
            setBusy(false);
          }
        }}
      >
        {t("dl.preview")}
      </button>
      {plan && !plan.actions.length && <p className="muted small">{t("dl.nothing")}</p>}
      {plan && plan.actions.length > 0 && (
        <ul className="rename-list small">
          {plan.actions.map((a) => (
            <li key={`${a.step}:${a.target}`} className="stack">
              <span>
                <Chip tone={a.destructive ? "warn" : "info"}>{t(`dl.step.${a.step}` as I18nKey)}</Chip> <span className="mono">{a.target.split("/").pop()}</span> {a.bytes ? `· ${fmtSize(a.bytes)}` : ""}
              </span>
              <span className="muted">{a.why}</span>
            </li>
          ))}
          <li className="muted">{t("dl.total", { gb: (plan.actions.filter((a) => a.destructive).reduce((x, a) => x + a.bytes, 0) / GB).toFixed(1) })}</li>
        </ul>
      )}
      {plan && plan.actions.length > 0 && d.cleanup !== "off" && (
        <button
          className="small self-start"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api<{ results: { ok: boolean }[] }>("/downloads/cleanup/run", { body: {} });
              toast(t("dl.ran", { ok: r.results.filter((x) => x.ok).length, total: r.results.length }));
              setPlan(null);
              onRan();
            } catch (e) {
              toast((e as Error).message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          {plan.allowDelete ? t("dl.run") : t("dl.runSafe")}
        </button>
      )}
    </div>
  );
}
