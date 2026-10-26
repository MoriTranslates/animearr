import { useEffect, useRef, useState } from "react";
import { api, type Settings as S } from "./api";
import { t, type I18nKey } from "./i18n";
import { relTime, SecretInput, Toggle, useToast } from "./ui";

interface Bell { unread: number; items: { id: number; at: number; event: "grabbed" | "imported" | "failed" | "paused"; title: string; body: string; read: boolean }[] }
const ICON = { grabbed: "⬇️", imported: "✅", failed: "⚠️", paused: "⏸️" } as const;

/** The in-app bell: grabbed / imported / failed / paused, newest first; opening it marks them read. */
export function BellButton() {
  const [b, setB] = useState<Bell | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api<Bell>("/notifications").then((x) => alive && setB(x), () => undefined);
    void load();
    const h = setInterval(load, 60_000);
    return () => ((alive = false), clearInterval(h));
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className="bell" ref={ref}>
      <button
        className="ghost small"
        aria-label={t("bell.label", { n: b?.unread ?? 0 })}
        aria-expanded={open}
        onClick={async () => {
          const opening = !open;
          setOpen(opening);
          if (!opening) return;
          // Fresh list first; then mark what's shown as read (anything newer stays unread).
          const fresh = await api<Bell>("/notifications").catch(() => b);
          setB(fresh);
          if (fresh?.unread && fresh.items[0]) setB(await api<Bell>("/notifications/read", { body: { upToId: fresh.items[0].id } }).catch(() => fresh));
        }}
      >
        🔔{b?.unread ? <span className="bell-count">{b.unread}</span> : null}
      </button>
      {open && (
        <div className="bell-pop card pad stack" role="dialog" aria-label={t("bell.title")}>
          <strong>{t("bell.title")}</strong>
          {!b?.items.length && <p className="muted small">{t("bell.none")}</p>}
          <ul className="rename-list small">
            {b?.items.map((n) => (
              <li key={n.id} className="stack">
                <span>
                  {ICON[n.event]} <strong>{n.title || t(`bell.${n.event}` as I18nKey)}</strong> <span className="muted">· {relTime(n.at)}</span>
                </span>
                <span className="muted clamp2">{n.body}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Settings → Connections: Discord / ntfy for grabbed, imported, failed and paused-by-limit. */
export function NotifyCard({ s, upd }: { s: S; upd: (fn: (x: S) => S) => void }) {
  const toast = useToast();
  const n = s.notify;
  const set = (patch: Partial<S["notify"]>) => upd((x) => ({ ...x, notify: { ...x.notify, ...patch } }));
  return (
    <div className="card pad stack">
      <div className="row between">
        <h2>{t("notify.title")}</h2>
        <button
          className="small"
          onClick={async () => {
            try {
              const r = await api<{ results: { channel: string; ok: boolean; why: string }[] }>("/notifications/test", { body: {} });
              toast(r.results.map((x) => `${x.channel}: ${x.why}`).join(" · "), r.results.some((x) => !x.ok));
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          {t("common.test")}
        </button>
      </div>
      <p className="muted small">{t("notify.help")}</p>
      <div className="form">
        <label className="field">
          {t("notify.discord")}
          <SecretInput value={n.discordWebhook} onChange={(v) => set({ discordWebhook: v })} label={t("notify.discord")} />
        </label>
        <label>
          {t("notify.ntfy")}
          <input value={n.ntfyUrl} onChange={(e) => set({ ntfyUrl: e.target.value })} placeholder="https://ntfy.sh/my-animearr" />
        </label>
        <label className="field">
          {t("notify.ntfyToken")}
          <SecretInput value={n.ntfyToken} onChange={(v) => set({ ntfyToken: v })} label={t("notify.ntfyToken")} />
        </label>
        {(["grabbed", "imported", "failed", "paused"] as const).map((ev) => (
          <Toggle key={ev} checked={n.events[ev]} onChange={(v) => set({ events: { ...n.events, [ev]: v } })} label={t(`notify.ev.${ev}` as I18nKey)} />
        ))}
      </div>
      <p className="muted small">{t("notify.saveFirst")}</p>
    </div>
  );
}
