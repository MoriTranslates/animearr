# AnimeArr: the *arr ecosystem, and what to absorb

*Research date: 2026-10-25. Web research only. Status and licence data come from GitHub, Docker Hub and Unraid CA listings, community posts, and prior knowledge (cutoff mid-2026). A "?" marks anything not re-verified this session; check it before relying on it.*

Companion docs: `01_codebase.md`, `02_metadata_mapping.md`.

---

## 0. The classification rule (from the user)

| Type | Meaning | Default verdict |
|---|---|---|
| **fixer** | Exists to fix or clean up a Sonarr/Radarr shortcoming: queue cleaners, stall/strike handlers, unpackers, profile syncers, missing/upgrade hunters, swap helpers, scene/ID-mapping fixes, dub tagging, track stripping, etc. | **ABSORB.** Build AnimeArr so the problem never exists. |
| **new-capability** | A genuinely different job: download clients, indexers, media servers, transcoding, request front-ends for *other* users, watch-tracking sync, IRC announce grabbing, etc. | **INTEGRATE** (talk to it via API) or **KEEP SEPARATE.** Absorb only if it's trivial and clearly better. |

Other verdicts: **IRRELEVANT** = no anime value, or the tool is dead. Exceptions to the default are marked **(EXC)** and explained in section 3.

---

## 1. Ecosystem verdict table

### 1.1 Queue and maintenance

| App | Type | What it patches | Active? (last seen) | Licence | Verdict | If ABSORB: key behaviours |
|---|---|---|---|---|---|---|
| **Cleanuparr** | fixer | *arr leaves stalled, failed-import, slow or malicious torrents in the queue forever | Active (2026; no version badge on repo page) | GPL-3.0 | **ABSORB** (already planned) | 1) Strike system: N strikes, then remove, blocklist and re-search. 2) Malware/extension blocker (community patterns; .exe/.lnk/.scr in "anime" torrents). 3) Orphan/no-hardlink seeding cleanup, cross-seed aware. |
| **Decluttarr** | fixer | Same as Cleanuparr: stalled, failed, missing-file and unmonitored queue items | Active? (Python; credited by Cleanuparr) | GPL-3.0? | **ABSORB** | 1) Remove items stuck "downloading metadata". 2) Remove queue items whose series or episode was unmonitored or deleted. 3) "Permitted attempts" before removal, with auto re-search. |
| **Swaparr** | fixer | Slow torrents never time out in *arr | Active? (Rust) | MIT? | **ABSORB** | 1) ETA/size thresholds per strike. 2) Ignore still-queued items. 3) Configurable check interval. |
| **Huntarr** | fixer | *arr never re-searches the backlog of missing items or cutoff-unmet upgrades | **Dead.** Feb 2026: alleged auth bypass and exposed API keys (v9.4.2); repo and subreddit went dark. The Newtarr fork took over (per ElfHosted). | GPL-3.0 | **ABSORB** | 1) Rate-limited round-robin backlog search (N items per run, respect indexer API caps). 2) Separate "missing" and "upgrade" queues. 3) Per-indexer hourly cap and pause window. |
| **Newtarr / seekarr** | fixer | Huntarr successors (seekarr adds "upgrade source: wanted list / monitored / both") | New in 2026 | ? | **ABSORB** (same module as Huntarr) | Search monitored items that already have files, not only the wanted list. |
| **Unpackerr** | fixer | *arr can't import RAR'd releases | Active | MIT | **ABSORB** (already planned) | 1) Extract on completion, then trigger import. 2) Delete the extracted copy after import, keep the RAR for seeding. 3) Handle nested archives. |
| **qbit_manage** | fixer (of qBit hygiene) | Torrent client tagging, share limits, orphan files, unregistered torrents, "noHL" tagging | Active | MIT | **ABSORB (partial) (EXC)** | Only for torrents AnimeArr grabbed: 1) tag by tracker/category, 2) share-ratio and seed-time rules per tracker, 3) drop unregistered torrents and re-search. Keep qbit_manage itself for non-AnimeArr torrents. |
| **Checkrr** | fixer | *arr imports corrupt or truncated files and never notices | Active? | MIT? | **ABSORB** | 1) ffprobe/ffmpeg decode check on import and on schedule. 2) Duration vs. expected runtime check. 3) Auto-blocklist and re-grab on failure. (Heavy full-decode can stay with Tdarr health checks.) |
| **Maintainerr** | fixer | *arr has no retention or watched-based cleanup | Active | MIT | **ABSORB (anime-scoped)** | 1) Rule engine: watched by all, age, rating, and "airing finished, nobody watching". 2) Show a "leaving soon" collection before deleting. 3) Unmonitor plus delete files, with optional exclusion. |
| **Janitorr** | fixer | Same idea, for Jellyfin/Jellyseerr | Active? | GPL-3.0? | **ABSORB** (same module as Maintainerr) | Disk-space-triggered cleanup (only delete when free space < X%). |
| **Deleterr / Cleanarr** | fixer | Stale media deletion; duplicate/sample cleanup | Low activity | various | **ABSORB** (same module) | Duplicate-file and sample detection on import. |
| **Prunerr** | fixer | Long-term seeding vs. disk space | Low activity | GPL-3.0? | **ABSORB** (seeding rules) | Seed-until rules per tracker. |
| **Toolbarr** | fixer (Sonarr DB repair) | Corrupt *arr SQLite DBs | Low activity | ? | **IRRELEVANT** | Own schema; add a DB integrity check plus backup/restore instead. |
| **autobrr** | new-capability | IRC announce and RSS racing, faster than *arr RSS | Active (2026) | GPL-2.0 | **INTEGRATE** | AnimeArr exposes a "push release to approve" endpoint (like Sonarr's `/release/push`) so autobrr filters can hand off anime releases. |
| **cross-seed** | new-capability | Seeds the same data on more trackers | Active (v6.x) | Apache-2.0 | **INTEGRATE** | Call its webhook on import. Keep hardlinks intact; never delete cross-seeded data as an "orphan". |

### 1.2 Config and sync

| App | Type | What it patches | Active? | Licence | Verdict | If ABSORB: key behaviours |
|---|---|---|---|---|---|---|
| **Recyclarr** | fixer | Hand-maintaining TRaSH custom formats and quality profiles | Active | MIT | **ABSORB** (already planned) | 1) Pull TRaSH anime CF/profile JSON by trash_id. 2) Idempotent sync with score overrides. 3) Diff preview before applying. |
| **Configarr** | fixer | Recyclarr alternative (TS, supports custom CFs and more apps) | Active | AGPL-3.0? | **ABSORB** (same module) | Local custom formats merged with TRaSH, and YAML import of user overrides. |
| **Profilarr** (Dictionarry) | fixer | GUI for profiles and CFs; v2 adds multi-database, multiple naming/quality configs, delay profiles as a separate config type | Active (v2.0.x) | GPL-3.0? (AGPL?) | **ABSORB** (same module) | 1) Versioned profile "databases" from git, with local edits. 2) Pick naming/quality presets per library. 3) Scheduled repo sync and backups. |
| **Buildarr** | fixer | Declarative *arr deployment config | Low activity since 2024 | GPL-3.0 | **ABSORB (lightweight)** | Export and import the whole AnimeArr config as one YAML/JSON file (config-as-code). |
| **Flemmarr** | fixer | Same | Dormant | ? | **IRRELEVANT** | Covered by the above. |
| **Notifiarr** | mixed | Discord notifications, plus TRaSH sync, plus "stuck queue" alerts; the client is open, the website is a paid service | Active | Client MIT; service proprietary | **ABSORB the fixer parts; KEEP SEPARATE the service (EXC)** | Rich anime notifications (cover, episode, group, SeaDex badge). Use Apprise as the transport, not Notifiarr's cloud. |

### 1.3 Requests and discovery

| App | Type | What it patches | Active? | Licence | Verdict | If ABSORB: key behaviours |
|---|---|---|---|---|---|---|
| **Overseerr / Jellyseerr then Seerr** | new-capability | Request UI for other users | **Merged into Seerr** (first release 15 Feb 2026); Overseerr/Jellyseerr sunset around May 2026 | MIT | **INTEGRATE, via Tastearr** | AnimeArr accepts requests from Tastearr/Seerr through a Sonarr-compatible API shim, so Seerr can point at AnimeArr as if it were Sonarr. |
| **Ombi** | new-capability | Older request app | Active, slow | GPL-2.0 | **IRRELEVANT** | Seerr/Tastearr cover it. |
| **Doplarr / Requestrr / Searcharr / Addarr / Botdarr** | new-capability | Chat-bot requests (Discord/Telegram) | Doplarr and Requestrr low activity; Requestrr effectively stalled? | MIT (mostly) | **KEEP SEPARATE** (Phase 4: maybe one Discord/Telegram bot) | n/a |
| **Listrr** | new-capability | Filtered auto-updating lists (hosted service) | Active (hosted) | proprietary | **IRRELEVANT** | Anime lists come from AniList/MAL directly. |
| **Watchlistarr / Pulsarr** | fixer (*arr can't follow Plex watchlist fast) | Plex watchlist to Sonarr/Radarr in real time | Pulsarr active (2026); Watchlistarr slower | MIT / GPL-3.0 | **ABSORB** | 1) Poll or RSS the Plex watchlist (per user). 2) Route anime-flagged items to AnimeArr. 3) Per-user approval rules. |
| **anilistarr** (wwmoraes) | fixer | Sonarr can't import an AniList list | Low activity, "WIP" | MIT | **ABSORB** | 1) AniList/MAL list to series, via the mapping datasets. 2) Status filter (Watching / Planning). 3) Expose as a custom-list endpoint for *arr (compat). |
| **Animetarr** (kariudo) | fixer | No seasonal-anime browsing in Sonarr | Low activity | ? (TS) | **ABSORB** | Seasonal chart (current/next season) with one-tap add, matched to TVDB and AniDB. |
| **ani2arr** (Firefox extension) | fixer | Add-to-Sonarr buttons on AniList/AniChart | Active 2025–26 | ? | **INTEGRATE** | Provide a Sonarr-compatible add API so it works against AnimeArr. Later, an "add" bookmarklet or PWA share target. |
| **SuggestArr** | new-capability | Recommendations from watch history | Active | MIT? | **IRRELEVANT** | Tastearr covers this. |
| **Prefetcharr / Episeerr** | fixer | *arr downloads whole series up front; these fetch the next season/episodes as you watch | Active (small) | MIT? | **ABSORB** | 1) Monitor season N+1 when season N is at 70% watched. 2) Optional "rolling window" for long shounen (One Piece). |
| **Reiverr** | new-capability | Alternative UI and request front-end | Active | AGPL? | **IRRELEVANT** | n/a |
| **Traktarr / Letterboxd List Radarr / Collectarr** | fixer | List imports | Mixed | various | **IRRELEVANT** (non-anime) | The AniList/MAL list module covers anime. |
| **Excludarr / Proxarr** | new-capability | Skip titles available on streaming services | Low activity | ? | **IRRELEVANT** (Phase 4 optional: "on Crunchyroll" badge) | n/a |

### 1.4 Anime-specific

| App | Type | What it patches | Active? | Licence | Verdict | If ABSORB: key behaviours |
|---|---|---|---|---|---|---|
| **SeaDex / releases.moe** (dataset) | (data) | Curated "best release" per anime | Active | data/API | **ABSORB as a data source** | Core of the decision engine (see `03_spec_roadmap.md`). |
| **SeaDexArr** | fixer | Sonarr grabs worse releases than the SeaDex pick | Active (PyPI) | GPL-3.0? | **ABSORB** | 1) Map series via AniList, then SeaDex entry. 2) Compare release group *and* size against the file on disk (or match torrent hash). 3) Grab the best release automatically or notify. |
| **seadex-scout** (cplieger) | fixer | Report-only SeaDex audit, plus an optional Torznab feed of SeaDex picks | Active (Docker Hub updated Oct 2026) | ? | **ABSORB** | 1) Season-by-season audit report (Markdown/JSON) = AnimeArr Phase 0 "See the mess". 2) Keep-encodes/drop-remuxes filter. 3) Torznab-of-picks is a neat trick: AnimeArr can expose its own Torznab feed for legacy Sonarr. |
| **sonarr-seadex-proxy** (gabehf) | fixer | Torznab proxy that boosts SeaDex releases | Small | ? | **ABSORB** (same module) | n/a |
| **Anime-Lists / Fribb anime-lists / Kometa Anime-IDs / manami anime-offline-database / AniBridge mappings** | fixer (data) | Sonarr's TVDB-only model vs. AniDB/AniList seasons | Active (Kometa Anime-IDs cached copy last generated Aug 2024; check freshness) | various open | **ABSORB as data** | 1) Merged ID graph (AniDB, AniList, MAL, TVDB, TMDB, IMDb). 2) Episode offset and season mapping from anime-lists XML. 3) Local override layer, with upstream PR export. |
| **TheXEM / scene mapping** | fixer | Scene numbering vs. TVDB numbering | Active (thexem.info) | service | **ABSORB** (consume) | Absolute to season mapping for release parsing. |
| **Taggarr / Langarr** | fixer | Sonarr can't tell dub, semi-dub or wrong-dub from the file | Taggarr new (2025–26); Langarr AI-generated code | ? | **ABSORB** | 1) Read audio track languages with ffprobe. 2) Tag dub / semi-dub / wrong-dub. 3) Dual-audio as a decision-engine preference. |
| **AutoBangumi** | fixer (no Sonarr-like tool fits fansub RSS) | RSS subscription to Mikan/fansub feeds, title parsing, qBit download and rename | Active (3.3.x, 2026; LLM parser plugins) | MIT | **ABSORB the behaviours (EXC: not the app)** | 1) "Follow this group for this show" RSS rules. 2) Robust bilingual/fansub title parser (reference its parser and tests). 3) Auto-rename to a media-server-friendly layout. |
| **Shoko Server (+ Shokofin, Shoko Relay)** | new-capability | AniDB-hash identification, grouping, metadata server | Active | MIT | **INTEGRATE (optional)** | Use Shoko as an identification oracle when present (ED2K hash to AniDB file). Don't replace it. |
| **PlexAniSync** (RickDB) | new-capability | Plex watch status to AniList | Low activity (GitHub topic updated May 2024; container rebuilt 2026) | GPL-3.0 | **KEEP SEPARATE** (superseded by AniBridge) | n/a |
| **AniBridge** (formerly PlexAniBridge, eliasbenb) | new-capability | Plex/Jellyfin/Emby to AniList/MAL watch sync, with dashboard and mapping editor | Active 2026 | MIT | **INTEGRATE** | Read its mappings dataset. Optionally show the sync state. Don't rebuild watch-sync. |
| **Taiga / MAL-Sync** | new-capability | Desktop/browser watch tracking | Taiga slow; MAL-Sync active | GPL-3.0 | **IRRELEVANT** | Client-side. |
| **Seanime** | new-capability | AniList-centric anime media server, player and torrent streaming | Very active (v3.10.x, Jul 2026) | GPL-3.0 (AUR says MIT; check) | **KEEP SEPARATE** (borrow UI ideas) | It's a player/server, not an arr. Its AniList-first library UI is a design reference. |
| **HAMA** (Plex AniDB agent) / **ASS** (Absolute Series Scanner) | fixer (Plex side) | Plex can't order anime by AniDB/absolute numbering | **On borrowed time:** Plex deprecated legacy agents and recent PMS builds hide them (Feb 2026 forum) | GPL-3.0 | **IRRELEVANT for AnimeArr, but a design constraint (EXC)** | AnimeArr must name and lay out files so the *modern* Plex TV agent (TVDB ordering) and Jellyfin's AniDB/AniList plugins match natively, with no HAMA/ASS. |
| **Jellyfin AniDB/AniList plugins** | new-capability | Jellyfin anime metadata | Active | GPL | **KEEP SEPARATE** | Naming compatibility only. |

### 1.5 Subtitles

| App | Type | What it patches | Active? | Licence | Verdict | If ABSORB: key behaviours |
|---|---|---|---|---|---|---|
| **Bazarr** | fixer | *arr ignores subtitles | Active (1.5/1.6 dev) | GPL-3.0 | **ABSORB** (already planned) | 1) Per-language profiles with "forced/signs" handling. 2) Providers (anime: Jimaku, AnimeTosho attachments, SubDL, OpenSubtitles). 3) Embedded-track awareness: don't fetch when the release already has good ASS subs. |
| **subgen** (McCloudS) | new-capability | Whisper transcription to .srt (webhook or Bazarr provider) | Active (Docker tag 2026.04.x) | MIT | **INTEGRATE / superseded by MoriSubs** | Treat it as an optional external Whisper backend; MoriSubs is primary. |
| **whisper-asr-webservice** | new-capability | Whisper HTTP API used by Bazarr | Active | MIT | **INTEGRATE** (backend option) | n/a |
| **subarr** | fixer | Glue between Bazarr and subgen for gaps | New (v1.6.0) | ? | **ABSORB** (it's exactly the MoriSubs-gap-fill logic) | Generate only when no acceptable subtitle exists after the provider search. |
| **Lingarr** | fixer (Bazarr can't translate) | Translate subtitles via DeepL/LibreTranslate/LLMs, watching Sonarr/Radarr | Active (1.2.x) | AGPL-3.0? | **ABSORB** | 1) Translate the best existing subtitle into the target language when none exists. 2) Pluggable backends (LLM, DeepL, local). 3) Preserve ASS styling and timing (translate text only). |
| **LLM-Subtrans (gpt-subtrans)** | new-capability | LLM subtitle translation with context batching | Active | MIT | **INTEGRATE as a library or reference** | Scene-batched context translation technique. |
| **Subtitle Edit (CLI)** | new-capability | OCR of PGS/VobSub, sync, fixes | Active | GPL-3.0 | **INTEGRATE** (shell out for PGS OCR / sync) | n/a |
| **WhisperSubs** (Jellyfin plugin) | new-capability | In-Jellyfin subtitle generation | New | ? | **IRRELEVANT** (MoriSubs) | n/a |

### 1.6 Media processing

| App | Type | What it patches | Active? | Licence | Verdict | If ABSORB: key behaviours |
|---|---|---|---|---|---|---|
| **Tdarr** | new-capability | Distributed transcoding and health checks | Active | Proprietary freemium | **KEEP** (user decision); INTEGRATE | Trigger a Tdarr scan on import; read its health-check result. |
| **Unmanic / FileFlows / Transcoderr** | new-capability | Alternative transcode pipelines | Active | GPL-3.0 / proprietary / ? | **KEEP SEPARATE** | n/a |
| **Muxarr / Radarr-striptracks / mkvtoolnix scripts / FileFlows track-order plugins** | fixer | *arr can't set default audio/sub tracks or strip junk tracks | Active (small) | various | **ABSORB (EXC: lightweight remux only)** | 1) mkvmerge/mkvpropedit with no re-encode: set default audio (JP) and default subtitle (full English, not signs). 2) Strip unwanted languages and commentary per profile. 3) Fix track language and name flags. Re-encoding stays in Tdarr. |
| **Trailarr** | new-capability | Trailers | Active | GPL-3.0? | **IRRELEVANT** (Phase 4 optional: OP/ED themes would be more anime-relevant) | n/a |
| **Posterizarr / Posteria / Kometa overlays** | new-capability | Artwork | Active | various | **KEEP SEPARATE** (Kometa collections already absorbed; posters out) | n/a |

### 1.7 Notifications and monitoring

| App | Type | What it patches | Active? | Licence | Verdict | If ABSORB: key behaviours |
|---|---|---|---|---|---|---|
| **Apprise** | new-capability (transport) | 100+ notification targets | Active | BSD-2 | **INTEGRATE** (as a library or API) | n/a |
| **Calendarr** | fixer | No weekly airing digest from *arr | Small | ? | **ABSORB** | Weekly/daily "airing this week" digest, plus iCal feed. |
| **Tautulli / Tracearr** | new-capability | Plex playback stats | Active | GPL-3.0 | **INTEGRATE** | Read watch history for Prefetch, retention and Tastearr. |
| **Autoscan / Autopulse** | fixer | *arr triggers full-library scans, or none | Active | MIT? | **ABSORB** | Targeted folder refresh in Plex/Jellyfin on import, rename or delete. |
| **Exportarr / Scraparr** | new-capability | Prometheus metrics | Active | MIT | **ABSORB trivially (EXC)** | `/metrics` endpoint, a few lines in Fastify. |
| **Uptime Kuma / Monitorr** | new-capability | Up/down monitoring | Active | MIT | **INTEGRATE** | `/health` endpoint plus a dependency health panel (SAB, qBit, Prowlarr, Plex). |

### 1.8 Mobile

| App | Type | What it patches | Active? | Licence | Verdict | Notes |
|---|---|---|---|---|---|---|
| **LunaSea** | fixer (no mobile *arr UI) | Mobile *arr control | **Discontinued** (2024–25: store-address rules); fork Zagreus | GPL-3.0 | **IRRELEVANT** (dead) | The phone-first PWA replaces it. |
| **nzb360** | fixer + client control | Android *arr, SAB and qBit control | Active | Proprietary | **ABSORB the *arr half (EXC: still useful for SAB/qBit)** | PWA covers queue, calendar, search and add. Users may keep nzb360 for raw client control. |
| **Ruddarr** | fixer | iOS Radarr/Sonarr | Active | MIT | **ABSORB** (PWA) | Its clean "add" flow is a reference. |
| **Helmarr** | fixer | iOS *arr app | Active? | Proprietary | **ABSORB** (PWA) | n/a |
| **ArrMatey / Icarus Manager** | fixer | Newer multi-service apps | New | ? | **ABSORB** (PWA) | Optional: Sonarr-API compatibility lets these apps still work. |

### 1.9 Scope notes

| App | Verdict | Note |
|---|---|---|
| **Lidarr** | IRRELEVANT | Anime OSTs are out of scope (maybe Phase 4: list OP/ED tracks only). |
| **Readarr** | IRRELEVANT | **Retired by Servarr in mid-2025.** Metadata was unusable and the repo was archived; unofficial metadata mirrors (rreading-glasses) only. Light novels/manga are out of scope (Seanime and Kapowarr/Mylar cover manga/comics). |
| **Whisparr** | IRRELEVANT | Hentai is a gap no arr handles well. Possible Phase 4 "adult anime" library via AniDB 18+ flags, kept separate and opt-in. |
| **Prowlarr / Jackett / FlareSolverr / Byparr** | KEEP | AnimeArr talks to Prowlarr only. |
| **Medusa / SickGear** | IRRELEVANT | Medusa's AniDB release-group whitelist/blacklist per show is worth copying. |
| **UmlautAdaptarr** | IRRELEVANT itself; **ABSORB the idea** | German-title fix. The anime equivalent is alias search (romaji, English, JP and synonyms per AniList/AniDB), which is core. |
| **Wizarr / Membarr** | KEEP SEPARATE | Phase 4 family onboarding at most. |
| **Homepage / Homarr widgets** | INTEGRATE | Expose a Sonarr-shaped `/api/v3/queue` and calendar so existing widgets work. |

---

## 2. Proposed built-in modules ("one Anime Arr to rule them all")

Ordered by value to an anime library owner. Phases 0 to 3 follow the roadmap, plus a Phase 4 for family/extras.

| # | Module | Absorbs | Phase |
|---|---|---|---|
| 1 | **Identity & Mapping Core**: merged ID graph, episode/season offsets, alias titles, local overrides | Anime-Lists, Fribb, manami, AniBridge mappings, Kometa Anime-IDs, TheXEM, UmlautAdaptarr idea | **0** (read-only), refined in 1 |
| 2 | **Library Audit / SeaDex Scout**: per-season report of what's on disk vs. SeaDex best, wrong-dub, missing eps, corrupt files | seadex-scout, SeaDexArr (report mode), Checkrr (scan), Taggarr (detect) | **0** |
| 3 | **Decision Engine & Profiles**: SeaDex-first ranking, TRaSH anime CFs synced, group allow/deny per show, dual-audio pref | Recyclarr, Configarr, Profilarr, SeaDexArr (grab), Medusa group lists | **1** |
| 4 | **Queue Doctor**: strikes, stalled/slow/metadata-stuck, failed-import, malware blocker, auto re-search, extraction | Cleanuparr, Decluttarr, Swaparr, Unpackerr | **1** |
| 5 | **Import & Naming**: Plex-modern-agent and Jellyfin-safe naming (no HAMA/ASS dependence), targeted media-server refresh, ffprobe verify | Autoscan/Autopulse, Checkrr (on import) | **1** |
| 6 | **Phone PWA**: queue, calendar, seasonal browse, one-tap add, approve/reject | LunaSea, Ruddarr, Helmarr, nzb360 (arr half), Animetarr | **1** (basic), **2** (polish) |
| 7 | **Backlog Hunter**: rate-limited missing/upgrade/SeaDex-upgrade searches | Huntarr, Newtarr, seekarr | **2** |
| 8 | **Subtitles**: providers, embedded-sub awareness, MoriSubs generation gap-fill, LLM translation | Bazarr, subarr, Lingarr (subgen/whisper-asr as backends) | **2** |
| 9 | **Track Fixer**: mkvpropedit/mkvmerge defaults (JP audio, full subs over signs), strip junk tracks, dub tags | Muxarr, striptracks, FileFlows track plugins, Taggarr/Langarr (tagging) | **2** |
| 10 | **Lists & Watchlists**: AniList/MAL list import, Plex watchlist, seasonal subscribe, "follow group" RSS rules | anilistarr, Pulsarr, Watchlistarr, AutoBangumi behaviours | **2** |
| 11 | **Notifications & Digest**: Apprise transport, rich anime cards, weekly airing digest, iCal, `/metrics`, `/health` | Notifiarr (fixer parts), Calendarr, Exportarr | **2** |
| 12 | **Takeover / Sonarr-compat API**: import from Sonarr/Radarr, then expose `/api/v3` shims so Seerr, ani2arr, Homepage, nzb360 and autobrr push keep working | Buildarr (config export/import) | **3** |
| 13 | **Torrent Hygiene & Seeding**: per-tracker share rules, unregistered handling, orphan/no-hardlink cleanup, cross-seed webhook | qbit_manage (scoped), Prunerr, Cleanuparr seeding cleanup | **3** |
| 14 | **Collections & Requests**: Kometa-style anime collections, Tastearr/Seerr request intake | Kometa, Overseerr/Jellyseerr (via Tastearr) | **3** |
| 15 | **Retention & Watch-driven Monitoring**: leaving-soon, disk-pressure cleanup, next-season prefetch, rolling windows for long shounen | Maintainerr, Janitorr, Deleterr, Prefetcharr, Episeerr | **4** |
| 16 | **Family extras**: per-user profiles and requests, kid-safe library split, chat bot, invite links, optional adult-anime library | Doplarr/Requestrr (one bot), Wizarr (link out) | **4** |

**Stays outside AnimeArr (integrate only):** SABnzbd, qBittorrent, Prowlarr, Plex/Jellyfin, Tdarr, autobrr, cross-seed, Shoko (optional ID oracle), AniBridge (watch sync), Tautulli, Apprise targets, Seerr, Seanime.

---

## 3. Exceptions to the fixer/new-capability rule

1. **qbit_manage: partial absorb.** It fixes torrent-client hygiene, not an *arr flaw, and it also manages torrents AnimeArr never touched. Absorb the rules only for AnimeArr-owned torrents; keep qbit_manage for everything else.
2. **AutoBangumi: absorb behaviours, not the app.** It's a fixer (Sonarr handles fansub RSS badly), but it's a whole competing arr. Take its RSS "follow group" rules and its title parser test corpus.
3. **HAMA / ASS: irrelevant but binding.** They're fixers on the Plex side, and Plex is hiding legacy agents. AnimeArr can't absorb a Plex agent. Instead it must make them unnecessary by naming and laying out files for the modern agents.
4. **Notifiarr: split.** Absorb the fixer bits (alerts, TRaSH sync). Its paid cloud/Discord service is a separate product.
5. **Exportarr/Scraparr: absorb although new-capability.** A Prometheus `/metrics` endpoint is trivial in Fastify.
6. **Muxarr/striptracks: absorb, while Tdarr stays.** Setting default tracks with mkvpropedit is fast and lossless, and every anime library needs it. Re-encoding stays in Tdarr.
7. **nzb360: absorb only the *arr half.** It also controls SAB/qBit directly, which AnimeArr won't replicate.
8. **Seerr: integrate although the user says "absorbed via Tastearr".** Tastearr is the front-end. AnimeArr should still expose a Sonarr-compatible API so Seerr (now the merged project) can target it unchanged.
9. **Watchlistarr/Pulsarr: classed as fixers and absorbed.** They exist because *arr's Plex watchlist import polls slowly. AnimeArr can do it natively with little code.

---

## 4. Surprises and lessons

- **Huntarr collapsed in Feb 2026** after alleged auth bypass and exposed API keys for the whole stack; the repo went dark, and Newtarr forked it. Lesson: a single app holding SAB, qBit, Prowlarr and Plex keys must be secure by default. Auth always on, secrets encrypted at rest, keys never returned by the API, no unauthenticated setup endpoints after first run.
- **Overseerr and Jellyseerr merged into Seerr** (first release 15 Feb 2026); the old apps are sunset. Target Seerr's Sonarr integration for compatibility.
- **Plex is retiring legacy agents**, which HAMA and ASS depend on. Anime naming that works with the modern Plex TVDB agent is now a must, and a selling point.
- **Readarr is retired** (mid-2025), and **LunaSea is dead**, which leaves a gap for a good mobile *arr UI that a PWA can fill.
- **The anime-specific tools are all young and small**: seadex-scout, SeaDexArr, Taggarr, subarr, ani2arr, anilistarr. The space is fragmented, which validates AnimeArr. seadex-scout's "Torznab feed of SeaDex picks" trick means AnimeArr could also serve legacy Sonarr users during the takeover phase.
- **Kometa's Anime-IDs file may be stale** (cached copy generated Aug 2024). Prefer manami, Anime-Lists and AniBridge mappings as primary sources, with Kometa as a fallback.
- **AutoBangumi 3.3 added LLM-based title parsing plugins.** That's a good precedent for an LLM fallback parser in AnimeArr's deep-search mode.

---

## 5. Sources

- awesome-arr list: https://github.com/Ravencentric/awesome-arr
- Cleanuparr: https://github.com/Cleanuparr/Cleanuparr
- Huntarr end / Newtarr: https://store.elfhosted.com/blog/2026/02/24/huntarr-ends-its-hunt-newtarr-takes-it-up/ ; https://forums.truenas.com/t/notice-to-huntarr-users/63950 ; https://learn.g2.com/huntarr-security-vulnerability
- seekarr: https://newreleases.io/project/github/tumeden/seekarr/release/v0.3.4
- Swaparr docs: https://docsearch.algolia.com/mcp/docs/repo/thijmengthn/swaparr
- Seerr merge: https://store.elfhosted.com/blog/2026/02/17/overseerr-and-jellyseerr-merge-into-seerr/ ; https://store.elfhosted.com/blog/2026/04/28/overseerr-jellyseerr-sunset-may-2026/
- Profilarr v2: https://jellywatch.app/blog/profilarr-configuration-management-radarr-sonarr-custom-formats-2026 ; https://apps.truenas.com/catalog/profilarr_community/
- SeaDexArr: https://pypi.org/pypi/seadexarr ; seadex-scout: https://hub.docker.com/r/cplieger/seadex-scout ; sonarr-seadex-proxy: https://hub.docker.com/r/gabehf/sonarr-seadex-proxy
- anilistarr: https://pkg.go.dev/github.com/wwmoraes/anilistarr ; Animetarr: https://github.com/kariudo/animetarr ; ani2arr: https://addons.mozilla.org/de/firefox/addon/ani2arr/
- AniBridge: https://trendshift.io/repositories/25936 ; https://awesome.ecosyste.ms/projects/github.com%2Fanibridge%2Fanibridge-mappings
- PlexAniSync: https://forums.plex.tv/t/plexanisync-sync-your-plex-library-to-anilist/365826.md ; https://ca.unraid.net/apps/plexanisync-0xcu1nd0jb3n2l
- Kometa Anime-IDs: https://github.com/Kometa-Team/Anime-IDs
- Plex legacy agents: https://forums.plex.tv/t/missing-agents-and-scanner-files/936305.md ; HAMA thread: https://forums.plex.tv/t/rel-http-anidb-metadata-agent-hama/40470?page=105
- Shoko / Shokofin: https://github.com/ShokoAnime/Shokofin ; https://jellywatch.app/blog/shokofin-jellyfin-anime-plugin-anidb-complete-guide-2026
- Seanime: https://www.GitHub.com/5rahim/seanime ; https://aur.archlinux.org/packages/seanime-bin ; https://dev.co/devops/open-source/seanime
- AutoBangumi: https://newreleases.io/project/github/EstrellaXD/Auto_Bangumi/release/3.3.0 ; https://newreleases.io/project/github/EstrellaXD/Auto_Bangumi/release/3.3.4-beta.1
- Lingarr: https://github.com/lingarr-translate/lingarr ; https://releasealert.dev/github/lingarr-translate/lingarr
- subgen: https://www.sourcepulse.org/projects/1849398 ; https://hub.docker.com/r/mccloud/subgen/tags ; WhisperSubs: https://jellywatch.app/hub/whispersubs
- Taggarr: https://ca.unraid.net/apps/taggarr-123inu00j2doo4 ; Langarr: https://github.com/qudiqudi/langarr
- Readarr retirement: https://discuss.mschae23.de/post/27071
- LunaSea shutdown: https://reddit.birdcat.cafe/r/LunaSeaApp ; https://communities.stormux.org/post/25049
