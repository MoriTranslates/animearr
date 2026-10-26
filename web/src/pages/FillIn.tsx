import { api } from "../api";
import { Link, navigate } from "../App";
import { AutomateTabs } from "./Managed";
import { t, type I18nKey } from "../i18n";
import { Chip, Cover, dateTime, Empty, ErrorBox, Menu, Spinner, Toggle, useLoad, usePageTitle, useToast } from "../ui";

interface Item { tvdbId: number; title: string; cover: string | null; state: "queued" | "active" | "done" | "skipped"; wave: number | null; position: number; startMissing: number | null; missing: number | null; note: string; activatedAt: number | null; doneAt: number | null; scope: { seasons: string; recentN: number; episodes: string; specials: boolean } }
interface View { settings: { paused: boolean; waveSize: number; advancePct: number; stallDays: number }; backlogEnabled: boolean; perHour: number; remaining: number; etaHours: number; items: Item[] }

const TONE = { active: "accent", queued: "info", done: "good", skipped: "warn" } as const;

/** The staged fill-in queue: waves, progress, ETA; pause, reorder, skip. */
export function FillIn() {
  usePageTitle(t("fill.title"));
  const toast = useToast();
  const d = useLoad(() => api<View>("/fillin"), []);
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={t("app.loading")} />;
  const v = d.data;
  const act = async (tvdbId: number, action: string) => {
    try {
      await api(`/fillin/${tvdbId}`, { method: "PUT", body: { action } });
      await d.reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const setPaused = async (paused: boolean) => {
    try {
      await api("/settings", { method: "PUT", body: { fillIn: { ...v.settings, paused } } });
      await d.reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const groups: [string, Item[]][] = [
    ["active", v.items.filter((i) => i.state === "active")],
    ["queued", v.items.filter((i) => i.state === "queued")],
    ["done", v.items.filter((i) => i.state === "done" || i.state === "skipped")],
  ];
  return (
    <section className="stack">
      <div className="row between">
        <h1>{t("fill.title")}</h1>
        <AutomateTabs current="fillin" />
      </div>
      <p className="muted">{t("fill.intro", { size: v.settings.waveSize, pct: v.settings.advancePct, days: v.settings.stallDays })}</p>
      {!v.backlogEnabled && <p className="banner warn">{t("fill.backlogOff")} <Link to="/settings?tab=safety">{t("nav.settings")} →</Link></p>}
      <div className="card pad stack">
        <p>{t("fill.eta", { n: v.remaining, per: v.perHour, h: v.etaHours, d: Math.ceil(v.etaHours / 24) })}</p>
        <Toggle checked={v.settings.paused} onChange={(x) => void setPaused(x)} label={t("fill.paused")} help={t("fill.pausedHelp")} />
      </div>
      {!v.items.length && <Empty icon="⇣" action={{ label: t("managed.choose"), run: () => navigate("/shows") }}>{t("fill.empty")}</Empty>}
      {groups.map(
        ([k, list]) =>
          !!list.length && (
            <div key={k} className="stack">
              <h2>{t(`fill.group.${k}` as I18nKey)}</h2>
              <ul className="list plain">
                {list.map((i) => {
                  const pct = i.startMissing ? Math.max(0, Math.min(100, Math.round(((i.startMissing - (i.missing ?? 0)) / i.startMissing) * 100))) : null;
                  return (
                    <li key={i.tvdbId} className="card pad row fill-row">
                      <Cover src={i.cover} alt={i.title} size="sm" />
                      <div className="stack grow">
                        <Link to={`/show/${i.tvdbId}`} className="strong clamp2">
                          {i.title}
                        </Link>
                        <div className="chips">
                          <Chip tone={TONE[i.state]}>
                            {t(`fill.state.${i.state}` as I18nKey)}
                            {i.wave ? ` · ${t("fill.wave", { n: i.wave })}` : ""}
                          </Chip>
                          <Chip>{t(`scope.ep.${i.scope.episodes}` as I18nKey)} · {i.scope.seasons === "recent" ? t("scope.recentShort", { n: i.scope.recentN }) : t(`scope.season.${i.scope.seasons}` as I18nKey)}</Chip>
                        </div>
                        <p className="small">
                          {i.state === "active" && pct !== null ? t("fill.progress", { pct, missing: i.missing ?? 0, start: i.startMissing ?? 0 }) : t("fill.missing", { n: i.missing ?? 0 })}
                          {i.note ? ` · ${i.note}` : ""}
                          {i.doneAt ? ` · ${dateTime(i.doneAt)}` : ""}
                        </p>
                        {i.state === "active" && pct !== null && (
                          <div className="progressbar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                            <div style={{ width: `${pct}%` }} />
                          </div>
                        )}
                      </div>
                      <Menu
                        label={`${i.title}: ${t("common.moreActions")}`}
                        items={[
                          { label: t("fill.up"), onSelect: () => void act(i.tvdbId, "up"), hidden: i.state !== "queued" },
                          { label: t("fill.down"), onSelect: () => void act(i.tvdbId, "down"), hidden: i.state !== "queued" },
                          { label: t("fill.skip"), onSelect: () => void act(i.tvdbId, "skip"), hidden: !(i.state === "queued" || i.state === "active") },
                          { label: t("fill.requeue"), onSelect: () => void act(i.tvdbId, "requeue"), hidden: !(i.state === "skipped" || i.state === "done") },
                          { label: t("fill.remove"), onSelect: () => void act(i.tvdbId, "remove"), danger: true },
                        ]}
                      />
                    </li>
                  );
                })}
              </ul>
            </div>
          ),
      )}
    </section>
  );
}
