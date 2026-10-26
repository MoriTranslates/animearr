import { useState } from "react";
import { api } from "./api";
import { t, type I18nKey } from "./i18n";
import { Chip, Confirm, ErrorBox, ListInput, Spinner, Toggle, useLoad, useToast } from "./ui";

export type WatchMode = "sub" | "dub" | "dual" | "either";
export const MODES: WatchMode[] = ["sub", "dub", "dual", "either"];
export interface LanguageProfile { id: string; name: string; watchMode: WatchMode; subLangs: string[]; dubLangs: string[]; softOnly: boolean; preferUncensored: boolean; protocolOrder: ("usenet" | "torrent")[]; resolution: number; sizePreset?: SizePreset }
export type SizePreset = "lean" | "balanced" | "best";
export const SIZE_PRESETS: SizePreset[] = ["lean", "balanced", "best"];

/** Settings → Profiles: named language profiles; one is the default for every show without its own choice. */
export function ProfilesEditor() {
  const toast = useToast();
  const d = useLoad(() => api<{ profiles: LanguageProfile[]; defaultProfileId: string }>("/profiles"), []);
  const [del, setDel] = useState<LanguageProfile | null>(null);
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={t("app.loading")} />;
  return (
    <div className="stack">
      <p className="muted small">{t("profiles.intro")}</p>
      {d.data.profiles.map((p) => (
        <ProfileCard key={`${p.id}:${JSON.stringify(p)}`} p={p} isDefault={p.id === d.data!.defaultProfileId} onSaved={d.reload} onDelete={() => setDel(p)} />
      ))}
      <button
        className="self-start"
        onClick={async () => {
          try {
            await api("/profiles", { body: { name: t("profiles.newName") } });
            await d.reload();
          } catch (e) {
            toast((e as Error).message, true);
          }
        }}
      >
        + {t("profiles.add")}
      </button>
      {del && (
        <Confirm
          danger
          title={t("profiles.deleteTitle", { name: del.name })}
          confirmLabel={t("common.delete")}
          onClose={() => setDel(null)}
          onConfirm={async () => {
            try {
              await api(`/profiles/${del.id}`, { method: "DELETE" });
              setDel(null);
              await d.reload();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          <p>{t("profiles.deleteBody")}</p>
        </Confirm>
      )}
    </div>
  );
}

function ProfileCard({ p: initial, isDefault, onSaved, onDelete }: { p: LanguageProfile; isDefault: boolean; onSaved: () => void; onDelete: () => void }) {
  const toast = useToast();
  const [p, setP] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const set = (patch: Partial<LanguageProfile>) => (setP({ ...p, ...patch }), setDirty(true));
  const save = async (makeDefault = false) => {
    try {
      const saved = await api<LanguageProfile>(`/profiles/${p.id}`, { method: "PUT", body: { ...p, makeDefault } });
      setP(saved);
      setDirty(false);
      toast(t("common.saved"));
      onSaved();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="card pad stack">
      <div className="row between">
        <input className="grow profile-name" value={p.name} onChange={(e) => set({ name: e.target.value })} aria-label={t("profiles.name")} />
        {isDefault ? <Chip tone="accent">★ {t("profiles.default")}</Chip> : null}
      </div>
      <fieldset className="modes">
        <legend className="small muted">{t("profiles.watchMode")}</legend>
        {MODES.map((m) => (
          <label key={m} className={`mode-option${p.watchMode === m ? " on" : ""}`}>
            <input type="radio" name={`mode-${p.id}`} checked={p.watchMode === m} onChange={() => set({ watchMode: m })} />
            <span>
              <strong>{t(`mode.${m}` as I18nKey)}</strong>
              <small className="muted">{t(`mode.${m}.help` as I18nKey)}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="form">
        <label>
          {t("settings.profile.subs")}
          <ListInput value={p.subLangs} onChange={(v) => set({ subLangs: v })} label={t("settings.profile.subs")} placeholder="en" />
        </label>
        <label>
          {t("profiles.dubLangs")}
          <ListInput value={p.dubLangs} onChange={(v) => set({ dubLangs: v })} label={t("profiles.dubLangs")} placeholder="en" />
        </label>
        <label>
          {t("settings.profile.protocol")}
          <select value={p.protocolOrder.join(",")} onChange={(e) => set({ protocolOrder: e.target.value.split(",") as ("usenet" | "torrent")[] })}>
            <option value="usenet,torrent">Usenet → Torrent</option>
            <option value="torrent,usenet">Torrent → Usenet</option>
          </select>
        </label>
        <label>
          {t("settings.profile.resolution")}
          <select value={p.resolution} onChange={(e) => set({ resolution: Number(e.target.value) })}>
            {[2160, 1080, 720, 480].map((r) => (
              <option key={r} value={r}>
                {r}p
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("size.preset")}
          <select value={p.sizePreset ?? "lean"} onChange={(e) => set({ sizePreset: e.target.value as SizePreset })}>
            {SIZE_PRESETS.map((s) => (
              <option key={s} value={s}>
                {t(`size.${s}` as I18nKey)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted small">{t(`size.${p.sizePreset ?? "lean"}.help` as I18nKey)}</p>
      <p className="muted small">{t("settings.profile.help")}</p>
      <Toggle checked={p.softOnly} onChange={(v) => set({ softOnly: v })} label={t("settings.profile.softOnly")} />
      <Toggle checked={p.preferUncensored} onChange={(v) => set({ preferUncensored: v })} label={t("settings.profile.uncensored")} />
      <div className="row">
        <button className="primary" disabled={!dirty} onClick={() => save()}>
          {t("common.save")}
        </button>
        {!isDefault && (
          <button onClick={() => save(true)} disabled={dirty} title={dirty ? t("profiles.saveFirst") : undefined}>
            {t("profiles.makeDefault")}
          </button>
        )}
        {dirty && (
          <button className="ghost" onClick={() => (setP(initial), setDirty(false))}>
            {t("common.cancel")}
          </button>
        )}
        {!isDefault && (
          <button className="danger" onClick={onDelete}>
            {t("common.delete")}
          </button>
        )}
      </div>
    </div>
  );
}

/** Per-show "Watch as" control: profile + watch mode override (empty = follow the default). */
export function WatchAs({ tvdbId, prefs, effective, onChanged, endpoint }: { tvdbId: number; prefs: { profile_id: string | null; watch_mode: WatchMode | null; size_preset?: SizePreset | null }; effective: { name: string; watchMode: WatchMode; profileMode?: WatchMode; sizePreset?: SizePreset }; onChanged: () => void; endpoint?: string }) {
  const toast = useToast();
  const d = useLoad(() => api<{ profiles: LanguageProfile[]; defaultProfileId: string }>("/profiles"), []);
  const save = async (profileId: string | null, watchMode: WatchMode | null, sizePreset?: SizePreset | null) => {
    try {
      await api(endpoint ?? `/series/${tvdbId}/prefs`, { method: "PUT", body: { profileId, watchMode, ...(sizePreset !== undefined ? { sizePreset } : {}) } });
      toast(t("common.saved"));
      onChanged();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="watch-as row small">
      <span className="muted">{t("profiles.watchAs")}</span>
      <select value={prefs.profile_id ?? ""} onChange={(e) => save(e.target.value || null, prefs.watch_mode)} aria-label={t("profiles.profile")}>
        <option value="">{t("profiles.followDefault")}</option>
        {d.data?.profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <select value={prefs.watch_mode ?? ""} onChange={(e) => save(prefs.profile_id, (e.target.value || null) as WatchMode | null)} aria-label={t("profiles.watchMode")}>
        <option value="">{t("profiles.profileMode", { mode: t(`mode.${effective.profileMode ?? effective.watchMode}` as I18nKey) })}</option>
        {MODES.map((m) => (
          <option key={m} value={m}>
            {t(`mode.${m}` as I18nKey)}
          </option>
        ))}
      </select>
      {!endpoint && (
        <select value={prefs.size_preset ?? ""} onChange={(e) => save(prefs.profile_id, prefs.watch_mode, (e.target.value || null) as SizePreset | null)} aria-label={t("size.preset")}>
          <option value="">{t("size.profileDefault")}</option>
          {SIZE_PRESETS.map((s) => (
            <option key={s} value={s}>
              {t(`size.${s}` as I18nKey)}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
