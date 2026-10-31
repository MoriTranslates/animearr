import { useEffect, useState } from "react";
import { api } from "./api";
import { t, type I18nKey } from "./i18n";
import { relTime, SecretInput, Toggle, useToast } from "./ui";

type Type = "webhook" | "telegram" | "pushover" | "email";
type Events = { grabbed: boolean; imported: boolean; failed: boolean; paused: boolean; indexer: boolean };
interface Channel {
  id: string; type: Type; name: string; enabled: boolean; events: Events;
  url: string; method: "POST" | "PUT"; headers: { name: string; value: string }[];
  botToken: string; chatId: string; threadId: string; silent: boolean;
  userKey: string; appToken: string; priority: number; device: string; sound: string;
  host: string; port: number; secure: "none" | "starttls" | "tls"; username: string; password: string; from: string; to: string;
}
interface Loaded { channels: Channel[]; status: Record<string, { at: number; ok: boolean; error: string | null }> }

const TYPES: Type[] = ["webhook", "telegram", "pushover", "email"];
const blank = (type: Type): Channel => ({
  id: `ch-${Date.now().toString(36)}`, type, name: t(`nch.type.${type}` as I18nKey).replace(/ \(.*\)$/, ""), enabled: true,
  events: { grabbed: true, imported: true, failed: true, paused: true, indexer: true },
  url: "", method: "POST", headers: [], botToken: "", chatId: "", threadId: "", silent: false,
  userKey: "", appToken: "", priority: 0, device: "", sound: "", host: "", port: 587, secure: "starttls", username: "", password: "", from: "", to: "",
});

/** Settings → Connections → Notifications: webhook, Telegram, Pushover and email channels. */
export function NotifyChannelsCard() {
  const toast = useToast();
  const [list, setList] = useState<Channel[] | null>(null);
  const [status, setStatus] = useState<Loaded["status"]>({});
  const [dirty, setDirty] = useState(false);
  const load = async () => {
    try {
      const r = await api<Loaded>("/notify/channels");
      setList(r.channels);
      setStatus(r.status);
      setDirty(false);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  useEffect(() => void load(), []);
  if (!list) return null;
  const edit = (i: number, patch: Partial<Channel>) => (setList(list.map((c, j) => (j === i ? { ...c, ...patch } : c))), setDirty(true));
  const bad = (["discord", "ntfy"] as const).filter((k) => status[k] && !status[k].ok);
  return (
    <div className="card pad stack">
      <div className="row between">
        <h2>{t("nch.title")}</h2>
        <button className="small" disabled={!dirty} onClick={async () => {
          try {
            const r = await api<Loaded>("/notify/channels", { method: "PUT", body: { channels: list } });
            setList(r.channels);
            setStatus(r.status);
            setDirty(false);
            toast(t("nch.saved"));
          } catch (e) {
            toast((e as Error).message, true);
          }
        }}>
          {t("nch.saveAll")}
        </button>
      </div>
      <p className="muted small">{t("nch.help")}</p>
      {bad.map((k) => (
        <p key={k} className="banner warn slim small">
          {t("nch.legacyError", { name: k === "discord" ? "Discord" : "ntfy", why: status[k].error ?? "" })}
        </p>
      ))}
      {!list.length && <p className="muted small">{t("nch.none")}</p>}
      {list.map((c, i) => (
        <ChannelForm key={c.id} c={c} dirty={dirty} st={status[c.id]} set={(p) => edit(i, p)} onRemove={() => (setList(list.filter((_, j) => j !== i)), setDirty(true))} />
      ))}
      <div className="row">
        {TYPES.map((ty) => (
          <button key={ty} className="small" onClick={() => (setList([...list, blank(ty)]), setDirty(true))}>
            + {t(`nch.type.${ty}` as I18nKey)}
          </button>
        ))}
      </div>
      {dirty && <p className="muted small">{t("nch.unsaved")}</p>}
    </div>
  );
}

function ChannelForm({ c, set, onRemove, st, dirty }: { c: Channel; set: (p: Partial<Channel>) => void; onRemove: () => void; st?: { at: number; ok: boolean; error: string | null }; dirty: boolean }) {
  const toast = useToast();
  return (
    <div className="card pad stack">
      <div className="row between">
        <strong>{t(`nch.type.${c.type}` as I18nKey)}</strong>
        <span className="row">
          <button
            className="small"
            title={dirty ? t("nch.saveFirst") : undefined}
            disabled={dirty}
            onClick={async () => {
              try {
                const r = await api<{ results: { channel: string; ok: boolean; why: string }[] }>(`/notify/channels/${encodeURIComponent(c.id)}/test`, { body: {} });
                const x = r.results[0];
                toast(x.ok ? t("nch.testOk", { name: x.channel }) : t("nch.testFail", { name: x.channel, why: x.why }), !x.ok);
              } catch (e) {
                toast((e as Error).message, true);
              }
            }}
          >
            {t("common.test")}
          </button>
          <button className="small ghost" onClick={onRemove}>
            {t("nch.remove")}
          </button>
        </span>
      </div>
      {st && (st.ok ? <p className="muted small">{t("nch.lastOk", { when: relTime(st.at) })}</p> : <p className="banner warn slim small">{t("nch.lastError", { why: st.error ?? "" })}</p>)}
      <div className="form">
        <label>
          {t("nch.name")}
          <input value={c.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <Toggle checked={c.enabled} onChange={(v) => set({ enabled: v })} label={t("nch.enabled")} />
        {c.type === "webhook" && (
          <>
            <label className="field">
              {t("nch.wh.url")}
              <SecretInput value={c.url} onChange={(v) => set({ url: v })} label={t("nch.wh.url")} placeholder="https://example.com/hooks/animearr" />
            </label>
            <label>
              {t("nch.wh.method")}
              <select value={c.method} onChange={(e) => set({ method: e.target.value as "POST" | "PUT" })}>
                <option value="POST">POST</option>
                <option value="PUT">PUT</option>
              </select>
            </label>
            <div className="stack">
              <span>{t("nch.wh.headers")}</span>
              {c.headers.map((h, i) => (
                <div key={i} className="row">
                  <input aria-label={t("nch.wh.headerName")} placeholder={t("nch.wh.headerName")} value={h.name} onChange={(e) => set({ headers: c.headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                  <SecretInput label={t("nch.wh.headerValue")} placeholder={t("nch.wh.headerValue")} value={h.value} onChange={(v) => set({ headers: c.headers.map((x, j) => (j === i ? { ...x, value: v } : x)) })} />
                  <button className="small ghost" aria-label={t("nch.remove")} onClick={() => set({ headers: c.headers.filter((_, j) => j !== i) })}>
                    ✕
                  </button>
                </div>
              ))}
              <button className="small self-start" onClick={() => set({ headers: [...c.headers, { name: "", value: "" }] })}>
                {t("nch.wh.addHeader")}
              </button>
            </div>
            <p className="muted small">{t("nch.wh.help")}</p>
          </>
        )}
        {c.type === "telegram" && (
          <>
            <label className="field">
              {t("nch.tg.token")}
              <SecretInput value={c.botToken} onChange={(v) => set({ botToken: v })} label={t("nch.tg.token")} />
            </label>
            <label>
              {t("nch.tg.chat")}
              <input value={c.chatId} onChange={(e) => set({ chatId: e.target.value })} placeholder="-1001234567890" />
            </label>
            <label>
              {t("nch.tg.thread")}
              <input value={c.threadId} onChange={(e) => set({ threadId: e.target.value })} inputMode="numeric" />
            </label>
            <Toggle checked={c.silent} onChange={(v) => set({ silent: v })} label={t("nch.tg.silent")} />
          </>
        )}
        {c.type === "pushover" && (
          <>
            <label className="field">
              {t("nch.po.user")}
              <SecretInput value={c.userKey} onChange={(v) => set({ userKey: v })} label={t("nch.po.user")} />
            </label>
            <label className="field">
              {t("nch.po.app")}
              <SecretInput value={c.appToken} onChange={(v) => set({ appToken: v })} label={t("nch.po.app")} />
            </label>
            <label>
              {t("nch.po.priority")}
              <select value={c.priority} onChange={(e) => set({ priority: Number(e.target.value) })}>
                {[-2, -1, 0, 1, 2].map((p) => (
                  <option key={p} value={p}>
                    {t(`nch.po.p${p}` as I18nKey)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("nch.po.device")}
              <input value={c.device} onChange={(e) => set({ device: e.target.value })} />
            </label>
            <label>
              {t("nch.po.sound")}
              <input value={c.sound} onChange={(e) => set({ sound: e.target.value })} placeholder="pushover" />
            </label>
          </>
        )}
        {c.type === "email" && (
          <>
            <label>
              {t("nch.em.host")}
              <input value={c.host} onChange={(e) => set({ host: e.target.value })} placeholder="smtp.example.com" />
            </label>
            <label>
              {t("nch.em.port")}
              <input type="number" min={1} max={65535} value={c.port} onChange={(e) => set({ port: Number(e.target.value) })} />
            </label>
            <label>
              {t("nch.em.secure")}
              <select value={c.secure} onChange={(e) => set({ secure: e.target.value as Channel["secure"] })}>
                {(["none", "starttls", "tls"] as const).map((m) => (
                  <option key={m} value={m}>
                    {t(`nch.em.${m}` as I18nKey)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("nch.em.user")}
              <input value={c.username} autoComplete="off" onChange={(e) => set({ username: e.target.value })} />
            </label>
            <label className="field">
              {t("nch.em.password")}
              <SecretInput value={c.password} onChange={(v) => set({ password: v })} label={t("nch.em.password")} />
            </label>
            <label>
              {t("nch.em.from")}
              <input value={c.from} onChange={(e) => set({ from: e.target.value })} placeholder="animearr@example.com" />
            </label>
            <label>
              {t("nch.em.to")}
              <input value={c.to} onChange={(e) => set({ to: e.target.value })} placeholder="me@example.com" />
            </label>
          </>
        )}
        {(["grabbed", "imported", "failed", "paused", "indexer"] as const).map((ev) => (
          <Toggle key={ev} checked={c.events[ev]} onChange={(v) => set({ events: { ...c.events, [ev]: v } })} label={t(`notify.ev.${ev}` as I18nKey)} />
        ))}
      </div>
    </div>
  );
}
