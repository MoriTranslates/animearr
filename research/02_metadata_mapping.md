# AnimeArr — Anime metadata, ID mapping and identification design

Research date: 2026-10-25. Where a claim was checked against live data today, it is marked **[verified]**: the AniDB title dump, `anime-list-master.xml` at commit 2026-10-24, the Bangumi API, and anitopy run locally. Claims taken from secondary sources are marked as such. Some official doc pages (wiki.anidb.net, docs.anilist.co, thexem.info) returned HTTP 403 to automated fetches, so their rules are quoted through secondary sources and should be re-read by a human before implementation.

---

## TL;DR

1. **Anchor on AniDB IDs (`aid`), one per "entry" (a cour, season, movie or OVA), grouped into a franchise** by walking AniDB sequel/prequel relations. AniDB already models anime the way release groups name it: each season is its own entry, and episode numbering restarts at 1. Bangumi (bgm.tv) does the same for Chinese titles. TVDB/TMDB are a **projection** used for compatibility (Plex/Jellyfin/Trakt and indexer ID search), not the source of truth.
2. **Mapping layer = Anime-Lists `anime-list-master.xml`** (AniDB→TVDB/TMDB season and episode offsets) plus **cedya77/anime-offline-database** (AniDB↔MAL/AniList/Kitsu…). Add Bangumi for donghua and a local override table on top.
3. **Alias index** = every AniDB title (all languages, types main/official/syn/short) + MAL/AniList synonyms + Bangumi `name`/`name_cn`/infobox aliases + user aliases. Normalise aggressively: strip punctuation, collapse `Quan Zhi Fa Shi` and `Quanzhi Fashi`, convert roman numerals, convert "2nd Season".
4. **Parse with anitopy/anitomy**, then **resolve `(title, season token, episode)` to `(aid, epno)`**. Do it inside the franchise: the season token selects the N-th main-line TV entry, and absolute numbers are cumulated across entries. Then project to TVDB S/E via anime-lists offsets. When a mapping is missing, fall back to air-date order. This replaces TheXEM for anime.
5. **Local corrections are first-class.** They are stored as overrides in the same schema as anime-lists, so they can be exported as a PR or issue upstream.

---

## 1. Metadata sources

| Source | Unit of modelling | Episode types | Relations | Alt titles | Access / limits / ToS |
|---|---|---|---|---|---|
| **AniDB** | One `aid` per season/cour/movie/OVA. Episodes numbered per entry. | Regular (1..n), Special `S`, Credits/OP/ED `C`, Trailer `T`, Parody `P`, Other `O` | sequel, prequel, side story, parent story, summary, full story, alternative setting/version, same setting, character, other | **Best in class.** Every language, with typed titles: `main` (romanised), `official`, `syn`, `short`, `card`. **[verified]** e.g. aid 13171 has `Quanzhi Fashi` (main, x-zht), `Quan Zhi Fa Shi` (syn), `Full-Time Magister`/`Versatile Mage` (en syn), `全职法师` (official zh-Hans) | HTTP API (XML, needs registered client name and version) and UDP API (needs user account; file lookup by ed2k). Secondary sources: HTTP no more than 1 request per 2 s, and a daily dataset like the title dump must not be fetched more than once a day, or you get banned ([AniDB.Api](https://github.com/Vagab0nd/AniDB.Api), [FileBot forum](https://www.filebot.net/forums/viewtopic.php?p=52035)). UDP: 1 packet per 4 s long-term, 0.5/s short-term after the first 5, packets silently dropped once over the limit, exponential back-off on AUTH ([quoted UDP wiki](https://wiki.anidb.net/Special:MobileDiff/5774), [yumemi docs](https://yumemi.readthedocs.io/en/latest/api.html)). Anecdotally ~100–200 HTTP requests/IP/day before a ban, and bans last 24 h to days. Official: [HTTP API](https://wiki.anidb.net/HTTP_API_Definition), [UDP API](https://wiki.anidb.net/UDP_API_Definition). Title dump: `https://anidb.net/api/anime-titles.xml.gz` (~1.9 MB gz, regenerated daily; **[verified]** 17,086 entries, built 2026-10-25 03:00 UTC). Data is for non-commercial use with a registered client. |
| **AniList** (GraphQL) | One Media per season/cour (like MAL) | No per-episode list (only `episodes` count, `airingSchedule`, `streamingEpisodes`). Formats TV, TV_SHORT, MOVIE, SPECIAL, OVA, ONA, MUSIC | PREQUEL, SEQUEL, PARENT, SIDE_STORY, SPIN_OFF, ALTERNATIVE, SUMMARY, COMPILATION, CONTAINS, CHARACTER, ADAPTATION, SOURCE, OTHER | `title{romaji,english,native}` + `synonyms[]` (user-curated, uneven) | Officially 90 req/min, **currently degraded to 30 req/min**. Exceeding it means a 1-minute timeout (429). No new rate-limit raises are being granted ([docs](https://docs.anilist.co/guide/rate-limiting)). Good for airing schedules (next episode time) and cover art. |
| **MyAnimeList API v2** | One entry per season/cour | No episode list in the official v2 API (count only) | sequel, prequel, side_story, parent_story, alternative_setting/version, summary, full_story, spin_off, character, other | `alternative_titles{synonyms,en,ja}` (must be requested via `fields`) | Needs `X-MAL-CLIENT-ID` from myanimelist.net/apiconfig. Rate limit undocumented. Treat as an ID and synonym source only ([community spec](https://github.com/SuperMarcus/myanimelist-api-specification)). |
| **Kitsu** | Per season | `/episodes` endpoint (number, seasonNumber, relativeNumber, airdate, length) | media-relationships | `titles{en,en_jp,ja_jp}`, `abbreviatedTitles` | JSON:API at `kitsu.io/api/edge`, no auth for reads. `/anime/{id}/mappings` gives AniDB/TVDB/MAL/AniList IDs (quality varies). No published limit ([animedex notes](https://animedex.readthedocs.io/en/latest/tutorials/backends/kitsu.html)). Low priority. |
| **TVDB** | One series with Western seasons. Multiple orderings: aired, DVD, **absolute**, alternate, regional | Season 0 specials only. No OP/ED typing | none for anime | Translations and aliases (Sonarr ignores them) | v4 API is licensed: free under $50k revenue with attribution, open-source discounts, or a user-supported $12/yr PIN model ([api-information](https://www.thetvdb.com/api-information)). It is what Sonarr, Plex and Kometa key on, so we need the **projection**, not the source. |
| **TMDB** | TV show with seasons + **episode groups** (absolute, DVD, story arc…) | Season 0 specials | collections (movies only) | `alternative_titles` per country, translations | Free key, non-commercial with attribution. Generous (~tens of req/s). Episode groups are user-made and inconsistent (e.g. One Piece absolute group ends at 988 while the seasons group reaches 1000: [Firecore thread](https://community.firecore.com/t/tmdb-and-animes-the-good-way-to-rename/35177.md)). |
| **Bangumi / bgm.tv** | One subject per season, like AniDB. **[verified]** 全职法师 Ⅰ–Ⅶ are subjects 190111, 223146, 249608, 306876, 309838, 345804, 507822 | Episode `type` 0 main, 1 SP, 2 OP, 3 ED, 4 trailer, 5 MAD, 6 other. `ep` (per-subject) and `sort` fields. **[verified]** S7 has 12 eps from 2026-05-13 | Subject relations (sequel, prequel, etc.) | `name` (original), `name_cn`, infobox `别名` (aliases) | REST `api.bgm.tv/v0` with a **descriptive User-Agent required** ([bangumi/api](https://github.com/bangumi/api)). Weekly full wiki dump at [bangumi/Archive](https://github.com/bangumi/Archive) (subjects, episodes, relations). The dump licence is not stated. Treat as attribution-required and non-commercial. [bangumi-data](https://github.com/bangumi-data/bangumi-data) (CC-BY-4.0) maps bgm IDs to streaming sites, but focuses on Japanese anime. |

**Takeaways**
- Only **AniDB** (and Bangumi for Chinese titles) has both (a) per-season entries that match how fansub groups number episodes and (b) complete multilingual titles with **typed episodes** (OP/ED/specials/trailers separated from regular episodes). AniList and MAL are good for IDs, synonyms, schedules and art, but have no episode lists.
- TVDB/TMDB "Season N" often **does not equal** an AniDB entry: split cours, specials folded in, and dub-era ordering.

---

## 2. ID mapping projects

| Project | What it maps | Currency | Split cours / specials | Licence |
|---|---|---|---|---|
| **[Anime-Lists/anime-lists](https://github.com/Anime-Lists/anime-lists)** `anime-list-master.xml` | AniDB `aid` → `tvdbid` + `defaulttvdbseason` + `episodeoffset`. Also `tmdbtv` + `tmdbseason` + `tmdboffset`, `tmdbid`/`imdbid` for movies. Per-episode `<mapping-list>` (`anidbseason`, `tvdbseason`, `start`/`end`/`offset`, or explicit `;1-5;2-6;` pairs, `+` for 1→many). `<before>` places specials among regular episodes. `defaulttvdbseason="a"` means "TVDB absolute numbering equals AniDB numbering". | **Active.** Last commits 2026-10-24 ("Fix Edgerunners II TMDB"), lists regenerated every few days. **[verified]** 17,050 entries: 7,514 with a numeric TVDB ID, **6,268 empty**, the rest typed (`movie` 1,179, `OVA` 424, `hentai` 1,289…). 1,428 have `<mapping-list>`, 78 `<before>`, 74 use season `a`. **Latency:** of 907 entries with aid ≥ 19500 (≈ 2025–26), only **195 have a TVDB ID and 705 are empty**. | Split cour = two aids pointing at the same TVDB season with `episodeoffset` (e.g. aid 12198: offset 12). Specials: `anidbseason="0"`. Trailers map to 201+, "other" episodes to 401+. Movies get `defaulttvdbseason="0"` + offset when TVDB files them as specials. | **No licence file** (community data, PR-driven). Bundling it is common practice (Plex HAMA, Kometa, Shoko), but ask or attribute. |
| **[Fribb/anime-lists](https://github.com/Fribb/anime-lists)** | Flattened JSON keyed by AniDB: MAL, AniList, Kitsu, Anime-Planet, AniSearch, LiveChart, ANN, Simkl, IMDb, TMDB (tv/movie), TVDB, `season{tvdb,tmdb}`, `episode_offset` | Generated from AOD + Anime-Lists, and fills missing TMDB/TVDB via TMDB search. Pushed 2026-10-20. | Inherits Anime-Lists offsets, **but loses `mapping-list`/`before` detail**. | None stated. Corrections must go upstream. |
| **manami-project/anime-offline-database** | Clusters the same anime across MAL, Anime-Planet, Kitsu, AniSearch, AniList, AniDB, Simkl, AnimeCountdown, ANN, LiveChart (`sources[]`), plus `synonyms[]`, `type`, `episodes`, `animeSeason`, `relatedAnime` | **Archived 2026-07-04** (final release 2026-27). | Entry-level only, no episodes. | ODbL 1.0 + DbCL 1.0 |
| **[cedya77/anime-offline-database](https://github.com/cedya77/anime-offline-database)** | Continuation of the above, seeded from the final manami release and built by a forked modb-app. Weekly releases (`latest` asset, JSONL + zst). 38,137 entries in week 36. | Pushed 2026-10-25. Already the upstream for Kometa and AnimeAPI. | Same | ODbL (inherited) |
| **[beeequeue/arm-server](https://github.com/beeequeue/arm-server)** | REST API (`arm.haglund.dev`) over Fribb lists + manual merge rules. AniDB/AniList/MAL/Kitsu/TVDB/TMDB/IMDb ID lookup. Self-hostable Docker. | Refreshes every 24 h. Pushed 2026-10-22. | Entry-level only | AGPL-3.0 (code) |
| **[Kometa-Team/Anime-IDs](https://github.com/Kometa-Team/Anime-IDs)** | `anime_ids.json` keyed by AniDB → tvdb, imdb, mal, anilist, tmdb movie/show. Generated daily from Anime-Lists + cedya77 AOD + notseteve/AnimeAggregations. Has `anime_id_edits.json` override file. | Generated 2026-10-25 | No season or offset detail | MIT |
| **[nattadasu/animeApi](https://github.com/nattadasu/animeApi)** | 22 databases (adds Annict, Shikimori, Shoboi/Syobocal, Trakt, Letterboxd…). REST + downloadable dumps. | Updated 2026-10-25. v4 rewrite in progress. | Entry-level, plus Trakt/TMDB season info | MIT code, ODbL data |

**Conclusion:** use **Anime-Lists** for the only thing that is hard (season and episode offsets to TVDB/TMDB) and **cedya77 AOD** for cross-site IDs and synonyms. Optionally use arm-server or AnimeAPI as an online fallback. None of them covers **Bangumi**, so a bgm↔AniDB link has to be built by matching (`name_cn`/`name` against AniDB `zh-Hans` official titles plus air date), which works well because AniDB carries the Chinese official title.

---

## 3. TheXEM

**How it works** ([Servarr XEM guide](https://github.com/Servarr/Wiki/blob/master/sonarr/xem-guide.md), [Sonarr FAQ](https://github.com/Servarr/Wiki/blob/master/sonarr/faq.md)):
- Per show there are four column types: **Scene**, **TVDB**, **AniDB**, **Master**. Links between columns are "SxxExx", "absolute" or "full" mappings, or hand-drawn "direct" episode links via Master.
- Sonarr reads XEM to translate scene numbering to TVDB numbering. **XEM is also "the only way to fix Japanese Anime aliases" in Sonarr**, because Sonarr does not use TVDB aliases or translations.
- Anime rule: map Scene↔AniDB "full", AniDB↔TVDB "SxxExx". Per-season aliases such as `Ansatsu Kyoushitsu S2` tell Sonarr that `… S2 - 01` is TVDB S02E01. Split cour (e.g. *Tensura*) needs a Master column.
- API (older docs): `map/all?id=&origin=tvdb`, `map/havemap`, `allNames` ([FileBot thread](https://www.filebot.net/forums/viewtopic.php?p=44285)).

**Why it hurts**
1. **Manual and human-gated.** Every new anime season needs someone with an XEM account to add it, and changes are "typically accepted within a couple days". The non-anime Sonarr scene-mapping table "can take up to 2 weeks". Fixes go through a Discord `#xem` channel with "slow" response times.
2. **One numbering scheme per show.** "In the case of anime we follow the numbering of SubsPlease/Erai-Raws". Any other group's numbering (BD batches, donghua groups, Western P2P following TVDB) breaks.
3. **TVDB drift.** If TVDB renumbers, XEM silently becomes wrong ([forum](https://forums.sonarr.tv/t/thexem-vs-tvdb-question/30176)). Its entries are TVDB-anchored, so every TVDB edit can invalidate them.
4. **Latency stacking.** TVDB API cache 1–3 h + CDN 1 h + Skyhook + a 12 h series refresh = **3–19 h** before a TVDB change reaches Sonarr. XEM-derived data refreshes on the same cadence.
5. **Some shows "simply cannot be mapped"** (the guide's words). Known problem shows include Pokémon (XEM tracks the *dub*), *Bleach TYBW* (S17 vs "S2 - 01" vs absolute 367+), Kamen Rider, and Paw Patrol (double episodes).
6. **Invisible state.** Deleting a Master season leaves hidden direct mappings in place.
7. **Text search uses the English TVDB title only**, so romaji or pinyin releases do not match at all without an XEM alias.

**Typical failures users hit:** `Show S2 - 05` imported as S01E05 or rejected; split-cour part 2 (`- 13`) mapped to S02E13 instead of S02E01, or the reverse; a release one episode ahead because TVDB put a recap in S00; specials grabbed as regular episodes; donghua (`Quan.Zhi.Fa.Shi.S6.-.01`) never matched because there is no alias.

**Design implication:** AnimeArr's anime path should **not need XEM**. Its "scene" numbering is AniDB numbering (per-entry, restarting at 1), which is how SubsPlease/Erai-raws name releases. TVDB is derived through Anime-Lists offsets, which also flips the dependency: an Anime-Lists PR is a one-line XML change reviewed on GitHub.

---

## 4. File identification

### Shoko Server (ED2K against AniDB)
- Shoko hashes every file (ED2K: MD4 over 9,500 KiB chunks, plus optional CRC32/MD5/SHA1). It then asks AniDB over UDP `FILE size+ed2k`, which returns the exact `aid`/`eid`/group/version. **Filename is irrelevant** ([community explanation](https://lemmy.klein.ruhr/post/1456/9190)). [ShokoServer](https://github.com/ShokoAnime/ShokoServer) (MIT, active 2026-10) now bundles a TMDB plugin for TMDB shows, seasons and alternate orderings, and serves Plex (Shoko Relay) and Jellyfin (Shokofin).
- **Pros:** deterministic and exact, including version (v2), release group, special or OP/ED type, and multi-episode files. Immune to bad naming.
- **Cons:** (1) Only works **after download**, so it is useless for deciding *what to grab*. (2) Needs AniDB to know the hash. Own encodes, remuxes, BD rips nobody AVDumped, and most **donghua web rips** come back "Unrecognized" and need manual linking or your own AVDump submission. (3) It needs an AniDB account and is bound by UDP flood rules (1 packet per 4 s), so the first scan of a large library is slow. (4) Hashing large libraries is I/O-heavy.
- **For AnimeArr:** use ED2K as an **optional import-time verifier**, not the primary identifier. Hash on import (this is cheap when we are already copying or hardlinking the file), batch-query AniDB UDP within the limits, and use a hash hit to confirm or override the name-based result.

### anitopy / anitomy / aniparse
- **[anitomy](https://github.com/erengy/anitomy)** (C++, MPL-2.0) is being rewritten in C++23 on `develop` (active 2026-07). **[anitopy](https://github.com/igorcmoura/anitopy)** is the Python port (last push 2024-04). There are ports for Go (anitogo) and Java (anitopy4j). (The `aniparse` repo URL now 404s.)
- **[verified] anitopy run locally:**

| Input | anitopy output | Verdict |
|---|---|---|
| `[SubsPlease] Quanzhi Fashi S7 - 05 (1080p)` | title `Quanzhi Fashi`, season `7`, ep `05`, group, 1080p | correct |
| `Quan.Zhi.Fa.Shi.S6.-.01` | title `Quan Zhi Fa Shi`, season `6`, ep `01` | correct (dots handled) |
| `[Erai-raws] Hitori no Shita: The Outcast 6th Season S6E26` | title `Hitori no Shita: The Outcast`, season `["6","6"]`, ep `26` | correct, but season is a list: dedupe it |
| `[geckyzz] Click Me All Over - S01E02v2` | title `Click Me All Over`, season `01`, ep `02`, **version `2`** | correct |
| `[SubsPlease] Mushoku Tensei S2 - 01v2 (1080p).mkv` | season 2, ep 01, version 2 | correct |
| `[Erai-raws] One Piece - 1100` | ep `1100` (no season) means absolute | correct |
| `[Judas] Shingeki no Kyojin (Season 4) [Batch] …` | season 4, `release_information: Batch`, no episode | correct: batch detected |
| `[DB] Kaguya-sama … - 01-12 [… BD1080p]` | ep `["01","12"]` (range) | correct |
| `Yi.Ren.Zhi.Xia.S06E26.1080p.WEB-DL.AAC.H264` | season 06, ep 26, **episode_title `WEB-DL`** | small bug: Western scene tokens leak into the episode title |

- **Strengths:** group tags, CRC32, v2, "S2 - 05", ranges, batch keywords, resolution and codec terms. **Weaknesses:** it does not know whether `- 05` is absolute or relative, so that has to be resolved against metadata. It is unaware of Western scene conventions (WEB-DL, `-GROUP` suffix), and of `第二季`/`2nd Season` titles inside brackets. CJK titles inside `【】` need preprocessing. Recommendation: anitopy-style tokenizer **plus** a small Sonarr-style regex layer for Western P2P names and CJK brackets (`【幻樱字幕组】`, `[第07话]`, `第7季`).

---

## 5. Donghua (Chinese animation)

- **AniDB covers donghua well**, with pinyin as the `main` title (`x-zht` = romanised Chinese) and Chinese official titles. **[verified]** Quanzhi Fashi I–VIII = aids 13171, 13469, 14572, 15397, 16490, 16579, **19920 (VII)**, **20253 (VIII)**, plus special 19503. Hitori no Shita / Yi Ren Zhixia 1–7 = 12200, 13068, 15599, 16719, 17095, **19808 (S6)**, 20144, plus side entries 16371, 19824, 19840. Pinyin spelling is **inconsistent inside AniDB** (`Yi Ren Zhixia` main vs `Yi Ren Zhi Xia` synonym), so normalisation must join and split syllables.
- **Anime-Lists coverage lags for donghua.** **[verified]** Quanzhi Fashi I–VI map to TVDB 328670 seasons 1–6 (TMDB 70311), but **VII and VIII have no TVDB/TMDB mapping**. Hitori S1–S6 map to TVDB 313488 seasons 1–6 (TMDB 67063), and S7 (20144) is unmapped. Mouse Cursor (19858) → TVDB 473125 S1 with no TMDB.
- **Bangumi** is the authoritative database for Chinese titles: complete `name_cn`, per-season subjects, per-episode lists with types, and air dates. **[verified]** Hitori S6 = bgm 507819, **26 episodes** from 2026-01-02, so `S6E26` is the season finale and valid. Use it (a) for alias coverage (Chinese titles and fan abbreviations from `别名`) and (b) as a **second episode-count/air-date source** when AniDB is slow to add episodes.
- **MAL/AniList** cover the bigger donghua (with English titles like "Versatile Mage") but often lag on later seasons. **TVDB/TMDB** frequently merge seasons or use an English title that no fan release uses.
- **Release naming patterns:** pinyin with or without syllable joins (`Quanzhi Fashi` / `Quan Zhi Fa Shi` / `Quan.Zhi.Fa.Shi`), an `S6`/`Season 6`/`第六季` season token, **per-season** episode numbers (01–12), and sometimes a continuing absolute count, especially long-runners like *Wu Dong Qian Kun* or *Soul Land* (Douluo Dalu) with hundreds of episodes. English branding varies too (Full-Time Magister vs Versatile Mage).

---

## 6. Proposed AnimeArr identification design

### 6.1 Canonical ID model

```
Franchise (fid: internal)                      e.g. "Quanzhi Fashi"
 └─ Entry (key = anidb:aid; fallbacks: bgm:id, anilist:id, local:uuid)
     kind: TV | TV_SHORT | ONA | OVA | MOVIE | SPECIAL | MUSIC
     mainline_index: 1..n      (order among TV/ONA mainline seasons in the franchise)
     cour_group: optional       (split cours AniDB keeps separate but fans call "S2")
     episodes: [ {epno: "1".."n" | "S1" | "C1" | "T1" | "O1", type, airdate, length_min, title{...}} ]
     xref: {mal, anilist, kitsu, bgm, tvdb:{series, season, offset, mapping[]}, tmdb:{tv, season, offset} | {movie}, imdb}
     provenance per field: anime-lists | aod | bgm | inferred | user
```
- **Primary key = AniDB aid.** It has the best structure and the best titles, and it is the key every mapping project uses. For titles AniDB lacks (rare, or very new donghua), the entry is created from **Bangumi** or **AniList** and gets an aid later through a merge.
- **Franchise** = connected component over the AniDB relations `sequel`/`prequel` (main line) plus `side story`/`parent story`/`summary`/`alternative version` (attached as non-mainline). This is computed locally from the AniDB HTTP `anime` XML (cached) or AOD `relatedAnime`. `mainline_index` = topological order of TV/ONA entries along the sequel chain, tie-broken by start date. **This index is what fan "S7" means.**
- **User-facing model:** a franchise is a "Series" (like Sonarr). Each mainline entry is a "Season" (numbered by `mainline_index`). Movies, OVAs and specials appear as their own sections, not jammed into Season 0.
- **Compatibility projection:** each entry's TVDB/TMDB coordinates come from Anime-Lists. File naming can use either **AniDB style** (`Quanzhi Fashi VII - 05`) or **TVDB style** (`S07E05`), so Plex/Jellyfin agents (HAMA, Shokofin, TVDB) are all happy.

### 6.2 Alias index
- **Sources:**
  - AniDB `anime-titles.xml.gz` (daily, all languages)
  - cedya77 AOD `title` + `synonyms` (weekly)
  - AniList/MAL synonyms (lazy, per followed show)
  - Bangumi `name`, `name_cn`, infobox `别名`/`中文名` (weekly archive or per-show API)
  - TVDB/TMDB English titles and aliases (for Western P2P names)
  - **user aliases**
  - **learned aliases**: the parsed title from any release the user confirmed in manual import
- **Normalisation key** (store several per title):
  1. NFKC, lowercase, strip diacritics, transliterate full-width.
  2. Turn punctuation (`. _ - : ! ? ' ’ ~ ,`) into spaces and collapse whitespace.
  3. Remove all spaces into a **compact key** (`quanzhifashi`), which makes `Quanzhi Fashi` = `Quan Zhi Fa Shi` = `Quan.Zhi.Fa.Shi` and `Yi Ren Zhixia` = `Yi Ren Zhi Xia`.
  4. Pull out a **season suffix** and store it separately from the base: roman `II…X`, `2nd/3rd/Nth Season`, `Season N`, `SN`, `Part N`, `Cour N`, `第N季`/`第N期`, trailing ` N`.
  5. Simplified↔Traditional Chinese folding (OpenCC) and kana→romaji for Japanese-script titles.
- **Index:** exact hash on the compact key, then a trigram/token-set index (e.g. SQLite FTS5, or RapidFuzz in memory, about 300k titles) for fuzzy matching. Each hit gives `(aid, title_type, lang, implied_season?)`. Example: `Quanzhi Fashi S7` → aid 19920 directly, because AniDB lists it as a synonym.
- **Scoring:** exact compact match on `main`/`official` > `syn` > `short` > fuzzy. Penalise a hit whose entry kind conflicts with the parse (movie vs episode number). Prefer franchises the user is monitoring (huge precision win: search only the library first, then the global index).

### 6.3 Parsing strategy
1. **Tokenise** with anitomy (C++ via FFI, or a port), plus a pre-pass for CJK brackets and a post-pass with Western scene regexes (`SxxEyy`, `-GROUP`, `WEB-DL`, `REPACK/PROPER` → version).
2. Extract `group, title, season_token, episode(s) | range | batch, version, special markers (OVA, SP, OAD, Movie, NCOP/NCED, PV), resolution, source, crc32`.
3. **Per-entry release rules** (learned or user-defined), keyed on `(franchise, group)`. Example: `{group: "SubsPlease", numbering: "per-entry"}` or `{group: "XYZ", numbering: "absolute-from-franchise-start"}` or `{group: "ABC", title_regex: "...", entry: aid 19920}`. These replace XEM's "one scheme per show" with **one scheme per (show, group)**.
4. **Title → candidates** via the alias index (§6.2). If the matched alias implies a season (`Quanzhi Fashi VII`, `The Outcast 6`), that wins over the season token unless they conflict. On conflict, flag for review.

### 6.4 Numbering resolver
Input `(franchise candidates, season_token?, ep, absolute?)`. Output `(aid, epno)`, then project to TVDB/TMDB.

1. **Alias implies an entry**: use it, and `ep` is per-entry.
2. **Season token `S{n}`** (fan convention): entry = mainline entry with `mainline_index == n`. Validate `ep <= entry.episode_count` (allow +1 when the count is unknown or still airing). Cross-check: if Anime-Lists says that entry is `tvdbseason == n`, confidence is high. If `n` matches a *TVDB* season but not a mainline index (split-cour franchise), use Anime-Lists to find the aid whose `defaulttvdbseason == n` and apply `episodeoffset` in reverse. Example: TVDB S02E15 → aid of part 2, ep 3 when the offset is 12.
3. **No season, bare number `- 1100`**:
   - (a) If `ep <=` episode count of the newest airing entry and the group rule says per-entry, treat it as per-entry.
   - (b) Otherwise treat it as **franchise-absolute**: walk mainline entries cumulatively (`Σ episode_count`) to find the entry and local episode. One Piece-style single long entries just map 1:1.
   - (c) If both readings are valid, pick the one whose expected **air date** is closest to the release's publish date. A new release of an airing show is almost always the newest entry.
4. **Projection to TVDB/TMDB:** apply `<mapping-list>` if present, else `defaulttvdbseason` + `episodeoffset`. `a` means use TVDB absolute order. `<before>` places specials.
5. **Fallback when Anime-Lists has no mapping** (common for new seasons: 78% of aids ≥ 19500 are unmapped):
   - Same-series inference: if the prequel maps to TVDB series X season k and the new entry is the next mainline entry, propose `X, season k+1, offset 0`, marked `provenance=inferred`. Verify against TVDB/TMDB episode **air dates** (±2 days) and **runtime** (±20%), and accept when ≥ 80% of known episodes align.
   - Otherwise align by air order: sort TVDB episodes of the candidate series by air date and match them to AniDB/Bangumi episodes by air date and runtime. Short specials and recaps are filtered by runtime.
   - Record the result as a **local mapping** (§6.7) so it is visible and can be contributed back.
6. **Confidence:** each step yields a score. Below the threshold, the release is held for manual review, not grabbed.

### 6.5 Specials, OVAs, movies
- AniDB types drive routing: `S#` → specials of that entry. `C#` (OP/ED/NCOP) and `T#` (trailer/PV) are **ignored by default** (opt-in "extras"). `O#` goes to extras.
- OVA/ONA/Special-kind entries in a franchise are shown as separate sub-series. For TVDB naming they go to Season 0 using Anime-Lists `defaulttvdbseason="0"` + offset (e.g. a movie as S00E12).
- **Movies:** entries of kind MOVIE get Radarr-like handling: monitored separately, searched by title + year, named with `tmdbid`/`imdbid`. This is how AnimeArr covers the "Radarr" half without a second app.
- Parser markers `OVA`, `OAD`, `SP`, `Special`, `Movie`, `Gekijouban`, `劇場版`, `剧场版`, `特别篇` steer the candidates toward non-TV entries. For example `Quanzhi Fashi Tebie Pian` → aid 19503.

### 6.6 Caching and rate limits
- **Bulk dumps first, APIs second:**
  - AniDB titles: once per 24 h with `If-Modified-Since`, never more.
  - Anime-Lists XML: daily via the GitHub raw ETag.
  - cedya77 AOD: weekly `latest` release.
  - Bangumi Archive: weekly.
  - Optionally a community **AnimeArr mirror** of these dumps, so thousands of installs do not hit anidb.net.
- **AniDB HTTP `anime` details:** only for monitored franchises, cached 7 days for finished shows and 24 h for airing ones. A global token bucket allows **1 request per 2.5 s** and a self-imposed daily cap of about 100–150. On any `<error>banned</error>`, stop all AniDB traffic for 24 h and back off. Send a registered `client`/`clientver`.
- **AniDB UDP** (optional ED2K verify): one session, 1 packet per 4 s after a burst of 5, a persistent local port, an exponential AUTH back-off, and a durable queue.
- **AniList:** under 25 req/min, batching IDs with GraphQL `id_in`. Used for airing schedules and art.
- **TVDB/TMDB:** per-show cache. Refresh airing shows every 6 h and ended shows weekly.
- **Bangumi:** descriptive UA, under 1 req/s.
- All cache entries keep `fetched_at`, `etag` and `source`. Resolution must still work offline from the dumps alone.

### 6.7 Local corrections and contributing back
- **Override layers** (later wins): `upstream dumps` < `AnimeArr community overrides` (a signed JSON published by the project, like Kometa's `anime_id_edits.json`) < `user overrides`.
- **Override schema = Anime-Lists schema** (`anidbid`, `tvdbid`, `defaulttvdbseason`, `episodeoffset`, `mapping-list`, `tmdbtv`…) plus AnimeArr extras: `aliases[]`, `group_rules[]`, `bgm_id`, `mainline_index` fix.
- **UI:**
  - Manual import "this file is X ep N", which offers "remember for this group" and "remember alias".
  - A per-season "TVDB season/offset" editor showing a side-by-side AniDB vs TVDB episode table with air dates (essentially a local XEM, but per entry and visual).
  - A "Why was this matched?" explanation listing alias, rule and offset provenance.
- **Contribute back:**
  - "Export as Anime-Lists PR" generates the XML snippet and opens a prefilled GitHub issue or PR to Anime-Lists/anime-lists.
  - Alias corrections can be submitted to AnimeArr's community overrides repo.
  - Optional opt-in telemetry of confirmed `(group, parsed title, aid)` triples, to grow the alias and group-rule set automatically, with review.
  - ED2K hashes of unrecognised files can be AVDumped to AniDB (user's own account), which helps Shoko users too.

### 6.8 Walk-throughs

**A. `[SubsPlease] Quanzhi Fashi S7 - 05 (1080p)`**
1. Parse: group SubsPlease, title `Quanzhi Fashi`, season 7, ep 05, 1080p.
2. Alias: compact `quanzhifashi` exactly matches aid 13171 (main title). The franchise is "Quanzhi Fashi" (13171 → 13469 → 14572 → 15397 → 16490 → 16579 → 19920 → 20253; side: 19503). Separately, `Quanzhi Fashi S7` is itself an AniDB synonym of **19920**, which reinforces the result.
3. Season token 7 = mainline_index 7 = aid **19920** (Quanzhi Fashi VII, 12 eps on bgm 507822, airing since 2026-05-13). ep 5 ≤ 12, so the result is **aid 19920 ep 5**.
4. Projection: Anime-Lists has **no TVDB/TMDB for 19920**. The inference step uses the prequel 16579 → TVDB 328670 S6, proposes TVDB 328670 **S07E05**, and verifies by air date against TVDB. It is stored as an `inferred` mapping, and the UI offers "submit to Anime-Lists".

**B. `Quan.Zhi.Fa.Shi.S6.-.01`**
1. Parse: title `Quan Zhi Fa Shi`, season 6, ep 01, no group.
2. Alias: compact `quanzhifashi` is the same franchise (also an exact AniDB `syn` of 13171).
3. S6 = mainline 6 = aid **16579** (Quanzhi Fashi VI), ep 1.
4. Projection: Anime-Lists 16579 → TVDB 328670 season 6, TMDB 70311 season 6, so **S06E01**. (Sonarr today needs an XEM alias to even find this release.)

**C. `[Erai-raws] Hitori no Shita: The Outcast 6th Season S6E26`**
1. Parse: title `Hitori no Shita: The Outcast`, season `[6,6]` deduped to 6, ep 26.
2. Alias: `hitori no shita the outcast` exactly matches aid 12200 (main). The franchise walks 12200 → 13068 → 15599 → 16719 → 17095 → 19808 → 20144. Side entries 16371, 19840 and others are non-mainline. The stripped suffix "6th Season" also hits the 19808 synonym `Hitori no Shita: The Outcast 6`, so it agrees.
3. Entry aid **19808**, ep 26. Bangumi 507819 says 26 eps, so it is valid (the finale).
4. Projection: Anime-Lists 19808 → TVDB 313488 season 6, so **S06E26** (TMDB 67063 S6).

**D. `[geckyzz] Click Me All Over - S01E02v2`**
1. Parse: title `Click Me All Over`, S01, ep 02, **version 2**.
2. Alias: `click me all over` is an AniDB `syn/en` of aid **19858** (*Mouse Cursor de Genjitsu o Sousa Dekiru You ni Natta no de…* / "Now That I Can Control Reality With A Mouse Cursor…"). It is a single-entry franchise.
3. aid 19858 ep 2. Version 2 means **upgrade/replace v1** (a version bump is treated as a PROPER within the same quality).
4. Projection: Anime-Lists 19858 → TVDB 473125 S1, so **S01E02**. There is no TMDB in Anime-Lists, so the TMDB ID is filled by TMDB search (Fribb-style) and marked `inferred`.

---

## Sources
- AniDB: https://wiki.anidb.net/HTTP_API_Definition · https://wiki.anidb.net/UDP_API_Definition · https://anidb.net/api/anime-titles.xml.gz · https://github.com/Vagab0nd/AniDB.Api · https://www.filebot.net/forums/viewtopic.php?p=52035 · https://wiki.anidb.net/Special:MobileDiff/5774 · https://yumemi.readthedocs.io/en/latest/api.html
- AniList: https://docs.anilist.co/guide/rate-limiting
- MAL: https://github.com/SuperMarcus/myanimelist-api-specification
- Kitsu: https://animedex.readthedocs.io/en/latest/tutorials/backends/kitsu.html
- TVDB: https://www.thetvdb.com/api-information · TMDB orderings: https://community.firecore.com/t/tmdb-and-animes-the-good-way-to-rename/35177.md
- Bangumi: https://github.com/bangumi/api · https://github.com/bangumi/Archive · https://github.com/bangumi-data/bangumi-data · https://api.bgm.tv/v0
- Mapping: https://github.com/Anime-Lists/anime-lists · https://github.com/Fribb/anime-lists · https://github.com/manami-project/anime-offline-database · https://github.com/cedya77/anime-offline-database · https://github.com/beeequeue/arm-server · https://github.com/Kometa-Team/Anime-IDs · https://github.com/nattadasu/animeApi
- XEM / Sonarr: https://github.com/Servarr/Wiki/blob/master/sonarr/xem-guide.md (= https://wiki.servarr.com/sonarr/xem-guide) · https://github.com/Servarr/Wiki/blob/master/sonarr/faq.md · https://forums.sonarr.tv/t/thexem-vs-tvdb-question/30176 · https://www.filebot.net/forums/viewtopic.php?p=44285
- Shoko / parsers: https://github.com/ShokoAnime/ShokoServer · https://lemmy.klein.ruhr/post/1456/9190 · https://github.com/erengy/anitomy · https://github.com/igorcmoura/anitopy
