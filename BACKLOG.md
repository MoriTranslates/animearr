# AnimeArr backlog

Ideas that are **not** in the current step, so they aren't lost. The release plan is at the top of [PROPOSAL.md](PROPOSAL.md#release-plan-authoritative-updated-2026-10-25).
Rule: each step is complete, tested and in daily use, then hardened, before the next one starts.

## Must-have before tagging 1.0

- [x] Dual-mode automatic upgrade: replace a sub-only placeholder when a dual-audio release appears (Sonarr-parity upgrade path) — off / log (default) / auto
- [x] Movies round 2: watch monitored movies for release (digital/physical dates), calendar entries, missing-movie search, dual upgrades for movies, series ↔ movie links (S0 double-download guard)

## 1.0 = takeover (binding)

AnimeArr fully replaces Sonarr AND Radarr for anime (searching, importing, library, metadata). Afterwards Sonarr and Radarr have no anime libraries. Build order (PROPOSAL "1.0 takeover checklist"):

- [ ] 1. Own file records (scan + ffprobe every file; incremental; nightly; after Tdarr rewrites)
- [ ] 2. Own importer (move/hardlink, naming templates, folders, permissions, sidecars, recycle on upgrade, manual import, dry-run preview) — needs read-write library mounts
- [ ] 3. Plex (partial scans, path mapping, .plexmatch)
- [ ] 4. Own metadata (AniDB/AniList-first franchise model; TVDB/TMDB as mappings; donghua/ONAs)
- [ ] 5. Add series/movies UI (AniList/AniDB search)
- [ ] 6. RSS/new-release monitoring via Prowlarr feeds
- [ ] 7. Migration/cutover tool (import, parallel mode, final removal checklist; never deletes without confirmation)
- [ ] 8. Notifications (Discord, ntfy/Gotify)
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

- [ ] Plex collections created automatically (show + its movies)
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
