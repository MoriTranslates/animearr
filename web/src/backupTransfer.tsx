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
  const [asking, setAsking] = useState(false);
  // The file holds the key to every saved password, so downloading it needs the password too (also on the home network).
  const download = async () => {
    const res = await fetch(`${BASE}/api/system/backup/download`, { method: "POST", headers: { "X-AnimeArr": "1", "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }), credentials: "same-origin" });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      toast(humanError(data.error ?? res.statusText), true);
      return;
    }
    const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "animearr-backup.tar.gz";
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setPw("");
    setAsking(false);
  };
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
        <button
          className="small"
          onClick={() => {
            setPw("");
            setAsking(true);
          }}
        >
          {t("bt.download")}
        </button>
        <button className="small" disabled={busy} onClick={() => pick.current?.click()}>
          {busy ? t("bt.checking") : t("bt.upload")}
        </button>
        <input ref={pick} type="file" accept=".gz,.tgz,application/gzip" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
      </div>
      {asking && (
        <Confirm title={t("bt.download")} confirmLabel={t("bt.download")} onClose={() => setAsking(false)} onConfirm={download}>
          <p>{t("bt.downloadPw")}</p>
          <label className="field">
            {t("bt.pw")}
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" autoFocus />
          </label>
        </Confirm>
      )}
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
