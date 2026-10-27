# AnimeArr backlog

Ideas that are **not** in the current step, so they aren't lost. 
Rule: each step is complete, tested and in daily use, then hardened, before the next one starts.

## Must-have before tagging 1.0

- [x] **Creditless OP/ED (NCOP/NCED) are first-class, never junk** (done 2026-10-26; follow-ups: song title/artist from AniDB song data, detecting creditless files already sitting in Plex extras folders that AnimeArr didn't import) (user request, 2026-10-26): their own special type; an "Openings & endings" group on the series page (OP1, OP2, ED1… with song title and artist from AniDB when known), never under "minor extras"; a "Creditless OP/ED" monitoring toggle (default ON for new shows); searches understand NCOP/NCED/creditless naming and BD batch "Extras/NCOP" folders; import into S00 or as Plex extras (Featurettes/Other folder or -other suffix) by a setting; files already in the library count as Have. Seed of the music layer
- [ ] **Indexers & download clients, Sonarr parity** (see PARITY.md): multiple clients (SABnzbd, NZBGet, qBittorrent, Transmission; Deluge/rTorrent later) with category, priority, enabled, remove-completed, Test, remote path mapping; direct Newznab/Torznab (custom forms; keys encrypted and redacted); Jackett as a manager; curated versioned anime indexer catalogue (each entry verified live, with date); duplicate detection; protocol priority per profile (Prefer Usenet / Prefer Torrent / No preference) with per-protocol delays, shown on both tabs and in grab reasons
- [ ] **First-run setup wizard** (two paths: "I'm new" / "I already use Sonarr/Radarr"), saved and resumable, re-runnable from Settings → System (spec in PARITY.md)

- [x] Dual-mode automatic upgrade: replace a sub-only placeholder when a dual-audio release appears (Sonarr-parity upgrade path) — off / log (default) / auto
- [x] Movies round 2: watch monitored movies for release (digital/physical dates), calendar entries, missing-movie search, dual upgrades for movies, series ↔ movie links (S0 double-download guard)

## Decisions to confirm (made conservatively overnight; the user can change them)

- Own metadata: AniList-first catalog refreshed every 6 h (airing shows daily, others weekly), one relation hop out for franchises; TMDB/AniDB/TVDB providers stay off until the user enters a key/client in Settings → Metadata
- Episode titles: Sonarr's title wins; the catalog's (AniList streaming list, TMDB when keyed) only fills missing/TBA titles until cutover
- Importer: stays "through Sonarr/Radarr" with real imports and renames OFF until the first plans are approved; then the switch is Settings → Media management → Importer (each change confirmed)
- Media management starts from Sonarr's/Radarr's own naming + media-management values (copied once at startup, "Copy settings from Sonarr/Radarr" redoes it), so the takeover renames nothing just because defaults differ. AnimeArr's recycling bin stays its own: /media/Recycle/animearr/ (confirmed: 3 days)
- [x] Recycling-bin retention purge: confirmed and done (2026-10-27): daily, by the time each file went into the bin, only inside the bin; "Empty bin now" in Audit → Maintenance → Recycle
- Hardlinks are impossible when downloads and the library are on different filesystems (e.g. an Unraid cache pool vs. the array), so torrent imports are COPIES there. A copy doubles cache usage until the torrent's seeding is done — the download-folder rules' leftover/seeding cleanup must count and remove these imported-and-copied payloads (folder-size metric excludes them while seeding; cleanup removes them after the seeding rules)
- Real imports by AnimeArr's own importer run on a budget (Settings → Media management → Importer): 1 for the first one, then a review pause; beyond it, imports go through Sonarr
- Bulk rename of an existing library waits for the user: a taste decision that also touches Plex (rescans) and Tdarr (path-keyed records). Only the Absolute Duo test batch was approved
- [x] Recycling-bin auto-empty: confirmed ON by the user (2026-10-27), 3 days
- Native Add (shows): a show whose AniList entry maps to a TVDB series becomes that TVDB series (TVDB numbering, all entries mapped to it); anything TVDB doesn't have is added on its own as season 1 under a synthetic id. Specials (TVDB season 0) and "a" (absolute) mappings aren't split into TVDB seasons yet. If Sonarr later has the same series, Sonarr's copy is used and the native one is parked
- Native Add: ⚡ "search now" searches up to 26 aired, missing episodes; a longer backlog goes to the fill-in queue instead
- Native shows: deleting files from the Show page waits for AnimeArr's own clean-up; renames go through AnimeArr's renamer; removing a show from AnimeArr never touches its files
- Native Add (movies): done. A movie added in AnimeArr gets its folder from the movie folder format; it's searched like Radarr's (movie search pass), imported by AnimeArr's own movie importer
- Movie imports by AnimeArr's own importer have their own switch (importer.movies, OFF): the first real movie import waits for a reviewed plan; Radarr imports Radarr's movies meanwhile, and a native movie's finished download waits in "needs attention"
- With the own importer, a Radarr movie's import waits until Radarr shows the new file (up to 2 minutes), else "needs attention"; AnimeArr doesn't apply Radarr's own upgrade rules — replacing a file still needs the user's confirmed "replace"
- A native movie counts as available when AniList marks it finished (no separate digital-release date yet)
- AniList: searches (Add box) and Add's own fetches go before the catalog refresh; a newer search drops an older one still waiting
- Download-folder rules: "new-only vs all grabs" is implemented as "all grabs" or "backlog grabs only" (new episodes — aired in the last 14 days — and movies released in the last 30 days still come). Please confirm that reading
- Download-folder rules: a grab started by hand passes the folder rules (not the free-space rule); a paused automatic search waits without using up attempts
- Free-space rule default 50 GB, measured on the tightest of AnimeArr's download disks; if it can't be measured, it doesn't pause
- Torrent seeding counts as done when qBittorrent paused/stopped it, or ratio ≥ 1 after 7 days, or after 30 days
- Clean-up: torrents are only ever removed through qBittorrent (their category only); Usenet folders only when no video is left; folders nobody knows are moved to .animearr-quarantine (never deleted), and not while any grab is still pending; if a client can't be read, its folder is left alone. Deleting stays OFF (downloads.allowDelete) until the first clean-up plan is approved
- qBittorrent's "animearr" category already saves to /data/qbittorrent/completed/animearr; that folder isn't mounted read-write (only removal through qBittorrent is needed there)
- Notifications: grabbed/imported/failed/paused to Discord and/or ntfy (one at a time; grabbed/imported capped at 30 a minute, failed/paused always), the bell in the header; an import notifies once per grab
- Cutover: everything ready was adopted (567 shows, 86 movies; AnimeArr-side only). Removal from Sonarr/Radarr waits for: a reviewed real episode import and movie import through AnimeArr's importer, Plex set up in AnimeArr, and the user's look at Sonarr's AniList list and Radarr's TMDb lists — then the user's explicit OK
- Cutover: 42 movies matched with AniList by title and year (auto, unambiguous only) are ready but NOT adopted — for the user to glance at first
- Cutover: specials (season 0) aren't tracked by native shows yet; a show with special files needs an explicit "leave them untracked"
- Absolute Duo test rename (12 files, 2026-10-26): on disk ✓, Sonarr picked up the new paths ✓ (but as delete + new file: 12 "episodeFileDeleted" history events, new file IDs, dateAdded reset, sceneName empty; monitoring and quality kept), Plex kept the same items (ratingKeys 103–114) with the new paths ✓, undo + redo on S01E01 ✓. Proposal: while Sonarr still owns a show (parallel mode), a bulk rename should go through Sonarr's own RenameFiles command so its file records and history stay intact; AnimeArr's own renamer after cutover
- Rename route (agreed): the rename UI picks it automatically and says which — Sonarr's RenameFiles while Sonarr still owns the show (no undo; Sonarr keeps its records), AnimeArr's own renamer after cutover or for AnimeArr-native shows (undo in Activity)
- Usenet imports MOVE out of /data/completed/animearr (that one folder is mounted read-write); everything else under /data stays read-only
- UMASK 002 (folders 775, files 664, owner 99:100) like the *arr images; chmod/chown on import stay off unless "Set permissions" is on
- Upgrades: a file that also holds other episodes (multi-episode file) is never replaced automatically; it becomes "import by hand"
- Size presets: Lean is the default for every profile and is a strong penalty, not a rejection (a bigger release still gets grabbed when nothing smaller exists). Lean ceilings per minute: 2160p 170 MB, 1080p 85 MB, 720p 45 MB, 480p 25 MB
- Episode Title Required "always" (Sonarr's value) also uses the catalog's titles before refusing an import
- Renamer checked against Sonarr's own rename preview on a real library: all but 2 planned renames identical; the 2 differences are titles starting with a censored word ("- - Is All You Need"), where AnimeArr drops the doubled dash
- Movie import/rename stay with Radarr this round (movie naming settings and previews exist; the movie importer comes with native Add)

## 1.0 = takeover (binding)

AnimeArr fully replaces Sonarr AND Radarr for anime (searching, importing, library, metadata). Afterwards Sonarr and Radarr have no anime libraries. Build order (PROPOSAL "1.0 takeover checklist"):

- [ ] 1. Own file records (scan + ffprobe every file; incremental; nightly; after Tdarr rewrites)
- [~] 2. Own importer (built; real imports/renames wait for the first reviewed plan; movie import/rename still through Radarr) (move/hardlink, naming templates, folders, permissions, sidecars, recycle on upgrade, manual import, dry-run preview) — needs read-write library mounts. Renamer can refresh {Quality}/{MediaInfo} tokens after a re-encode (optional "Rename after Tdarr re-encode", default off)
- [~] 3. Plex (partial scans + path mapping done; .plexmatch not yet)
- [ ] 4. Own metadata (AniDB/AniList-first franchise model; TVDB/TMDB as mappings; donghua/ONAs)
- [~] 5. Add series/movies UI (AniList/AniDB search) — native show Add done (no Sonarr); movies next
- [x] 6. RSS/new-release monitoring via Prowlarr feeds
- [x] Download-folder rules + clean-up (first real deletion waits for review)
- [~] 7. Migration/cutover tool (built: plan/adopt/switch/resolver; switch waits for the user) (import, parallel mode, final removal checklist; never deletes without confirmation)
- [x] 8. Notifications, minimal for 1.0: Discord/ntfy for grabbed, imported, failed and paused-by-limit, plus the in-app bell. (Later: browser/desktop **Web Push** from the PWA as a first-class channel.) Web Push needs a secure context (plain http://192.168.1.13:8484 isn't one): detect it and explain in Settings (reverse proxy with HTTPS, Tailscale HTTPS, externalUrl); fall back to in-app toasts + a notification bell/inbox while the app is open. Per-event toggles: grabbed / imported / failed / needs attention / paused by a limit rule / new episode available
- [x] **Size limits (Quality Definitions parity, in 1.0; folded into the importer/media-management round):** min/preferred/max MB per minute per quality in the profiles; anime default prefers ≤ ~2 GB per 24-min 1080p episode unless nothing else exists; REMUX/BD packs still allowed when nothing smaller qualifies or the profile says "prefer highest quality"; movies use the same per-minute logic. **Size presets** per profile, overridable per show, each explaining itself in the grab "why": *Lean* (default: prefer ≤ ~2 GB per 24-min 1080p episode); *Balanced* (WEB-DL preferred, no cap below the max); *Best source (I re-encode)* (BD REMUX > high-bitrate BD encode > WEB-DL, no upper cap, penalise mini re-encodes — small x265/AV1 group encodes, "mini", "tiny", very low MB/min — prefer original/lossless audio)
- [ ] **Release gate:** a separate parity-audit run against Sonarr/Radarr, the proposal's anime features and the absorbed tools (Cleanuparr, Unpackerr, Huntarr, indexer health), using the living [PARITY.md](PARITY.md) matrix

## 0.x steps to 1.0

### Smarter picking and auto-repair
- [x] Auto-fail and re-search without asking (with caps and two-signal rule) — PROPOSAL §7 Phase 1 (after-import check, 0.x)
- [ ] SeaDex "best release" input and SeaDex-first learned scoring — §7.0 module 3
- [ ] Burn-in frame check (and which language is burned in) after download — §7.1
- [ ] "Language coverage beats quality" upgrades — §7 Phase 1
- [ ] LLM fallback parser for names no rule parses — §6.3

### Downloads
- [x] Missing-episode search for managed shows (rate-limited) · [x] queue health (stalls, metadata, client errors, Sonarr queue report)
- [ ] RAR unpacking: Alpine's 7-Zip has no RAR codec. Options: a RAR-capable unpacker in the image (unrar freeware binary, or a Debian base with 7zip-rar), or libarchive's bsdtar (RAR4/partial RAR5). Needs a user decision (licence/image size)
- [ ] Unpacking needs the container's /data mount writable (read-only in some setups)
- [ ] Missing-episode search for non-managed shows via Sonarr's search command (opt-in; Sonarr is read-only today)

### Model and data
- [ ] The AniDB franchise model (entries, relations, mainline index) — §5.3, §6
- [ ] Plex/Jellyfin output layer (naming/layout as a rendering target) — §5.6
- [ ] Bangumi and cedya77 AOD as extra alias sources; Simplified/Traditional and kana folding — §6.1–6.2
- [ ] "Export as Anime-Lists PR" for inferred mappings — §6.6

### Watch modes
- [x] Sub / Dub / Dual / Either watch modes with named profiles and per-show overrides — §5.4 (0.1)
- [ ] Dub-status tracking ("waiting for dub", dub announcements) — §5.4
- [ ] Forced-only subtitle detection for files already in the library (ffprobe scan; Sonarr's mediaInfo has no forced flag)

### Absorbed glue apps
- [ ] Queue Doctor (stalled/slow/failed imports, extraction, extension blocker) — §7.0 module 4
- [ ] Backlog hunter (rate-limited missing/upgrade searches) — module 7
- [ ] Lists and watchlists (AniList/MAL, Plex watchlist, follow-a-group rules) — module 10
- [ ] Collections — module 14
- [ ] Retention and watch-driven monitoring — module 15

### Library audit
- [ ] Unmanaged-folder audit with suggested matches (the 176 folders) — §7 Phase 0
- [ ] Duplicate audit (`Movies/` vs `Movies/Anime`, Sonarr S0 vs Radarr), empty Specials folders, mistyped series and wrong roots — §7 Phase 0

### Notifications
- [ ] Push notifications (Apprise/ntfy) with rich anime cards — §10
- [ ] Weekly digest — module 11

### Database
- [ ] Weekly deep integrity check (`PRAGMA integrity_check`)
- [ ] Off-site backups (copy to another share or cloud)

### Takeover (= 1.0)
- [ ] Own download/import engine for anime — §5.2, §7 Phase 3
- [ ] Sonarr-compatible `/api/v3` shims and Torznab feed, so Prowlarr and other tools keep working — §5.7
- [ ] Full migration from Sonarr/Radarr (AnimeArr owns the library; 0.1 only imports/syncs for companion mode)

## After 1.0 (extras)

- [ ] **"Watch in …" for Jellyfin, Emby and Kodi** (user request 2026-10-27): the provider slot exists (server/watchIn.ts, Plex done); find the item by file path, deep-link to its web client and app
- [ ] **Placeholder episodes** (user idea 2026-10-27, OFF by default): when an aired, monitored episode is stuck (failed downloads / nothing acceptable / needs a look), drop a ~10 s ffmpeg-rendered clip in its slot (AnimeArr style, the sheep-ship, "NANI?! This episode is stuck. Check the server!" + the reason + the next retry), so Plex viewers notice on the TV. Tracked as MISSING (searching continues); a distinctive name/tag so Tdarr and scans skip it; the real import replaces it automatically; un-mark watched in Plex if it was played; never for unaired/unmonitored episodes; all removed when the feature is switched off
- [ ] **Voiced clips** (with the above): a handful of short pre-generated anime-girl voice lines ("Nani?!", "Mou… it's stuck!", "Check the server!", "Gomen ne, still downloading~", "Kita!") made with VOICEVOX (pick a character whose terms allow use in a GPL open-source app; credit "VOICEVOX: <character>" in NOTICE and About). Shipped as small audio assets; used in the placeholder clip and as optional bell/toast sounds (off by default, on in Comic mode, global mute). No TTS at runtime
- [ ] **"Pair this phone" QR** (user request 2026-10-27): a one-time login token in the QR so the phone is signed in without typing a password (short-lived, single use, revocable in Settings → Security)
- [ ] **Native Windows install, post-beta** (release plan 2026-10-27): installer with a Windows service + tray icon, Windows paths everywhere (path mappings, importer), NTFS hardlinks; until then "Windows: Docker Desktop"

- [ ] **Tdarr integration** (after 1.0): optional connection (URL + library ↔ root mapping); "Send to Tdarr" for episode/season/show/movie/selection; per-file Tdarr status from Tdarr's FileJSONDB (TranscodeDecisionMaker / health check: Queued / Processing / Transcode success / Not required / Error) with size before → after; a **"Within Tdarr spec"** indicator per file and per show, evaluating the library's flow conditions (e.g. hevc, bitrate < 8000 kbps, audio ⊆ eng/jpn/und) against our own ffprobe records ("✓ Meets Tdarr spec" / "Will be processed (h264, 12 Mbps)" / "Tdarr: error"; show summary "92% in spec · 14 pending · est. −38 GB"); a "biggest shows" view; later per-show size presets via a shipped Tdarr flow that asks AnimeArr, with AnimeArr sending files after import instead of folder watching; a **"Processing problems"** audit list: files Tdarr failed to transcode/health-check, grouped by show with Tdarr's error reason (job report/log), actions retry in Tdarr / ⚡ re-grab a better source / ignore-accept (real data: 800 errored of 14,603 — Anime 659, TV 125, Movies 16; top: City Hunter 51, Tenchi Muyo Ryo-Ohki 28, Macross Delta 26, Irregular at Magic High School 26, Higurashi 2020 24, Kill la Kill 23, To Love-Ru 16)
- [ ] **AnimeArr manages Tdarr** (after 1.0, design): AnimeArr stores its own versioned flow definitions (Lean / Balanced / Small 720p / Keep original / custom; import from Tdarr or edit in the UI); provisions them via the Tdarr v2 API (cruddb into FlowsJSONDB, LibrarySettingsJSONDB) as "AnimeArr – <name>" flows plus one library per flow over the same root, folder watching OFF; per-file routing after import or "Send" via scan-files with an explicit file list into the library matching the show's size preset (no callback plugin); status read back from FileJSONDB, so "within spec" is exact. Safety: Tdarr version check with a "send only" fallback; built-in flows use stock plugins only; never modify the user's own flows/libraries; migration opt-in (turn off watching on the user's library); detect the encoder (QSV/NVENC/CPU) from the node or ask once
- [ ] **Notification severity design** (after 1.0):
  - **Severity levels (the user: critical notices, not chatter).** *Critical* (default ON on every channel incl. TV/HA/push): grabs paused by a limit rule; cleanup failed / can't get under the limit; downloads disk low on free space; all indexers failing or Prowlarr unreachable; a download client unreachable; Sonarr/Radarr unreachable (until cutover); an import failing repeatedly; DB integrity check or backup failed; a library root missing/unmounted. *Warning* (in-app + phone/PC push, not TV): an episode gave up after 3 repairs; "needs a look" items piling up past N; a show with no English release after X days. *Info* (in-app bell only): grabbed / imported / upgraded.
  - Critical alerts de-duplicate: one when the state starts, one "resolved" when it clears ("Downloads resumed: folder back under 100 GB"), at most a reminder every N hours while it lasts. Quiet hours for non-critical. The bell inbox keeps history. Per-channel severity threshold.
- [ ] Plex collections created automatically (show + its movies)
- [ ] **Plex playback integration (Plex Pass webhooks):** prefetch the next episode when you start watching; warn when the playing file only has forced English subs (with Re-grab); "you're caught up" / "fill in the rest?"; auto-select the full English track instead of Forced via the Plex API; watched signals into Tastearr/Discover. Plex has no API for third-party on-screen toasts in its clients, so:
  - **TV overlay channels:** Android/Google TV/Shield via TvOverlay or PiPup (HTTP POST); Fire TV via "Notifications for Fire TV"; LG webOS via an SSAP toast (pairing key stored encrypted); Kodi via JSON-RPC GUI.ShowNotification. Samsung Tizen and Apple TV aren't feasible (fall back to the other channels). Playback alerts go to the device the Plex webhook says is playing (Plex player → configured TV channel)
- [ ] **Smart home via Home Assistant** (reaches Google Home, Alexa and Apple Home): a generic outgoing webhook channel (JSON per event) + optional MQTT with HA discovery (sensors: downloading, missing, paused-by-limit, last imported; event triggers for imported/failed); later a HACS integration (services: search episode, pause/resume grabs; calendar entity); optional direct Alexa announcements (Notify Me-style skill) as a low-priority non-HA fallback
- [ ] The full franchise graph (AniDB relations: sequels, prequels, side stories, OVAs across shows)

### Subtitles (needs AnimeArr to own the files; MoriSubs keeps working standalone until then)
- [ ] "Machine Sub → [language]" button — §8.3
- [ ] Full subtitle engine with modes: transcribe-only, human-in-the-loop, local, cloud — §8.1–8.2
- [ ] Right-to-left scripts and per-script fonts — §8.6

### Discover
- [ ] Tastearr merged as Discover: For You, charts, share target, bookmarklet, franchise-aware add — §5.5

### Other sources
- [ ] Muse Asia and other official free-stream links

### Manga layer (toggleable module, 2.x)
- [ ] Franchise pages show the source manga/light novel from AniList relations (ADAPTATION/SOURCE) with volume/chapter counts and status; "where the anime ends" (chapter/volume, community data or a user note); integrations instead of a reader/downloader: Komga/Kavita (library status, "read in Komga" links), Suwayomi/Kaizoku/Mylar-style downloaders, AniList reading-progress sync

### Music / OST layer (toggleable module, 2.x)
- [ ] Franchise pages list OPs/EDs (AniDB song/credit data per anime and episode), insert songs and soundtrack albums (VGMdb as the canonical source, MusicBrainz links); have/missing from the user's music library via Plex Music, Navidrome/Jellyfin or a Lidarr connection, "Listen" links; an "Opening of the week" card on Home for airing shows; integrate with Lidarr rather than building a downloader. Seeded by the creditless OP/ED work

### Themes
- [ ] **Merry theme** (fun, optional): an original sheep-figurehead caravel SVG (our own drawing, flat, 2–3 token colours; no One Piece/Toei artwork, names or Jolly Roger) on the 404 page ("Lost at sea…"), a small sail-by on the OMEDETOU toast (reduced-motion respected), a caramel-wood / sea-blue / sail-white palette in Appearance, Activity titled "Ship's log" in that theme only
- UI design rules (user feedback 2026-10-25) live in PROPOSAL §10 "Design rules"; themes must keep them (no colour-only meaning, readable phone type).
- [ ] Themes engine with presets: "server/compact" dense view, "pretty" poster-heavy view, colour themes, community theme files. Builds on 0.1's design tokens.
- [ ] "Theme it after your favourite anime": pick a show; AnimeArr takes an accent palette from its AniList art (`coverImage.color`), uses its banner as the header/background, and lets users share theme files.

### Database
- [ ] Postgres option

### App family
- [ ] A TV sibling app ("ShowArr") reusing the core — §7 Phase 4
