import { useEffect, useState } from "react";
import { api } from "./api";
import { t, type I18nKey } from "./i18n";
import { Toggle, useToast } from "./ui";

export type SeasonScope = "all" | "first" | "latest" | "recent";
export type EpisodeScope = "all" | "missing" | "future" | "futureAndMissing" | "existing" | "none";
export interface Scope { seasons: SeasonScope; recentN: number; episodes: EpisodeScope; specials: boolean }
const EPISODES: EpisodeScope[] = ["all", "missing", "future", "futureAndMissing", "existing", "none"];
const SEASONS: SeasonScope[] = ["all", "recent", "latest", "first"];

/** The scope fields (Sonarr-style "Monitor" + seasons with a "most recent N" box + specials). */
export function ScopeFields({ value, onChange }: { value: Scope; onChange: (s: Scope) => void }) {
  return (
    <div className="form scope-fields">
      <label>
        {t("scope.monitor")}
        <select value={value.episodes} onChange={(e) => onChange({ ...value, episodes: e.target.value as EpisodeScope })}>
          {EPISODES.map((x) => (
            <option key={x} value={x}>
              {t(`scope.ep.${x}` as I18nKey)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("scope.seasons")}
        <span className="row">
          <select value={value.seasons} onChange={(e) => onChange({ ...value, seasons: e.target.value as SeasonScope })}>
            {SEASONS.map((x) => (
              <option key={x} value={x}>
                {t(`scope.season.${x}` as I18nKey)}
              </option>
            ))}
          </select>
          {value.seasons === "recent" && (
            <input className="num-small" type="number" min={1} max={100} value={value.recentN} aria-label={t("scope.recentN")} onChange={(e) => onChange({ ...value, recentN: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })} />
          )}
        </span>
      </label>
      <Toggle checked={value.specials} onChange={(v) => onChange({ ...value, specials: v })} label={t("scope.specials")} />
    </div>
  );
}

/** Per-show (or bulk) monitoring scope with a live preview and Save. */
export function ScopeEditor({ tvdbIds, previewFor, onSaved }: { tvdbIds: number[]; previewFor?: number; onSaved?: () => void }) {
  const toast = useToast();
  const one = previewFor ?? (tvdbIds.length === 1 ? tvdbIds[0] : null);
  const [value, setValue] = useState<Scope | null>(null);
  const [source, setSource] = useState<string>("default");
  const [preview, setPreview] = useState<{ seasons: number; episodes: number; missing: number; upcoming: number } | null>(null);
  useEffect(() => {
    if (!one) return setValue({ seasons: "all", recentN: 3, episodes: "missing", specials: false });
    void api<{ scope: Scope & { source: string }; preview: typeof preview }>(`/series/${one}/scope`)
      .then((r) => (setValue({ seasons: r.scope.seasons, recentN: r.scope.recentN, episodes: r.scope.episodes, specials: r.scope.specials }), setSource(r.scope.source), setPreview(r.preview)))
      .catch((e) => (toast((e as Error).message, true), setValue({ seasons: "all", recentN: 3, episodes: "missing", specials: false })));
  }, [one]);
  useEffect(() => {
    if (!one || !value) return;
    const id = setTimeout(
      () => void api<{ preview: typeof preview }>(`/series/${one}/scope?seasons=${value.seasons}&recentN=${value.recentN}&episodes=${value.episodes}&specials=${value.specials ? 1 : 0}`).then((r) => setPreview(r.preview)).catch(() => undefined),
      200,
    );
    return () => clearTimeout(id);
  }, [one, value]);
  if (!value) return null;
  const save = async (scope: Scope | null) => {
    try {
      await api("/scope", { method: "PUT", body: { tvdbIds, scope } });
      toast(t("common.saved"));
      setSource(scope ? "show" : "default");
      onSaved?.();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="stack">
      <ScopeFields value={value} onChange={setValue} />
      {preview && <p className="small">{t("scope.preview", { seasons: preview.seasons, episodes: preview.episodes, missing: preview.missing, upcoming: preview.upcoming })}</p>}
      <div className="row">
        <button className="small primary" onClick={() => void save(value)}>
          {tvdbIds.length > 1 ? t("scope.saveMany", { n: tvdbIds.length }) : t("common.save")}
        </button>
        {source === "show" && (
          <button className="small ghost" onClick={() => void save(null)}>
            {t("scope.useDefault")}
          </button>
        )}
        {one && <span className="muted small">{source === "show" ? t("scope.own") : t("scope.default")}</span>}
      </div>
    </div>
  );
}
