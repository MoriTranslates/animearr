/** The curated indexer catalogue (catalog/indexers.json). A leaf: connectionsAdmin.ts and indexerPick.ts both read it. */
import fs from "node:fs";
import path from "node:path";
import type { IndexerCfg } from "./settings.js";

let catalogCache: { at: number; v: Catalog } | null = null;
export interface CatalogEntry {
  id: string;
  name: string;
  kind: IndexerCfg["kind"];
  protocol: "usenet" | "torrent";
  url: string;
  apiPath: string;
  categories: number[];
  needsKey: boolean;
  access: string;
  visibility: string;
  language: string;
  goodFor: string;
  recommended: boolean;
  addable?: boolean;
  viaProwlarr?: boolean;
  checked: { date: string; status: string; note: string };
}
export interface Catalog {
  version: number;
  updated: string;
  entries: CatalogEntry[];
  animeFit?: { great?: string[]; general?: string[]; not?: string[] };
}

/** The curated catalogue (catalog/indexers.json next to the app; editable without a code change). */
export function indexerCatalog(): Catalog {
  if (catalogCache && Date.now() - catalogCache.at < 60_000) return catalogCache.v;
  const file = [
    path.join(process.cwd(), "catalog", "indexers.json"),
    path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..", "catalog", "indexers.json"),
  ].find((f) => fs.existsSync(f));
  const v = file ? (JSON.parse(fs.readFileSync(file, "utf8")) as Catalog) : { version: 0, updated: "", entries: [] };
  catalogCache = { at: Date.now(), v };
  return v;
}
