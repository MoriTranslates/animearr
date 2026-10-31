import { useState } from "react";
import { Link } from "./App";
import { api } from "./api";
import { copyText } from "./errors";
import { t, type I18nKey } from "./i18n";
import { Chip, ErrorBox, Spinner, Toggle, useLoad, useToast } from "./ui";

export type GoalId = "good" | "high" | "collector";
export const GOAL_IDS: GoalId[] = ["good", "high", "collector"];
interface GoalInfo { asked: boolean; goal: GoalId; goals: { id: GoalId; label: string; help: string }[]; tdarrGuard: string }

/**
 * The quality-goal question: in the setup wizard (preferences step), as a one-time card on Home for existing installs,
 * and at the top of Settings → Profiles. "Aim high" is pre-selected; the answer is the default profile's goal.
 */
export function QualityGoalCard({ compact, onSaved }: { compact?: boolean; onSaved?: () => void }) {
  const toast = useToast();
  const d = useLoad(() => api<GoalInfo>("/quality/goal"), []);
  const [pick, setPick] = useState<GoalId | null>(null);
  const [tdarr, setTdarr] = useState(false);
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={t("app.loading")} />;
  const chosen = pick ?? (d.data.asked ? d.data.goal : "high");
  const save = async () => {
    try {
      const r = await api<{ label: string }>("/quality/goal", { method: "PUT", body: { goal: chosen } });
      toast(t("goal.saved", { label: r.label }));
      await d.reload();
      onSaved?.();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="card stack">
      <b>{t("goal.title")}</b>
      <p className="muted small">{compact ? t("goal.askCard") : t("goal.intro")}</p>
      <div className="stack" role="radiogroup" aria-label={t("goal.title")}>
        {GOAL_IDS.map((g) => (
          <label key={g} className="row">
            <input type="radio" name="quality-goal" checked={chosen === g} onChange={() => setPick(g)} />
            <span>
              <b>{t(`goal.${g}` as I18nKey)}</b> {g === "high" && <Chip tone="accent">{t("goal.recommended")}</Chip>}
              <br />
              <span className="muted small">{t(`goal.${g}.help` as I18nKey)}</span>
            </span>
          </label>
        ))}
      </div>
      <Toggle checked={tdarr} onChange={setTdarr} label={t("goal.tdarr")} />
      {tdarr && (
        <div className="stack">
          <p className="muted small">{t("goal.tdarrTip")}</p>
          <pre className="small">{d.data.tdarrGuard}</pre>
          <button className="self-start" onClick={async () => (await copyText(d.data!.tdarrGuard)) && toast(t("goal.copied"))}>
            {t("goal.copy")}
          </button>
        </div>
      )}
      <div className="row">
        <button className="primary" onClick={() => void save()} disabled={d.data.asked && chosen === d.data.goal}>
          {t("goal.save")}
        </button>
      </div>
    </div>
  );
}

/** Home: the goal question once, for installs that existed before quality goals. */
export function QualityGoalNudge() {
  const d = useLoad(() => api<GoalInfo>("/quality/goal"), []);
  const [done, setDone] = useState(false);
  if (!d.data || d.data.asked || done) return null;
  return <QualityGoalCard compact onSaved={() => setDone(true)} />;
}

interface UpgradeView {
  mode: "off" | "auto";
  paused: boolean;
  seasonsPerDay: number;
  grabsToday: number;
  plan: { planAt: number | null; started: boolean; startsAt: number | null; live: boolean };
  items: { tvdbId: number; title: string; season: number; goal: string; target: string; episodes: number; now: string[]; why: string; state: string; stateWhy: string; release: string | null; lastAt: number | null }[];
  recent: { tvdbId: number; title: string; season: number; state: string; why: string; at: number }[];
}

/** Audit: the upgrade watcher's plan, its state per season, the pause switch and "Start now". */
export function QualityUpgradesPanel() {
  const toast = useToast();
  const d = useLoad(() => api<UpgradeView>("/quality/upgrades"), []);
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={t("app.loading")} />;
  const v = d.data;
  const act = async (path: string, method: "POST" | "PUT", body?: unknown) => {
    try {
      await api(path, { method, body });
      await d.reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="stack">
      <p className="muted small">{t("upq.intro")}</p>
      {v.mode === "off" ? (
        <p className="muted">{t("upq.off")}</p>
      ) : (
        <>
          {!v.plan.live && (
            <div className="card row">
              <span>{t("upq.plan", { n: v.items.length, when: v.plan.startsAt ? new Date(v.plan.startsAt).toLocaleString() : t("upq.planLater"), perDay: v.seasonsPerDay })}</span>
              <button className="primary" onClick={() => void act("/quality/upgrades/start", "POST")}>
                {t("upq.startNow")}
              </button>
            </div>
          )}
          <div className="row">
            <button onClick={() => void act("/quality/upgrades", "PUT", { paused: !v.paused })}>{v.paused ? t("upq.resume") : t("upq.pause")}</button>
            <span className="muted small">{v.paused ? t("upq.paused") : t("upq.budget", { grabs: v.grabsToday, perDay: v.seasonsPerDay })}</span>
          </div>
        </>
      )}
      {!v.items.length && <p className="muted">{t("upq.none")}</p>}
      <ul className="stack">
        {v.items.map((i) => (
          <li key={`${i.tvdbId}-${i.season}`} className="card">
            <b>
              <Link to={`/show/${i.tvdbId}`}>{i.title}</Link> S{String(i.season).padStart(2, "0")}
            </b>{" "}
            <Chip tone={i.state === "grabbed" ? "good" : i.state === "found" ? "warn" : "info"}>{i.state}</Chip>
            <br />
            <span className="small">{t("upq.row", { goal: i.goal, episodes: i.episodes, now: i.now.join(", ") })}</span>
            <br />
            <span className="muted small">{i.stateWhy}</span>
          </li>
        ))}
      </ul>
      {!!v.recent.length && (
        <>
          <b>{t("upq.recent")}</b>
          <ul className="stack">
            {v.recent.map((r) => (
              <li key={`${r.tvdbId}-${r.season}`} className="muted small">
                {r.title} S{String(r.season).padStart(2, "0")}: {r.why}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

interface ShowQuality { goal: GoalId; goalLabel: string; reencode: "tdarr" | "keep"; locks: { show: boolean; seasons: number[] }; seadex: { season: number; picks: { group: string; best: boolean; dualAudio: boolean; tracker: string }[] }[] }

/** Show page: the show's goal, SeaDex's picks per season and the keep-as-is locks. */
export function ShowQuality({ tvdbId }: { tvdbId: number }) {
  const toast = useToast();
  const d = useLoad(() => api<ShowQuality>(`/series/${tvdbId}/quality`), [tvdbId]);
  const [rename, setRename] = useState<number | null>(null);
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={t("app.loading")} />;
  const q = d.data;
  const lock = async (season: number | null, keep: boolean) => {
    try {
      const r = await api<{ rename: number | null }>(`/series/${tvdbId}/keep`, { method: "PUT", body: { season, keep } });
      setRename(r.rename);
      await d.reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="stack">
      <p className="small">
        {t("profile.goal")}: <b>{q.goalLabel}</b>
      </p>
      <b>{t("seadex.title")}</b>
      {q.seadex.every((s) => !s.picks.length) ? (
        <p className="muted small">{t("seadex.none")}</p>
      ) : (
        <ul className="stack">
          {q.seadex
            .filter((s) => s.picks.length)
            .map((s) => (
              <li key={s.season} className="small">
                {t("keep.season", { n: s.season })}:{" "}
                {s.picks.map((p) => (
                  <Chip key={`${p.group}-${p.best}-${p.dualAudio}`} tone={p.best ? "good" : "info"}>
                    {p.group} · {p.best ? t("seadex.best") : t("seadex.alt")}
                    {p.dualAudio ? ` · ${t("seadex.dual")}` : ""}
                  </Chip>
                ))}
              </li>
            ))}
        </ul>
      )}
      <b>{t("keep.title")}</b>
      <p className="muted small">{t("keep.help")}</p>
      <Toggle checked={q.locks.show} onChange={(v) => void lock(null, v)} label={t("keep.show")} />
      {!q.locks.show &&
        q.seadex.map((s) => <Toggle key={s.season} checked={q.locks.seasons.includes(s.season)} onChange={(v) => void lock(s.season, v)} label={t("keep.season", { n: s.season })} />)}
      {!!rename && <p className="small">{t("keep.rename", { n: rename })}</p>}
    </div>
  );
}
