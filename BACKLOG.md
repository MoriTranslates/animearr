# AnimeArr backlog

Ideas that are **not** in the current step, so they aren't lost. 
Rule: each step is complete, tested and in daily use, then hardened, before the next one starts.

## Next, after the 0.9.0-beta launch (2026-10-30)

- [ ] **"For you" tab in Find & add**: Tastearr's taste-based season picks built in, with Add and ▶ Trailer on each pick. Target: in time for the Winter 2027 season (early January). Tastearr also stays a standalone app for Sonarr/Radarr users
- [x] **Quality goal + upgrade watcher** ("always aim for the best"): a goal per profile (Good enough / Aim high / Collector) on Sonarr's quality names in TRaSH-style anime categories, SeaDex + group tiers in ranking; seasons below their goal are rechecked on a budget (weekly in the Blu-ray window) and upgraded through the Replace-season machinery, automatically from day one with guard rails; "keep as is" locks and the {Keep Tag} for Tdarr. Follow-ups: quality upgrades for movies, per-quality allow toggles
- [ ] **Library audit** (0.9.1): re-check files imported before AnimeArr took over (runtime far off, a different year or show in the release name, live action, wrong audio language) and list them with "Find the right release" / "Ignore"; never auto-delete

## Must-have before tagging 1.0

- [x] **Creditless OP/ED (NCOP/NCED) are first-class, never junk** (done 2026-10-26; follow-ups: song title/artist from AniDB song data, detecting creditless files already sitting in Plex extras folders that AnimeArr didn't import) (user request, 2026-10-26): their own special type; an "Openings & endings" group on the series page (OP1, OP2, ED1… with song title and artist from AniDB when known), never under "minor extras"; a "Creditless OP/ED" monitoring toggle (default ON for new shows); searches understand NCOP/NCED/creditless naming and BD batch "Extras/NCOP" folders; import into S00 or as Plex extras (Featurettes/Other folder or -other suffix) by a setting; files already in the library count as Have. Seed of the music layer
- [x] **Indexers & download clients, Sonarr parity** (done for 0.9.0-beta; open: NZBGet remove-completed; see PARITY.md): multiple clients (SABnzbd, NZBGet, qBittorrent, Transmission; Deluge/rTorrent later) with category, priority, enabled, remove-completed, Test, remote path mapping; direct Newznab/Torznab (custom forms; keys encrypted and redacted); Jackett as a manager; curated versioned anime indexer catalogue (each entry verified live, with date); duplicate detection; protocol priority per profile (Prefer Usenet / Prefer Torrent / No preference) with per-protocol delays, shown on both tabs and in grab reasons
- [x] **First-run setup wizard** (first version shipped in 0.9.0-beta; two paths: "I'm new" / "I already use Sonarr/Radarr"), saved and resumable, re-runnable from Settings → System (spec in PARITY.md)

- [x] Dual-mode automatic upgrade: replace a sub-only placeholder when a dual-audio release appears (Sonarr-parity upgrade path) — off / log (default) / auto
- [x] Movies round 2: watch monitored movies for release (digital/physical dates), calendar entries, missing-movie search, dual upgrades for movies, series ↔ movie links (S0 double-download guard)

## 1.0 = takeover (binding)

AnimeArr fully replaces Sonarr AND Radarr for anime (searching, importing, library, metadata). Afterwards Sonarr and Radarr have no anime libraries. Build order:

- [ ] 1. Own file records (scan + ffprobe every file; incremental; nightly; after Tdarr rewrites)
- [~] 2. Own importer (built; movie import/rename still through Radarr) (move/hardlink, naming templates, folders, permissions, sidecars, recycle on upgrade, manual import, dry-run preview) — needs read-write library mounts. Renamer can refresh {Quality}/{MediaInfo} tokens after a re-encode (optional "Rename after Tdarr re-encode", default off)
- [~] 3. Plex (partial scans + path mapping done; .plexmatch not yet)
- [ ] 4. Own metadata (AniDB/AniList-first franchise model; TVDB/TMDB as mappings; donghua/ONAs)
- [~] 5. Add series/movies UI (AniList/AniDB search) — native show Add done (no Sonarr); existing-folder import for series done (wizard + Settings → System, never touches files); movies next
- [x] 6. RSS/new-release monitoring via Prowlarr feeds
- [x] Download-folder rules + clean-up
- [~] 7. Migration/cutover tool (built: plan/adopt/switch/resolver; the switch always asks first) (import, parallel mode, final removal checklist; never deletes without confirmation)
- [x] 8. Notifications, minimal for 1.0: Discord/ntfy for grabbed, imported, failed and paused-by-limit, plus the in-app bell. (Later: browser/desktop **Web Push** from the PWA as a first-class channel.) Web Push needs a secure context (plain http://<server>:8484 isn't one): detect it and explain in Settings (reverse proxy with HTTPS, Tailscale HTTPS, externalUrl); fall back to in-app toasts + a notification bell/inbox while the app is open. Per-event toggles: grabbed / imported / failed / needs attention / paused by a limit rule / new episode available
- [x] **Size limits (Quality Definitions parity, in 1.0; folded into the importer/media-management round):** min/preferred/max MB per minute per quality in the profiles; anime default prefers ≤ ~2 GB per 24-min 1080p episode unless nothing else exists; REMUX/BD packs still allowed when nothing smaller qualifies or the profile says "prefer highest quality"; movies use the same per-minute logic. **Size presets** per profile, overridable per show, each explaining itself in the grab "why": *Lean* (default: prefer ≤ ~2 GB per 24-min 1080p episode); *Balanced* (WEB-DL preferred, no cap below the max); *Best source (I re-encode)* (BD REMUX > high-bitrate BD encode > WEB-DL, no upper cap, penalise mini re-encodes — small x265/AV1 group encodes, "mini", "tiny", very low MB/min — prefer original/lossless audio)
- [ ] **Release gate:** a separate parity-audit run against Sonarr/Radarr, the anime features and the absorbed tools (Cleanuparr, Unpackerr, Huntarr, indexer health), using the living [PARITY.md](PARITY.md) matrix

## 0.x steps to 1.0

### Smarter picking and auto-repair
- [x] Auto-fail and re-search without asking (with caps and two-signal rule) (after-import check, 0.x)
- [x] SeaDex "best release" input (part of ranking; learned scoring on top of it is still open)
- [ ] Burn-in frame check (and which language is burned in) after download
- [ ] "Language coverage beats quality" upgrades
- [ ] LLM fallback parser for names no rule parses

### Downloads
- [x] Missing-episode search for managed shows (rate-limited) · [x] queue health (stalls, metadata, client errors, Sonarr queue report)
- [x] RAR unpacking: decided against. Anime releases rarely use RAR, and a RAR-capable unpacker costs licence and image size; 7z/ZIP unpacking stays and RAR downloads are flagged
- [ ] Unpacking needs the container's /data mount writable (read-only in some setups)
- [ ] Missing-episode search for non-managed shows via Sonarr's search command (opt-in; Sonarr is read-only today)

### Model and data
- [ ] The AniDB franchise model (entries, relations, mainline index)
- [ ] Plex/Jellyfin output layer (naming/layout as a rendering target)
- [ ] Bangumi and cedya77 AOD as extra alias sources; Simplified/Traditional and kana folding
- [ ] "Export as Anime-Lists PR" for inferred mappings

### Watch modes
- [x] Sub / Dub / Dual / Either watch modes with named profiles and per-show overrides (0.1)
- [ ] Dub-status tracking ("waiting for dub", dub announcements)
- [ ] Forced-only subtitle detection for files already in the library (ffprobe scan; Sonarr's mediaInfo has no forced flag)

### Absorbed glue apps
- [ ] Queue Doctor (stalled/slow/failed imports, extraction, extension blocker)
- [ ] Backlog hunter (rate-limited missing/upgrade searches) — module 7
- [ ] Lists and watchlists (AniList/MAL, Plex watchlist, follow-a-group rules) — module 10
- [ ] Collections — module 14
- [ ] Retention and watch-driven monitoring — module 15

### Library audit
- [ ] Unmanaged-folder audit with suggested matches
- [ ] Re-audit existing episode files for wrong matches (see Next: Library audit)
- [ ] Duplicate audit (the same movie in two roots, Sonarr S0 vs Radarr), empty Specials folders, mistyped series and wrong roots

### Notifications
- [ ] Richer push notifications (Apprise) with anime cards
- [ ] Weekly digest — module 11

### Database
- [ ] Weekly deep integrity check (`PRAGMA integrity_check`)
- [ ] Off-site backups (copy to another share or cloud)

### Takeover (= 1.0)
- [ ] Own download/import engine for anime
- [ ] Sonarr-compatible `/api/v3` shims and Torznab feed, so Prowlarr and other tools keep working
- [ ] Full migration from Sonarr/Radarr (AnimeArr owns the library; 0.1 only imports/syncs for companion mode)

## After 1.0 (extras)

- [ ] **"Watch in …" for Jellyfin, Emby and Kodi** (user request 2026-10-27): the provider slot exists (server/watchIn.ts, Plex done); find the item by file path, deep-link to its web client and app
- [ ] **Placeholder episodes** (user idea 2026-10-27, OFF by default): when an aired, monitored episode is stuck (failed downloads / nothing acceptable / needs a look), drop a ~10 s ffmpeg-rendered clip in its slot (AnimeArr style, the sheep-ship, "NANI?! This episode is stuck. Check the server!" + the reason + the next retry), so Plex viewers notice on the TV. Tracked as MISSING (searching continues); a distinctive name/tag so Tdarr and scans skip it; the real import replaces it automatically; un-mark watched in Plex if it was played; never for unaired/unmonitored episodes; all removed when the feature is switched off
- [ ] **Voiced clips** (with the above): a handful of short pre-generated anime-girl voice lines ("Nani?!", "Mou… it's stuck!", "Check the server!", "Gomen ne, still downloading~", "Kita!") made with VOICEVOX (pick a character whose terms allow use in a GPL open-source app; credit "VOICEVOX: <character>" in NOTICE and About). Shipped as small audio assets; used in the placeholder clip and as optional bell/toast sounds (off by default, on in Comic mode, global mute). No TTS at runtime
- [ ] **"Pair this phone" QR** (user request 2026-10-27): a one-time login token in the QR so the phone is signed in without typing a password (short-lived, single use, revocable in Settings → Security)
- [ ] **Native Windows install, post-beta** (release plan 2026-10-27): installer with a Windows service + tray icon, Windows paths everywhere (path mappings, importer), NTFS hardlinks; until then "Windows: Docker Desktop"

- [ ] **Tdarr integration** (after 1.0): optional connection (URL + library ↔ root mapping); "Send to Tdarr" for episode/season/show/movie/selection; per-file Tdarr status from Tdarr's FileJSONDB (TranscodeDecisionMaker / health check: Queued / Processing / Transcode success / Not required / Error) with size before → after; a **"Within Tdarr spec"** indicator per file and per show, evaluating the library's flow conditions (codec, bitrate, audio languages) against our own ffprobe records ("✓ Meets Tdarr spec" / "Will be processed (h264, 12 Mbps)" / "Tdarr: error"; show summary "92% in spec · 14 pending · est. −38 GB"); a "biggest shows" view; later per-show size presets via a shipped Tdarr flow that asks AnimeArr, with AnimeArr sending files after import instead of folder watching; a **"Processing problems"** audit list: files Tdarr failed to transcode/health-check, grouped by show with Tdarr's error reason (job report/log), actions retry in Tdarr / ⚡ re-grab a better source / ignore-accept
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
- [ ] "Machine Sub → [language]" button
- [ ] Full subtitle engine with modes: transcribe-only, human-in-the-loop, local, cloud
- [ ] Right-to-left scripts and per-script fonts

### Discover
- [ ] Tastearr merged as Discover: For You (moved up, see Next), charts, share target, bookmarklet, franchise-aware add

### Other sources
- [ ] Muse Asia and other official free-stream links

### Manga layer (toggleable module, 2.x)
- [ ] Franchise pages show the source manga/light novel from AniList relations (ADAPTATION/SOURCE) with volume/chapter counts and status; "where the anime ends" (chapter/volume, community data or a user note); integrations instead of a reader/downloader: Komga/Kavita (library status, "read in Komga" links), Suwayomi/Kaizoku/Mylar-style downloaders, AniList reading-progress sync

### Music / OST layer (toggleable module, 2.x)
- [ ] Franchise pages list OPs/EDs (AniDB song/credit data per anime and episode), insert songs and soundtrack albums (VGMdb as the canonical source, MusicBrainz links); have/missing from the user's music library via Plex Music, Navidrome/Jellyfin or a Lidarr connection, "Listen" links; an "Opening of the week" card on Home for airing shows; integrate with Lidarr rather than building a downloader. Seeded by the creditless OP/ED work

### Themes
- [ ] **Merry theme** (fun, optional): an original sheep-figurehead caravel SVG (our own drawing, flat, 2–3 token colours; no copyrighted artwork, names or pirate-flag imagery) on the 404 page ("Lost at sea…"), a small sail-by on the OMEDETOU toast (reduced-motion respected), a caramel-wood / sea-blue / sail-white palette in Appearance, Activity titled "Ship's log" in that theme only
- Themes must keep the UI design rules: no colour-only meaning, readable phone type.
- [ ] Themes engine with presets: "server/compact" dense view, "pretty" poster-heavy view, colour themes, community theme files. Builds on 0.1's design tokens.
- [ ] "Theme it after your favourite anime": pick a show; AnimeArr takes an accent palette from its AniList art (`coverImage.color`), uses its banner as the header/background, and lets users share theme files.

### Database
- [ ] Postgres option

### App family
- [ ] A TV sibling app ("ShowArr") reusing the core
