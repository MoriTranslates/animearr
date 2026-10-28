import { useState } from "react";
import { api } from "./api";
import { navigate } from "./App";
import { t, type I18nKey } from "./i18n";
import type { LanguageProfile } from "./profiles";
import { Confirm, ErrorText, ListInput, Modal, NumberInput, SecretInput, Toggle, useLoad, useToast } from "./ui";

/** Dialogs and controls for Settings → Indexers / Download clients: added clients, direct indexers, the catalogue. */

type Protocol = "usenet" | "torrent";
/** The "+ Add" client types, their display names, protocol, address hint and help text. */
export type ExtraType = "nzbget" | "transmission" | "deluge" | "rtorrent" | "blackhole-usenet" | "blackhole-torrent";
export const isBlackholeType = (t: string) => t === "blackhole-usenet" || t === "blackhole-torrent";
/** What a blackhole can't do (its card, and the confirmation before turning it on). */
export const BLACKHOLE_LOSES = (type: ExtraType): I18nKey[] => ["clients.bh.lose.progress", "clients.bh.lose.partial", "clients.bh.lose.stall", "clients.bh.lose.control", "clients.bh.lose.slower", "clients.bh.lose.names", ...(type === "blackhole-usenet" ? (["clients.bh.lose.usenet"] as I18nKey[]) : (["clients.bh.lose.magnets"] as I18nKey[]))];
export const CLIENT_INFO: Record<ExtraType, { name: string; protocol: "usenet" | "torrent"; placeholder: string; help: I18nKey; labelHelp: I18nKey; username: boolean }> = {
  nzbget: { name: "NZBGet", protocol: "usenet", placeholder: "http://192.168.1.10:6789", help: "clients.nzbgetHelp", labelHelp: "conn.categoryHelp", username: true },
  transmission: { name: "Transmission", protocol: "torrent", placeholder: "http://192.168.1.10:9091", help: "clients.transmissionHelp", labelHelp: "clients.labelHelp", username: true },
  deluge: { name: "Deluge", protocol: "torrent", placeholder: "http://192.168.1.10:8112", help: "clients.delugeHelp", labelHelp: "clients.delugeLabelHelp", username: false },
  rtorrent: { name: "rTorrent", protocol: "torrent", placeholder: "http://192.168.1.10/RPC2", help: "clients.rtorrentHelp", labelHelp: "clients.rtorrentLabelHelp", username: true },
  "blackhole-usenet": { name: "Usenet Blackhole", protocol: "usenet", placeholder: "", help: "clients.bh.usenetHelp", labelHelp: "clients.bh.note", username: false },
  "blackhole-torrent": { name: "Torrent Blackhole", protocol: "torrent", placeholder: "", help: "clients.bh.torrentHelp", labelHelp: "clients.bh.note", username: false },
};
export interface ExtraClient { watchFolder?: string; completedFolder?: string; saveMagnets?: boolean; timeoutHours?: number; id?: string; type: ExtraType; name: string; url: string; username: string; password: string; category: string; priority: number; enabled: boolean; removeCompleted: boolean; pathMappings: { from: string; to: string }[] }
export interface DirectIndexer { id?: string; kind: "newznab" | "torznab" | "nyaa" | "rss" | "subsplease"; protocol: Protocol; name: string; url: string; apiPath: string; apiKey: string; categories: number[]; priority: number; enabled: boolean; seedRatio: number | null; seedTimeMin: number | null; tags: string[]; catalogId: string | null }
export interface CatalogEntry { id: string; name: string; kind: DirectIndexer["kind"]; protocol: Protocol; url: string; apiPath: string; categories: number[]; needsKey: boolean; access: string; visibility: string; language: string; goodFor: string; recommended: boolean; addable?: boolean; viaProwlarr?: boolean; checked: { date: string; status: string; note: string } }

// ---------------------------------------------------------------- protocol priority + delays (top of both tabs)

/** "Prefer Usenet / Prefer torrents / No preference" (the default profile) and the Sonarr-style delays. */
export function ProtocolBar({ onChanged }: { onChanged?: () => void }) {
  const toast = useToast();
  const prof = useLoad(() => api<{ profiles: LanguageProfile[]; defaultProfileId: string }>("/profiles"), []);
  const set = useLoad(() => api<{ protocol: { usenetDelayMin: number; torrentDelayMin: number } }>("/settings"), []);
  const p = prof.data?.profiles.find((x) => x.id === prof.data!.defaultProfileId);
  const value = p ? (p.noProtocolPreference ? "none" : p.protocolOrder[0]) : "";
  const saveDelay = async (k: "usenetDelayMin" | "torrentDelayMin", v: number) => {
    try {
      await api("/settings", { method: "PUT", body: { protocol: { ...(set.data?.protocol ?? { usenetDelayMin: 0, torrentDelayMin: 0 }), [k]: v } } });
      await set.reload();
      toast(t("common.saved"));
      onChanged?.();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="proto-bar card">
      <label className="field">
        {t("proto.title")}
        <select
          value={value}
          disabled={!p}
          onChange={async (e) => {
            try {
              const v = e.target.value;
              await api(`/profiles/${p!.id}`, { method: "PUT", body: v === "none" ? { noProtocolPreference: true } : { noProtocolPreference: false, protocolOrder: v === "usenet" ? ["usenet", "torrent"] : ["torrent", "usenet"] } });
              await prof.reload();
              toast(t("common.saved"));
              onChanged?.();
            } catch (err) {
              toast((err as Error).message, true);
            }
          }}
        >
          <option value="usenet">{t("proto.preferUsenet")}</option>
          <option value="torrent">{t("proto.preferTorrent")}</option>
          <option value="none">{t("proto.noPreference")}</option>
        </select>
        <span className="muted small">
          {t("proto.help", { profile: p?.name ?? "" })}{" "}
          <button className="linklike" onClick={() => navigate("/settings?tab=profile")}>
            {t("proto.perProfile")}
          </button>
        </span>
      </label>
      {set.data && (
        <>
          <label className="field">
            {t("proto.usenetDelay")}
            <NumberInput value={set.data.protocol?.usenetDelayMin ?? 0} min={0} max={10080} onChange={(v) => void saveDelay("usenetDelayMin", v)} label={t("proto.usenetDelay")} />
          </label>
          <label className="field">
            {t("proto.torrentDelay")}
            <NumberInput value={set.data.protocol?.torrentDelayMin ?? 0} min={0} max={10080} onChange={(v) => void saveDelay("torrentDelayMin", v)} label={t("proto.torrentDelay")} />
          </label>
          <p className="muted small proto-delay-help">{t("proto.delayHelp")}</p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- added download clients (NZBGet, Transmission)

export function ExtraClientDialog({ initial, onClose, onSaved }: { initial: ExtraClient; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [c, setC] = useState<ExtraClient>(initial);
  const [res, setRes] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState(false);
  const set = (patch: Partial<ExtraClient>) => setC((x) => ({ ...x, ...patch }));
  const info = CLIENT_INFO[c.type];
  const name = info.name;
  const bh = isBlackholeType(c.type);
  // A blackhole is turned on only after its Test passed (here) and the user confirmed what it can't do.
  const [tested, setTested] = useState(false);
  const [confirmOn, setConfirmOn] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={c.id ? c.name : t("clients.addTitle", { name })} onClose={onClose}>
      <p className="muted small">{t(info.protocol === "usenet" ? "conn.role.usenetClient" : "conn.role.torrentClient")} · {t(info.help)}</p>
      {bh && <BlackholeLoses type={c.type} />}
      {bh ? (
        <div className="form">
          <label>
            {t("clients.name")}
            <input value={c.name} onChange={(e) => set({ name: e.target.value })} />
          </label>
          <label>
            {t("clients.bh.watch")}
            <input value={c.watchFolder ?? ""} onChange={(e) => set({ watchFolder: e.target.value })} placeholder="/data/blackhole/watch" />
            <span className="muted small">{t(c.type === "blackhole-usenet" ? "clients.bh.watchHelpNzb" : "clients.bh.watchHelpTorrent")}</span>
          </label>
          <label>
            {t("clients.bh.completed")}
            <input value={c.completedFolder ?? ""} onChange={(e) => set({ completedFolder: e.target.value })} placeholder="/data/blackhole/completed" />
            <span className="muted small">{t("clients.bh.completedHelp")}</span>
          </label>
          <label>
            {t("clients.bh.timeout")}
            <NumberInput value={c.timeoutHours ?? 24} min={1} max={720} onChange={(v) => set({ timeoutHours: v })} label={t("clients.bh.timeout")} />
            <span className="muted small">{t("clients.bh.timeoutHelp")}</span>
          </label>
          <label>
            {t("clients.priority")}
            <NumberInput value={c.priority} min={1} max={50} onChange={(v) => set({ priority: v })} label={t("clients.priority")} />
            <span className="muted small">{t("clients.bh.priorityHelp")}</span>
          </label>
          {c.type === "blackhole-torrent" && <Toggle checked={!!c.saveMagnets} onChange={(v) => set({ saveMagnets: v })} label={t("clients.bh.saveMagnets")} />}
          {c.type === "blackhole-torrent" && <p className="muted small">{t("clients.bh.saveMagnetsHelp")}</p>}
        </div>
      ) : (
      <div className="form">
        <label>
          {t("clients.name")}
          <input value={c.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label>
          {t("settings.url")}
          <input value={c.url} onChange={(e) => set({ url: e.target.value })} placeholder={info.placeholder} />
        </label>
        {info.username && (
          <label>
            {t("settings.username")}
            <input value={c.username} onChange={(e) => set({ username: e.target.value })} autoComplete="off" />
          </label>
        )}
        <label className="field">
          {t("settings.password")}
          <SecretInput value={c.password} onChange={(v) => set({ password: v })} label={t("settings.password")} />
        </label>
        <label>
          {t(info.protocol === "usenet" ? "settings.category" : "clients.label")}
          <input value={c.category} onChange={(e) => set({ category: e.target.value })} />
          <span className="muted small">{t(info.labelHelp)}</span>
        </label>
        <label>
          {t("clients.priority")}
          <NumberInput value={c.priority} min={1} max={50} onChange={(v) => set({ priority: v })} label={t("clients.priority")} />
          <span className="muted small">{t("clients.priorityHelp")}</span>
        </label>
      </div>
      )}
      {bh && !c.enabled && !tested && !initial.enabled && <p className="muted small">{t("clients.bh.testFirst")}</p>}
      <Toggle
        checked={c.enabled}
        disabled={bh && !c.enabled && !tested && !initial.enabled}
        onChange={(v) => (bh && v && !initial.enabled ? setConfirmOn(true) : set({ enabled: v }))}
        label={t("clients.enabled")}
      />
      {confirmOn && (
        <Confirm title={t("clients.bh.enableTitle", { name: c.name || name })} confirmLabel={t("clients.bh.enableConfirm")} onClose={() => setConfirmOn(false)} onConfirm={async () => (set({ enabled: true }), setConfirmOn(false))}>
          <BlackholeLoses type={c.type} />
        </Confirm>
      )}
      <details className="stack" hidden={bh}>
        <summary className="small">{t("clients.pathMappings")}</summary>
        <p className="muted small">{t("clients.pathMappingsHelp")}</p>
        {c.pathMappings.map((m, i) => (
          <div key={i} className="row">
            <input className="grow" value={m.from} placeholder={t("settings.paths.from")} aria-label={t("settings.paths.from")} onChange={(e) => set({ pathMappings: c.pathMappings.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)) })} />
            <span aria-hidden="true">→</span>
            <input className="grow" value={m.to} placeholder={t("settings.paths.to")} aria-label={t("settings.paths.to")} onChange={(e) => set({ pathMappings: c.pathMappings.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)) })} />
            <button className="small ghost" onClick={() => set({ pathMappings: c.pathMappings.filter((_, j) => j !== i) })}>
              {t("common.delete")}
            </button>
          </div>
        ))}
        <button className="small self-start" onClick={() => set({ pathMappings: [...c.pathMappings, { from: "", to: "" }] })}>
          {t("common.add")}
        </button>
      </details>
      {res && <p className={`small ${res.ok ? "good-text" : "warn-text"}`}>{res.ok ? res.text : <ErrorText msg={res.text} />}</p>}
      <div className="row between">
        {c.id ? (
          <button className="danger" disabled={busy} onClick={() => setDel(true)}>
            {t("common.delete")}
          </button>
        ) : (
          <span />
        )}
        <div className="row">
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                try {
                  const r = await api<{ version: string; categoryExists?: boolean }>("/clients/test", { body: c });
                  if (bh) setTested(true);
                  setRes({ ok: r.categoryExists !== false, text: t("settings.testOk", { app: c.name || name, version: r.version }) + (r.categoryExists === false ? ` · ${t("settings.categoryMissing", { cat: c.category, app: name })}` : "") });
                } catch (e) {
                  setRes({ ok: false, text: (e as Error).message });
                }
              })
            }
          >
            {t("common.test")}
          </button>
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api(c.id ? `/clients/${c.id}` : "/clients", { method: c.id ? "PUT" : "POST", body: c });
                toast(t("common.saved"));
                onSaved();
                onClose();
              })
            }
          >
            {t("common.save")}
          </button>
        </div>
      </div>
      {del && (
        <Confirm
          danger
          title={t("conn.deleteTitle", { name: c.name })}
          confirmLabel={t("common.delete")}
          onClose={() => setDel(false)}
          onConfirm={async () => {
            try {
              await api(`/clients/${c.id}`, { method: "DELETE" });
              toast(t("conn.deleted", { name: c.name }));
              onSaved();
              onClose();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          <p>{t("conn.deleteBody.other")}</p>
        </Confirm>
      )}
    </Modal>
  );
}

export const newClient = (type: ExtraType): ExtraClient =>
  isBlackholeType(type)
    ? { type, name: CLIENT_INFO[type].name, url: "", username: "", password: "", category: "animearr", priority: 50, enabled: false, removeCompleted: false, pathMappings: [], watchFolder: "", completedFolder: "", saveMagnets: false, timeoutHours: 24 }
    : { type, name: CLIENT_INFO[type].name, url: "", username: "", password: "", category: "animearr", priority: 1, enabled: true, removeCompleted: true, pathMappings: [] };

/** "What you lose with Blackhole": the plain list on its card and in the confirmation before turning it on. */
export function BlackholeLoses({ type }: { type: ExtraType }) {
  return (
    <div className="stack small">
      <p className="muted">{t("clients.bh.note")}</p>
      <p className="strong">{t("clients.bh.loseTitle")}</p>
      <ul className="plain">
        {BLACKHOLE_LOSES(type).map((k) => (
          <li key={k}>· {t(k)}</li>
        ))}
      </ul>
    </div>
  );
}

/** Priority + enabled for the SABnzbd / qBittorrent slots. */
export function PrimaryPrefs({ id, priority, enabled, onSaved }: { id: "sabnzbd" | "qbittorrent"; priority: number; enabled: boolean; onSaved: () => void }) {
  const toast = useToast();
  const save = async (patch: { priority?: number; enabled?: boolean }) => {
    try {
      await api(`/clients/${id}/prefs`, { method: "PUT", body: patch });
      onSaved();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="form">
      <label>
        {t("clients.priority")}
        <NumberInput value={priority} min={1} max={50} onChange={(v) => void save({ priority: v })} label={t("clients.priority")} />
        <span className="muted small">{t("clients.priorityHelp")}</span>
      </label>
      <Toggle checked={enabled} onChange={(v) => void save({ enabled: v })} label={t("clients.enabled")} />
    </div>
  );
}

// ---------------------------------------------------------------- direct indexers

const KIND_LABEL: Record<DirectIndexer["kind"], I18nKey> = { newznab: "ix.kind.newznab", torznab: "ix.kind.torznab", nyaa: "ix.kind.nyaa", rss: "ix.kind.rss", subsplease: "ix.kind.subsplease" };

export function IndexerDialog({ initial, entry, onClose, onSaved }: { initial: DirectIndexer; entry?: CatalogEntry | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [ix, setIx] = useState<DirectIndexer>(initial);
  const [res, setRes] = useState<{ ok: boolean; text: string; sample?: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState(false);
  const set = (patch: Partial<DirectIndexer>) => setIx((x) => ({ ...x, ...patch }));
  const api2 = ix.kind === "newznab" || ix.kind === "torznab";
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={ix.id ? ix.name : t("ix.addTitle", { name: ix.name || t(KIND_LABEL[ix.kind]) })} onClose={onClose}>
      <p className="muted small">
        {t(ix.protocol === "usenet" ? "conn.proto.usenet" : "conn.proto.torrent")} · {t(KIND_LABEL[ix.kind])}
        {entry ? ` · ${entry.goodFor}` : ""}
      </p>
      {entry?.checked.status !== undefined && entry.checked.status !== "ok" && <p className="banner warn small">{t("ix.checkedWarn", { date: entry.checked.date, note: entry.checked.note })}</p>}
      <div className="form">
        <label>
          {t("clients.name")}
          <input value={ix.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label>
          {ix.kind === "rss" ? t("ix.rssUrl") : t("settings.url")}
          <input value={ix.url} onChange={(e) => set({ url: e.target.value })} placeholder={ix.kind === "rss" ? "https://example.org/rss?q={q}" : "https://indexer.example"} />
          {ix.kind === "rss" && <span className="muted small">{t("ix.rssHelp")}</span>}
        </label>
        {api2 && (
          <label className="field">
            {t(ix.protocol === "torrent" ? "ix.passkey" : "settings.apiKey")}
            <SecretInput value={ix.apiKey} onChange={(v) => set({ apiKey: v })} label={t("settings.apiKey")} />
            {entry?.needsKey && <span className="muted small">{t("ix.keyNeeded")}</span>}
          </label>
        )}
        {api2 && (
          // Tick-boxes for the usual kinds (the numbers are Newznab/Torznab's); other numbers stay under Advanced.
          <fieldset className="field cat-boxes">
            <legend>{t("ix.categories")}</legend>
            {CATS.map(([n, key]) => (
              <label key={n} className="check">
                <input type="checkbox" checked={ix.categories.includes(n)} onChange={(e) => set({ categories: e.target.checked ? [...new Set([...ix.categories, n])] : ix.categories.filter((x) => x !== n) })} /> {t(key)}
              </label>
            ))}
          </fieldset>
        )}
        {api2 && (
          <details className="field">
            <summary className="small">{t("ix.advanced")}</summary>
            <label className="field">
              {t("ix.apiPath")}
              <input value={ix.apiPath} onChange={(e) => set({ apiPath: e.target.value })} placeholder="/api" />
              <span className="muted small">{t("ix.apiPathHelp")}</span>
            </label>
            <label className="field">
              {t("ix.categoryNumbers")}
              <ListInput value={ix.categories} onChange={(v) => set({ categories: v.map(Number).filter((n) => n > 0) })} label={t("ix.categoryNumbers")} placeholder="5070, 5000, 2000" />
              <span className="muted small">{t("ix.categoriesHelp")}</span>
            </label>
          </details>
        )}
        <label>
          {t("clients.priority")}
          <NumberInput value={ix.priority} min={1} max={50} onChange={(v) => set({ priority: v })} label={t("clients.priority")} />
          <span className="muted small">{t("ix.priorityHelp")}</span>
        </label>
        {ix.protocol === "torrent" && (
          <>
            <label>
              {t("ix.seedRatio")}
              <input inputMode="decimal" value={ix.seedRatio ?? ""} placeholder={t("ix.clientDefault")} onChange={(e) => set({ seedRatio: e.target.value === "" ? null : Number(e.target.value) })} />
            </label>
            <label>
              {t("ix.seedTime")}
              <input inputMode="numeric" value={ix.seedTimeMin ?? ""} placeholder={t("ix.clientDefault")} onChange={(e) => set({ seedTimeMin: e.target.value === "" ? null : Number(e.target.value) })} />
            </label>
          </>
        )}
        <label>
          {t("ix.tags")}
          <ListInput value={ix.tags} onChange={(v) => set({ tags: v })} label={t("ix.tags")} />
        </label>
      </div>
      <Toggle checked={ix.enabled} onChange={(v) => set({ enabled: v })} label={t("clients.enabled")} />
      {res && (
        <div className={`small ${res.ok ? "good-text" : "warn-text"}`}>
          <p>{res.ok ? res.text : <ErrorText msg={res.text} />}</p>
          {res.sample && (
            <ul className="plain mono muted">
              {res.sample.map((x) => (
                <li key={x} className="clamp1">
                  {x}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="row between">
        {ix.id ? (
          <button className="danger" disabled={busy} onClick={() => setDel(true)}>
            {t("common.delete")}
          </button>
        ) : (
          <span />
        )}
        <div className="row">
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                try {
                  const r = await api<{ query: string; found: number; ms: number; sample: { title: string }[] }>("/indexers/test", { body: { ...ix, query: "frieren" } });
                  setRes({ ok: r.found > 0, text: t("ix.testResult", { n: r.found, q: r.query, ms: r.ms }), sample: r.sample.map((x) => x.title) });
                } catch (e) {
                  setRes({ ok: false, text: (e as Error).message });
                }
              })
            }
          >
            {t("ix.test")}
          </button>
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api(ix.id ? `/indexers/${ix.id}` : "/indexers", { method: ix.id ? "PUT" : "POST", body: ix });
                toast(t("common.saved"));
                onSaved();
                onClose();
              })
            }
          >
            {t("common.save")}
          </button>
        </div>
      </div>
      {del && (
        <Confirm
          danger
          title={t("conn.deleteTitle", { name: ix.name })}
          confirmLabel={t("common.delete")}
          onClose={() => setDel(false)}
          onConfirm={async () => {
            try {
              await api(`/indexers/${ix.id}`, { method: "DELETE" });
              toast(t("conn.deleted", { name: ix.name }));
              onSaved();
              onClose();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          <p>{t("ix.deleteBody")}</p>
        </Confirm>
      )}
    </Modal>
  );
}

/** The usual Newznab/Torznab categories, as tick-boxes. */
const CATS: [number, I18nKey][] = [
  [5070, "ix.cat.anime"],
  [5000, "ix.cat.tv"],
  [2000, "ix.cat.movies"],
];

export const fromEntry = (e: CatalogEntry): DirectIndexer => ({ kind: e.kind, protocol: e.protocol, name: e.name, url: e.url, apiPath: e.apiPath, apiKey: "", categories: e.categories, priority: e.recommended ? 10 : 25, enabled: true, seedRatio: null, seedTimeMin: null, tags: [], catalogId: e.id });
export const customIndexer = (kind: "newznab" | "torznab" | "rss"): DirectIndexer => ({ kind, protocol: kind === "newznab" ? "usenet" : "torrent", name: "", url: "", apiPath: kind === "rss" ? "" : "/api", apiKey: "", categories: kind === "rss" ? [] : [5070, 5000, 2000], priority: 25, enabled: true, seedRatio: null, seedTimeMin: null, tags: [], catalogId: null });

/** "+ Add an indexer": the curated anime catalogue (checked live, dated) and the custom forms. */
export function CataloguePicker({ protocol, prowlarr, added, onPick, onClose }: { protocol: Protocol; prowlarr: boolean; added: string[]; onPick: (ix: DirectIndexer, entry: CatalogEntry | null) => void; onClose: () => void }) {
  const cat = useLoad(() => api<{ version: number; updated: string; entries: CatalogEntry[] }>("/catalog/indexers"), []);
  const list = (cat.data?.entries ?? []).filter((e) => e.protocol === protocol);
  const groups: [I18nKey, CatalogEntry[]][] = [
    ["ix.group.recommended", list.filter((e) => e.recommended)],
    ["ix.group.free", list.filter((e) => !e.recommended && !e.needsKey && e.visibility === "public")],
    ["ix.group.account", list.filter((e) => e.needsKey)],
  ];
  return (
    <Modal title={t(protocol === "usenet" ? "conn.add.usenetIndexer" : "conn.add.torrentIndexer")} onClose={onClose}>
      {prowlarr && <p className="banner slim small">{t("ix.prowlarrNote")}</p>}
      {cat.data && <p className="muted small">{t("ix.catalogueChecked", { date: cat.data.updated, v: cat.data.version })}</p>}
      {groups.map(
        ([label, es]) =>
          !!es.length && (
            <section key={label} className="stack">
              <h3 className="eyebrow">{t(label)}</h3>
              <ul className="catalogue">
                {es.map((e) => {
                  const already = added.includes(e.id);
                  const down = e.checked.status === "down";
                  return (
                    <li key={e.id}>
                      <button className="cat-card card" disabled={already || e.addable === false} onClick={() => (e.viaProwlarr ? undefined : onPick(fromEntry(e), e))} aria-disabled={e.viaProwlarr || undefined}>
                        <span className="conn-logo" aria-hidden="true">
                          {e.name.slice(0, 2)}
                        </span>
                        <span className="conn-text">
                          <span className="strong">
                            {e.name} {already && <span className="tag neutral">{t("conn.already")}</span>}
                          </span>
                          <span className="muted small">{e.goodFor}</span>
                          <span className="lib-flags">
                            <span className="tag neutral">{e.language}</span>
                            <span className={`tag ${e.access === "free" ? "good" : e.access === "invite" ? "warn" : "info"}`}>{t(`ix.access.${e.access}` as I18nKey)}</span>
                            <span className="tag neutral">{t(e.visibility === "private" ? "ix.private" : "ix.public")}</span>
                            {down && <span className="tag bad">{t("ix.down", { date: e.checked.date })}</span>}
                            {e.checked.status === "unverified" && <span className="tag warn">{t("ix.unverified")}</span>}
                          </span>
                          {e.viaProwlarr && <span className="small warn-text">{t("ix.viaProwlarr")}</span>}
                          {e.addable === false && <span className="small muted">{e.checked.note}</span>}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ),
      )}
      <section className="stack">
        <h3 className="eyebrow">{t("ix.group.custom")}</h3>
        <div className="row">
          {protocol === "usenet" ? (
            <button onClick={() => onPick(customIndexer("newznab"), null)}>{t("ix.kind.newznab")}</button>
          ) : (
            <>
              <button onClick={() => onPick(customIndexer("torznab"), null)}>{t("ix.kind.torznab")}</button>
              <button onClick={() => onPick(customIndexer("rss"), null)}>{t("ix.kind.rss")}</button>
            </>
          )}
        </div>
      </section>
    </Modal>
  );
}

// ---------------------------------------------------------------- Jackett

/** Connect Jackett, list its trackers, add each one's Torznab feed in one click. */
export function JackettDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [list, setList] = useState<{ id: string; name: string; type: string; language: string; feed: string; added: boolean }[] | null>(null);
  const [busy, setBusy] = useState(false);
  // Shown in the dialog (a toast could hide behind it); empty fields are said, not silently ignored.
  const [err, setErr] = useState<string | null>(null);
  const load = async () => {
    setErr(null);
    if (!url.trim()) return setErr(t("jackett.needUrl"));
    if (!key.trim()) return setErr(t("jackett.needKey"));
    setBusy(true);
    try {
      setList((await api<{ trackers: NonNullable<typeof list> }>("/jackett/trackers", { body: { url, apiKey: key } })).trackers);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Jackett" onClose={onClose}>
      <p className="muted small">{t("jackett.help")}</p>
      <div className="form">
        <label>
          {t("settings.url")}
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://192.168.1.10:9117" />
        </label>
        <label className="field">
          {t("settings.apiKey")}
          <SecretInput value={key} onChange={setKey} label={t("settings.apiKey")} />
        </label>
      </div>
      <button className="self-start" disabled={busy} onClick={() => void load()}>
        {busy ? t("common.working") : t("jackett.load")}
      </button>
      {err && (
        <p className="warn-text small" role="alert">
          <ErrorText msg={err} />
        </p>
      )}
      {list && !list.length && <p className="muted small">{t("jackett.none")}</p>}
      {list && !!list.length && (
        <ul className="plain stack">
          {list.map((x) => (
            <li key={x.id} className="row between">
              <span>
                <b>{x.name}</b> <span className="tag neutral">{x.type}</span> {x.language && <span className="muted small">{x.language}</span>}
              </span>
              <button
                className="small"
                disabled={x.added || busy}
                onClick={async () => {
                  try {
                    await api("/jackett/add", { body: { name: x.name, feed: x.feed, apiKey: key } });
                    setList((l) => l!.map((y) => (y.id === x.id ? { ...y, added: true } : y)));
                    toast(t("common.saved"));
                    onSaved();
                  } catch (e) {
                    toast((e as Error).message, true);
                  }
                }}
              >
                {x.added ? t("conn.already") : t("common.add")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
