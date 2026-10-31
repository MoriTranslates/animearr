# Parity matrix (living)

The 1.0 release gate: before tagging 1.0, a separate parity-audit run checks every row below (and anything missing from it) as **cloned**, **dropped (why)** or **missing**. Kept up to date as features land.

Status: ✅ cloned · 🟡 partial · ❌ missing · ➖ intentionally dropped. Last checked for 0.9.0-beta (independent audit, 2026-10-27); reviewed against the released 0.9.0-beta code on 2026-10-30.

## Sonarr / Radarr

| Area | Feature | Source | AnimeArr | Notes |
|---|---|---|---|---|
| Library | Series list, series page, episode list | Sonarr | ✅ | Own catalog (AniList + AniDB + TMDB titles); episodes-first series page with Movies & specials / Details / History tabs |
| Library | Movies list, movie page | Radarr | ✅ | Library = Shows · Movies; AnimeArr owns "wanted" |
| Library | Add series / add movie | Sonarr/Radarr | ✅ | Global Search: library + AniList + release search |
| Library | Delete episode file (recycle bin) | Sonarr | ✅ | |
| Library | Rename files (preview + apply) | Sonarr/Radarr | ✅ | Series ⋯ → Rename files |
| Library | Rescan / analyse media files | Sonarr/Radarr | ✅ | Own ffprobe scanner (step 1), forced flags included |
| Search | Automatic search (episode, season, bulk, movie) | Sonarr/Radarr | ✅ | ⚡ Search; season packs preferred; confidence gate → "needs a look" |
| Search | Interactive search | Sonarr/Radarr | ✅ | "Choose release…" in every Find split button; Release search page |
| Search | RSS sync | Sonarr/Radarr | 🟡 | New releases bring searches forward for managed shows and wanted movies; nothing is grabbed straight from a feed |
| Search | Missing search (Wanted → Missing) | Sonarr/Radarr | 🟡 | Rate-limited, managed shows + wanted movies; off by default (the wizard's last step can switch it on); no dedicated Wanted page (Audit → Gaps) |
| Search | Cutoff unmet / upgrades | Sonarr/Radarr | ✅ | Quality goal per profile (the cutoff) with an automatic upgrade watcher (daily budget, first-run plan, pause, no-churn rule, keep-as-is locks); dual-audio upgrades. Episodes only: movies aren't upgraded for quality yet |
| Activity | Queue with live progress, remove/blocklist | Sonarr/Radarr | ✅ | Own downloads + Sonarr queue problems |
| Activity | History | Sonarr/Radarr | ✅ | Timeline grouped by day; one event per grab with a stage track; why, fixes, undo |
| Activity | Blocklist | Sonarr/Radarr | 🟡 | Blocklist exists; a turned-down release can be un-blocked with Undo in Activity; no management page yet |
| Calendar | Month / week / agenda, movies | Sonarr/Radarr | ✅ | |
| Import | Completed download handling | Sonarr/Radarr | ✅ | AnimeArr's own importer only |
| Import | Manual import UI | Sonarr/Radarr | ✅ | Series ⋯ → Import files; "Import manually…" fix button |
| Settings | Media management (naming, folders, importing, file management, permissions) | Sonarr/Radarr | 🟡 | Naming, importing, permissions, recycling bin with retention. Shown but not used yet: propers, unmonitor deleted, file date, delete empty folders, rescan after refresh, analyse video files |
| Settings | Profiles | Sonarr/Radarr | 🟡 | Language profiles, watch modes, size presets, group consistency, quality goal (Sonarr's quality names in TRaSH-style anime categories), SeaDex + TRaSH group tiers instead of custom formats. Missing: per-quality allow toggles, release profiles (must / must-not contain), propers |
| Settings | Protocol priority + delay profiles | Sonarr | ✅ | Prefer Usenet / Prefer torrents / No preference per profile (top of Indexers and Download clients); Usenet/torrent delays for automatic grabs; reasons say "(preferred)" |
| Settings | Indexers | Sonarr/Radarr | ✅ | Cards in Usenet \| Torrent columns: Prowlarr's indexers (protocol, priority, learned health) and direct ones — custom Newznab/Torznab/RSS (keys encrypted, masked, redacted; categories 5070/5000/2000; priority; seed ratio; tags; Test with a sample search), Jackett trackers in one click, a curated anime catalogue (catalog/indexers.json, each entry checked live 2026-10-26), duplicate warnings. Prowlarr optional |
| Settings | Download clients | Sonarr/Radarr | 🟡 | SABnzbd, qBittorrent, NZBGet, Transmission, Deluge, rTorrent with priority, enabled, category/label, Test, per-client path mappings; grabs go to the best client of their protocol with fallback. "Remove completed" for NZBGet not wired yet |
| Settings | Blackhole download clients (Usenet, Torrent) | Sonarr | ✅ | Watch folder + completed folder, .magnet files optional, timeout (24 h); off by default, not in the wizard, never auto-picked over a real client unless preferred; no progress, no partial downloads (see the README footnote) |
| Grabbing | Partial batch downloads (skip episodes you have) | — | ✅ | Beyond Sonarr: qBittorrent, Transmission, Deluge, rTorrent download only the wanted files of a batch; others download the whole batch and the leftovers are cleaned after import |
| Grabbing | Season consistency for batches | — | ✅ | Per season: only the missing episodes, or replace the whole season (same group/quality rules, old files to the bin only after the new ones pass) |
| Settings | Media servers | Sonarr/Radarr | ✅ | Plex, Jellyfin, Emby, Kodi: Test, path mappings, a scan of the changed folder after imports, upgrades, renames and deletes |
| Settings | Migration (Sonarr/Radarr) | — | ✅ | Settings → Migration: connections + cutover, "only needed until cutover" |
| Settings | Connect / notifications | Sonarr/Radarr | 🟡 | Discord, ntfy, in-app bell (Needs action / Recent); every problem carries fix buttons. No generic webhook, email, Telegram, Pushover |
| Settings | Metadata (Plex/Kodi files) | Sonarr/Radarr | 🟡 | Series: tvshow.nfo, season.nfo, episode NFOs, .plexmatch, poster/banner, from AnimeArr's catalog; user files never overwritten. No movie NFOs, no episode thumbnails yet |
| Settings | Tags | Sonarr/Radarr | ❌ | |
| System | Status, tasks, backups, logs | Sonarr/Radarr | 🟡 | Jobs, nightly backups/restore, update check against GitHub releases (Settings → System); no log viewer, no backup download/upload (copy /config incl. secret.key) |
| Setup | First-run setup wizard | — | 🟡 | **Built (first version):** Welcome: "I'm new" vs "I already use Sonarr/Radarr" (+ language, skip). New: account → folders (browser, writable check, Docker path note) → download clients (Test, create the category) → indexers (Prowlarr, catalogue starter picks, custom) → preferences (protocol priority, language profile, size preset) → Plex → metadata keys → notifications → done (add first show / import existing folders). Migration path: connect Sonarr/Radarr → preview what's found (anime series/movies, roots, naming, clients, indexers, Plex, tags, profiles) with per-item import → review screens → handover (unmonitor, import lists off, with backups and undo) → guided takeover checklist (adopt, verify first imports, resolver, switch with confirmation, remove connections). Saved and resumable; re-run from Settings → System; Test or preview on every step |
| API | REST API for other apps | Sonarr/Radarr | 🟡 | Sonarr v3-compatible subset for request apps (Jellyseerr/Overseerr): system status, quality profiles (AnimeArr profiles, stable ids), root folders, tags, series list/lookup/add/edit/delete (delete never removes files), episodes + monitor (per season), queue, missing/episode search commands. Not yet: Radarr-side API for movies, history, calendar, wanted, episode files, manual import, so Bazarr/LunaSea/nzb360/Homepage may only partly work |
| Library | Import an existing folder without Sonarr | Sonarr/Radarr | 🟡 | **Built (first version):** pick an allowed root (wizard "new" path, Settings → System), review each top-level folder's best match (folder-name `{tvdb-N}`/`[tvdbid-N]`/`{anidb-N}`/`[anidbid-N]`/`{tmdb-N}` IDs, else title + year via the alias index and AniList), accept, pick another, search by hand or skip, or add all confident matches. Adds natively with the existing folder as the path; files are recorded and mapped to episodes, unmappable ones listed; never moves, renames or deletes. Series only (no movies), and only the show folders directly inside a root (nothing deeper) |
| Calendar | iCal feed | Sonarr/Radarr | ❌ | |
| Lists | Import lists (AniList/MAL/Plex watchlist) | Sonarr/Radarr | ❌ | |
| Media servers | Jellyfin, Emby, Kodi; NFO / .plexmatch | Sonarr/Radarr | 🟡 | Connections and files done; "Watch in" deep links are still Plex only |
| Auth | First-run account | Sonarr | ✅ | Default login captain / morebooty, works only on your home network until you change it (wizard prompt + banner); existing accounts untouched |

## Anime-specific

| Feature | AnimeArr | Notes |
|---|---|---|
| Alias index, anime parser, numbering resolver (no XEM) | ✅ | |
| Language verification (ffprobe), learned group languages | ✅ | |
| Watch modes (sub/dub/dual/either), per-show profiles | ✅ | |
| Burned-in facts, forced/signs detection | ✅ | |
| After-import check with auto repair | ✅ | Log-only by default |
| Series ↔ movie franchise links, S0 movie guard | ✅ | |
| AniDB/AniList franchise model | ✅ | Own catalog; AniDB provider with strict rate limits |
| Creditless OP/ED (NCOP/NCED) as real extras | ✅ | Own group on the series page, monitored by default |
| Replace season with a better season pack | ✅ | Season packs first, one verified episode at a time, old files to the bin |
| ▶ Trailer on Find & add and the show page | ✅ | Beyond Sonarr: official trailer from YouTube/Dailymotion, nothing downloaded |
| Re-audit files imported before AnimeArr | ❌ | Wrong-file checks run on new imports only; a library audit is planned for 0.9.1 |
| SeaDex input | ✅ | SeaDex's best/alt picks are part of ranking (cached per AniList entry, weekly); dual-audio picks first in Dual/Either modes |

## Absorbed tools

| Tool | Feature | AnimeArr | Notes |
|---|---|---|---|
| Cleanuparr | Queue cleaner (stalled, failed, metadata) | ✅ | Queue health |
| Cleanuparr | Strikes before removal | ❌ | Single timeout today |
| Cleanuparr | Malware blocker (e.g. .exe/.lnk in downloads) | ❌ | |
| Cleanuparr | Download cleaner / seeding rules | 🟡 | After a confirmed import, hourly sweep, failed downloads after an hour; qBittorrent + SABnzbd (not NZBGet/Transmission yet) |
| Unpackerr | Unpack archives | 🟡 | 7z/ZIP; RAR needs a user decision; off by default |
| Huntarr | Missing hunting | 🟡 | Missing-episode/movie search, managed shows only, per-hour cap, off by default |
| Huntarr | Upgrade hunting | ✅ | Quality upgrades towards each profile's goal, plus dual-audio upgrades; budgeted |
| Prowlarr | Indexer health | ✅ | Learned per indexer from failed download links |
