import { useRef, useState } from "react";
import { api, BASE } from "./api";
import { humanError } from "./errors";
import { t } from "./i18n";
import { Confirm, dateTime, useToast } from "./ui";

interface Staged { token: string; appVersion: string; createdAt: string; schema: number }

/** Settings → System → Backups: download a backup file, or upload one to restore (checked first, then the password). */
export function BackupTransfer() {
  const toast = useToast();
  const pick = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [staged, setStaged] = useState<Staged | null>(null);
  const [pw, setPw] = useState("");
  const upload = async (file: File) => {
    setBusy(true);
    try {
      // Raw bytes, not JSON (the api() helper is JSON-only); same CSRF header as every other change.
      const res = await fetch(`${BASE}/api/system/backup/upload`, { method: "POST", headers: { "X-AnimeArr": "1", "Content-Type": "application/octet-stream" }, body: file, credentials: "same-origin" });
      const data = (await res.json().catch(() => ({}))) as Staged & { error?: string };
      if (!res.ok) throw new Error(humanError(data.error ?? res.statusText));
      setPw("");
      setStaged(data);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
      if (pick.current) pick.current.value = "";
    }
  };
  return (
    <>
      <p className="muted small">{t("bt.help")}</p>
      <p className="banner warn slim small">{t("bt.warn")}</p>
      <div className="row">
        <a className="button-link small" href={`${BASE}/api/system/backup/download`} download>
          {t("bt.download")}
        </a>
        <button className="small" disabled={busy} onClick={() => pick.current?.click()}>
          {busy ? t("bt.checking") : t("bt.upload")}
        </button>
        <input ref={pick} type="file" accept=".gz,.tgz,application/gzip" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
      </div>
      {staged && (
        <Confirm
          danger
          title={t("bt.restore")}
          confirmLabel={t("bt.restore")}
          onClose={() => setStaged(null)}
          onConfirm={async () => {
            try {
              const r = await api<{ message: string }>("/system/backup/restore-upload", { body: { token: staged.token, password: pw } });
              toast(r.message);
              setStaged(null);
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          <p>{t("bt.found", { version: staged.appVersion, when: dateTime(Date.parse(staged.createdAt)) })}</p>
          <p>{t("bt.confirm")}</p>
          <label className="field">
            {t("bt.pw")}
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
          </label>
        </Confirm>
      )}
    </>
  );
}
