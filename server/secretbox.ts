import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "./db.js";

/**
 * Encryption at rest for the settings row (all service API keys and passwords live there).
 * AES-256-GCM with a random 32-byte key kept in CONFIG_DIR/secret.key (mode 600), created on first run.
 * The key is separate from the database, so a copied animearr.db (or a backup) alone does not reveal any keys.
 */
const KEY_FILE = path.join(CONFIG_DIR, "secret.key");

function loadKey(): Buffer {
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

const PREFIX = "enc:v1:";

export function seal(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

export function open(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored; // plain (never written by this version; tolerated for imports)
  const buf = Buffer.from(stored.slice(PREFIX.length), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

export const isSealed = (s: string) => s.startsWith(PREFIX);
