import crypto from "node:crypto";
import fs from "node:fs";
import { db, KEY_FILE } from "./db.js";

/**
 * Encryption at rest for the settings row (all service API keys and passwords live there).
 * AES-256-GCM with a random 32-byte key kept in CONFIG_DIR/secret.key (mode 600), created on first run.
 * The key is separate from the database, so a copied animearr.db (or a backup) alone does not reveal any keys.
 */
export { KEY_FILE };

const PREFIX = "enc:v1:"; // up here: loadKey() below already opens sealed settings

/**
 * A restore swaps animearr.db and secret.key with two renames. If it stopped between them (crash, power cut), the
 * restored key still waits next to the live one: the key that opens the live settings is the right one.
 */
function finishKeySwap() {
  const pending = `${KEY_FILE}.restore-tmp`;
  if (!fs.existsSync(pending)) return;
  const hex = fs.readFileSync(pending, "utf8").trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) return; // not a key AnimeArr wrote: left for a look
  let row: { value: string } | undefined;
  try {
    row = db.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as { value: string } | undefined;
  } catch {
    return; // a damaged database can't tell which key is right: both files stay as they are
  }
  if (!row || !isSealed(row.value)) return;
  const sealed = row.value;
  const opens = (k: string) => {
    try {
      open(sealed, Buffer.from(k, "hex"));
      return true;
    } catch {
      return false; // not this key
    }
  };
  if (opens(hex)) fs.renameSync(pending, KEY_FILE);
  // The restore never reached the database: the live pair is intact and the waiting key isn't used.
  else if (fs.existsSync(KEY_FILE) && opens(fs.readFileSync(KEY_FILE, "utf8").trim())) fs.rmSync(pending);
}

function loadKey(): Buffer {
  finishKeySwap();
  if (fs.existsSync(KEY_FILE)) {
    const hex = fs.readFileSync(KEY_FILE, "utf8").trim();
    if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`${KEY_FILE} is not a valid key file`);
    return Buffer.from(hex, "hex");
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, key.toString("hex"), { mode: 0o600 });
  return key;
}
const KEY = loadKey();

export function seal(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

export function open(stored: string, key: Buffer = KEY): string {
  if (!stored.startsWith(PREFIX)) return stored; // plain (never written by this version; tolerated for imports)
  const buf = Buffer.from(stored.slice(PREFIX.length), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

export function isSealed(s: string) {
  return s.startsWith(PREFIX);
}
