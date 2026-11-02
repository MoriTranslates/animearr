/**
 * One AnimeArr "start" for test/restore-safety.test.ts: the database, key and settings load as they would at startup
 * (ANIMEARR_CONFIG is set by the caller), then one action runs and its result is printed as the last line (JSON).
 * Not a test file itself.
 */
const [action, arg = ""] = process.argv.slice(2);
const out = (v: unknown) => {
  process.stdout.write(`\n${JSON.stringify(v)}\n`);
  process.exit(0);
};
try {
  const { db, dbState, backupNow } = await import("../server/system/db.js");
  const { getSettings, patchSettings, setAccount, checkPassword } = await import("../server/system/settings.js");
  const bt = await import("../server/system/backupTransfer.js");
  const fs = await import("node:fs");
  if (action === "setup") {
    // arg: a marker that identifies this state after a restore.
    await setAccount("captain", "pw-" + arg);
    patchSettings((s) => ({ ...s, externalUrl: `http://${arg}.lan` }));
    out({ backup: backupNow("nightly") });
  } else if (action === "status") {
    const s = getSettings();
    out({
      corrupt: dbState.corrupt,
      marker: s.externalUrl,
      passwordOk: await checkPassword(arg, s.auth.passwordHash),
      hasHash: !!s.auth.passwordHash,
    });
  } else if (action === "restore") {
    try {
      bt.restoreSaved(arg);
      out({ ok: true });
    } catch (e) {
      out({ ok: false, error: (e as Error).message });
    }
  } else if (action === "export") {
    fs.writeFileSync(arg, (await bt.createBackup()).data);
    out({ ok: true });
  } else if (action === "upload") {
    try {
      bt.restoreUploaded(await bt.parseBackup(fs.readFileSync(arg)));
      out({ ok: true });
    } catch (e) {
      out({ ok: false, error: (e as Error).message });
    }
  } else out({ error: `unknown action ${action}` });
  void db;
} catch (e) {
  out({ crashed: (e as Error).message });
}
