# AnimeArr backlog

Ideas that are **not** in the current step, so they aren't lost. The release plan is at the top of [PROPOSAL.md](PROPOSAL.md#release-plan-authoritative-updated-2026-10-25).
Rule: each step is complete, tested and in daily use, then hardened, before the next one starts.

## Must-have before tagging 1.0

- [x] Dual-mode automatic upgrade: replace a sub-only placeholder when a dual-audio release appears (Sonarr-parity upgrade path) — off / log (default) / auto
- [x] Movies round 2: watch monitored movies for release (digital/physical dates), calendar entries, missing-movie search, dual upgrades for movies, series ↔ movie links (S0 double-download guard)

## Decisions to confirm (made conservatively overnight; the user can change them)

- Own metadata: AniList-first catalog refreshed every 6 h (airing shows daily, others weekly), one relation hop out for franchises; TMDB/AniDB/TVDB providers stay off until the user enters a key/client in Settings → Metadata
- Episode titles: Sonarr's title wins; the catalog's (AniList streaming list, TMDB when keyed) only fills missing/TBA titles until cutover
- Importer: stays "through Sonarr/Radarr" with real imports and renames OFF until the first plans are approved; then the switch is Settings → Media management → Importer (each change confirmed)
- Media management starts from Sonarr's/Radarr's own naming + media-management values (copied once at startup, "Copy settings from Sonarr/Radarr" redoes it), so the takeover renames nothing just because defaults differ. AnimeArr's recycling bin stays its own: /media/Recycle/animearr/, 14 days
- Recycling-bin retention purge (deleting files older than 14 days from /media/Recycle/animearr/) is NOT active yet: its first run is a cleanup deletion, so it waits for a dry-run report
- Hardlinks are impossible on the server: Downloads live on the cache pool and Anime on the array (different filesystems under Unraid's /mnt/user), so torrent imports are COPIES. A copy doubles cache usage until the torrent's seeding is done — the download-folder rules' leftover/seeding cleanup must count and remove these imported-and-copied payloads (folder-size metric excludes them while seeding; cleanup removes them after the seeding rules)
- Real imports by AnimeArr's own importer run on a budget (Settings → Media management → Importer): 1 for the first one, then a review pause; beyond it, imports go through Sonarr
- Bulk rename (4,800 files in 378 shows) waits for the user: a taste decision that also touches Plex (rescans) and Tdarr (path-keyed records). Only the Absolute Duo test batch was approved
- Recycling-bin auto-empty stays OFF until the user confirms
- Absolute Duo test rename (12 files, 2026-10-26): on disk ✓, Sonarr picked up the new paths ✓ (but as delete + new file: 12 "episodeFileDeleted" history events, new file IDs, dateAdded reset, sceneName empty; monitoring and quality kept), Plex kept the same items (ratingKeys 103–114) with the new paths ✓, undo + redo on S01E01 ✓. Proposal: while Sonarr still owns a show (parallel mode), a bulk rename should go through Sonarr's own RenameFiles command so its file records and history stay intact; AnimeArr's own renamer after cutover
- Rename route (agreed): the rename UI picks it automatically and says which — Sonarr's RenameFiles while Sonarr still owns the show (no undo; Sonarr keeps its records), AnimeArr's own renamer after cutover or for AnimeArr-native shows (undo in Activity)
- Usenet imports MOVE out of /data/completed/animearr (that one folder is mounted read-write); everything else under /data stays read-only
- UMASK 002 (folders 775, files 664, owner 99:100) like the *arr images; chmod/chown on import stay off unless "Set permissions" is on
- Upgrades: a file that also holds other episodes (multi-episode file) is never replaced automatically; it becomes "import by hand"
- Size presets: Lean is the default for every profile and is a strong penalty, not a rejection (a bigger release still gets grabbed when nothing smaller exists). Lean ceilings per minute: 2160p 170 MB, 1080p 85 MB, 720p 45 MB, 480p 25 MB
- Episode Title Required "always" (Sonarr's value) also uses the catalog's titles before refusing an import
- Renamer checked against Sonarr's own rename preview on the server: 4,779 of 4,781 planned renames identical; the 2 differences are titles starting with a censored word ("- - Is All You Need"), where AnimeArr drops the doubled dash
- Movie import/rename stay with Radarr this round (movie naming settings and previews exist; the movie importer comes with native Add)

## 1.0 = takeover (binding)

AnimeArr fully replaces Sonarr AND Radarr for anime (searching, importing, library, metadata). Afterwards Sonarr and Radarr have no anime libraries. Build order (PROPOSAL "1.0 takeover checklist"):

- [ ] 1. Own file records (scan + ffprobe every file; incremental; nightly; after Tdarr rewrites)
- [~] 2. Own importer (built; real imports/renames wait for the first reviewed plan; movie import/rename still through Radarr) (move/hardlink, naming templates, folders, permissions, sidecars, recycle on upgrade, manual import, dry-run preview) — needs read-write library mounts. Renamer can refresh {Quality}/{MediaInfo} tokens after a re-encode (optional "Rename after Tdarr re-encode", default off)
- [ ] 3. Plex (partial scans, path mapping, .plexmatch)
- [ ] 4. Own metadata (AniDB/AniList-first franchise model; TVDB/TMDB as mappings; donghua/ONAs)
- [ ] 5. Add series/movies UI (AniList/AniDB search)
- [ ] 6. RSS/new-release monitoring via Prowlarr feeds
- [ ] 7. Migration/cutover tool (import, parallel mode, final removal checklist; never deletes without confirmation)
- [ ] 8. Notifications, minimal for 1.0: Discord/ntfy for grabbed, imported, failed and paused-by-limit, plus the in-app bell. (Later: browser/desktop **Web Push** from the PWA as a first-class channel.) Web Push needs a secure context (plain http://192.168.1.13:8484 isn't one): detect it and explain in Settings (reverse proxy with HTTPS, Tailscale HTTPS, externalUrl); fall back to in-app toasts + a notification bell/inbox while the app is open. Per-event toggles: grabbed / imported / failed / needs attention / paused by a limit rule / new episode available
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
- [ ] Unpacking needs the container's /data mount writable (currently read-only on the server)
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

### Themes
- UI design rules (user feedback 2026-10-25) live in PROPOSAL §10 "Design rules"; themes must keep them (no colour-only meaning, readable phone type).
- [ ] Themes engine with presets: "server/compact" dense view, "pretty" poster-heavy view, colour themes, community theme files. Builds on 0.1's design tokens.
- [ ] "Theme it after your favourite anime": pick a show; AnimeArr takes an accent palette from its AniList art (`coverImage.color`), uses its banner as the header/background, and lets users share theme files.

### Database
- [ ] Postgres option

### App family
- [ ] A TV sibling app ("ShowArr") reusing the core — §7 Phase 4
