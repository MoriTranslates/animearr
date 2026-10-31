import { useState } from "react";
import { api, BASE } from "./api";
import { copyText } from "./errors";
import { t } from "./i18n";
import type { Tag } from "./rules";
import { ErrorText, Modal, NumberInput, Spinner, Toggle, useLoad, useToast } from "./ui";

/** The calendar's iCal link: built from this address and the API key (calendar apps can't log in), with Sonarr's options. */
export function IcalLink({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const key = useLoad(() => api<{ apiKey: string | null }>("/settings/apikey"), []);
  const tags = useLoad(() => api<{ tags: Tag[] }>("/tags"), []);
  const [past, setPast] = useState(7);
  const [future, setFuture] = useState(28);
  const [unmonitored, setUnmonitored] = useState(false);
  const [picked, setPicked] = useState<number[]>([]);
  const k = key.data?.apiKey;
  const q = new URLSearchParams();
  if (k) q.set("apikey", k);
  if (past !== 7) q.set("pastDays", String(past));
  if (future !== 28) q.set("futureDays", String(future));
  if (unmonitored) q.set("unmonitored", "true");
  if (picked.length) q.set("tags", picked.join(","));
  const url = `${window.location.origin}${BASE}/feed/calendar/animearr.ics?${q.toString()}`;
  return (
    <Modal title={t("ical.title")} onClose={onClose}>
      <div className="stack">
        <p className="muted small">{t("ical.help")}</p>
        {!key.data && !key.error && <Spinner label={t("app.loading")} />}
        {key.data && k === null && <ErrorText msg={t("ical.loginNeeded")} />}
        {k && (
          <>
            <div className="form">
              <label>
                {t("ical.pastDays")}
                <NumberInput value={past} min={0} max={365} label={t("ical.pastDays")} onChange={setPast} />
              </label>
              <label>
                {t("ical.futureDays")}
                <NumberInput value={future} min={0} max={365} label={t("ical.futureDays")} onChange={setFuture} />
              </label>
            </div>
            <Toggle checked={unmonitored} onChange={setUnmonitored} label={t("ical.unmonitored")} />
            {!!tags.data?.tags.length && (
              <fieldset className="stack">
                <legend>{t("ical.tags")}</legend>
                <span className="row wrap">
                  {tags.data.tags.map((x) => (
                    <button key={x.id} type="button" className={`small${picked.includes(x.id) ? " on" : ""}`} aria-pressed={picked.includes(x.id)} onClick={() => setPicked((p) => (p.includes(x.id) ? p.filter((y) => y !== x.id) : [...p, x.id]))}>
                      {x.label}
                    </button>
                  ))}
                </span>
              </fieldset>
            )}
            <div className="row">
              <input className="grow" readOnly value={url} aria-label={t("ical.title")} onFocus={(e) => e.currentTarget.select()} />
              <button
                className="primary"
                onClick={async () => {
                  const ok = await copyText(url);
                  toast(ok ? t("ical.copied") : t("ical.copyFailed"), !ok);
                }}
              >
                {t("ical.copy")}
              </button>
            </div>
            <p className="small bad-text">{t("ical.warn")}</p>
          </>
        )}
      </div>
    </Modal>
  );
}
