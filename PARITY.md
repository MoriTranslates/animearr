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
| Search | RSS sync | Sonarr/Radarr | ✅ | Every few minutes the newest releases of each indexer (own request per indexer, so a busy one can't crowd out the rest) are checked: a release for a wanted episode or movie brings its targeted search forward, and that search ranks everything (best-of, release rules, safety, protocol delays). It also catches a v2 from the same group and a better category for files you already have, by bringing that season's version check or upgrade recheck forward; the upgrade watcher's budgets, plan wait, pause and locks still apply. Nothing is grabbed straight from the feed: deliberate, so a feed item never skips the ranking |
| Search | Missing search (Wanted → Missing) | Sonarr/Radarr | 🟡 | Rate-limited, managed shows + wanted movies; off by default (the wizard's last step can switch it on); no dedicated Wanted page (Audit → Gaps) |
| Search | Cutoff unmet / upgrades | Sonarr/Radarr | ✅ | Quality goal per profile (the cutoff) with an automatic upgrade watcher (daily budget, first-run plan, pause, no-churn rule, keep-as-is locks); dual-audio upgrades. Episodes only: movies aren't upgraded for quality yet |
| Activity | Queue with live progress, remove/blocklist | Sonarr/Radarr | ✅ | Own downloads + Sonarr queue problems |
| Activity | History | Sonarr/Radarr | ✅ | Timeline grouped by day; one event per grab with a stage track; why, fixes, undo |
| Activity | Blocklist | Sonarr/Radarr | ✅ | Activity → Blocklist: release, show or movie, reason, date, protocol and indexer; remove one or several, filter by show. Undo in Activity still works |
| Calendar | Month / week / agenda, movies | Sonarr/Radarr | ✅ | |
| Import | Completed download handling | Sonarr/Radarr | ✅ | AnimeArr's own importer only |
| Import | Manual import UI | Sonarr/Radarr | ✅ | Series ⋯ → Import files; "Import manually…" fix button |
| Settings | Media management (naming, folders, importing, file management, permissions) | Sonarr/Radarr | 🟡 | Naming, importing, permissions, recycling bin with retention, propers and repacks (v2 / REPACK upgrades from the same group), change file date, delete empty folders. Kept in the settings but hidden because AnimeArr has no use for them yet: unmonitor deleted episodes (files deleted outside AnimeArr are not detected), rescan after refresh (no per-show refresh job), analyse video files (always on: language checks depend on it) |
| Settings | Profiles | Sonarr/Radarr | 🟡 | Language profiles, watch modes, size presets, group consistency, quality goal (Sonarr's quality names in TRaSH-style anime categories), SeaDex + TRaSH group tiers instead of custom formats. Propers and repacks work as in Sonarr, per setting. Missing: per-quality allow toggles. Release rules (must / must-not terms, preferred terms) are in Settings → Release rules |
| Settings | Protocol priority + delay profiles | Sonarr | ✅ | Prefer Usenet / Prefer torrents / No preference per profile (top of Indexers and Download clients); Usenet/torrent delays for automatic grabs; reasons say "(preferred)" |
| Settings | Indexers | Sonarr/Radarr | ✅ | Cards in Usenet \| Torrent columns: Prowlarr's indexers (protocol, priority, learned health) and direct ones — custom Newznab/Torznab/RSS (keys encrypted, masked, redacted; categories 5070/5000/2000; priority; seed ratio; tags; Test with a sample search), Jackett trackers in one click, a curated anime catalogue (catalog/indexers.json, each entry checked live 2026-10-26), duplicate warnings. Prowlarr optional |
| Settings | Download clients | Sonarr/Radarr | 🟡 | SABnzbd, qBittorrent, NZBGet, Transmission, Deluge, rTorrent with priority, enabled, category/label, Test, per-client path mappings; grabs go to the best client of their protocol with fallback. "Remove finished jobs" works for NZBGet: after a confirmed import the finished job leaves NZBGet's history once no video is left in its folder |
| Settings | Blackhole download clients (Usenet, Torrent) | Sonarr | ✅ | Watch folder + completed folder, .magnet files optional, timeout (24 h); off by default, not in the wizard, never auto-picked over a real client unless preferred; no progress, no partial downloads (see the README footnote) |
| Grabbing | Partial batch downloads (skip episodes you have) | — | ✅ | Beyond Sonarr: qBittorrent, Transmission, Deluge, rTorrent download only the wanted files of a batch; others download the whole batch and the leftovers are cleaned after import |
| Grabbing | Season consistency for batches | — | ✅ | Per season: only the missing episodes, or replace the whole season (same group/quality rules, old files to the bin only after the new ones pass) |
| Settings | Media servers | Sonarr/Radarr | ✅ | Plex, Jellyfin, Emby, Kodi: Test, path mappings, a scan of the changed folder after imports, upgrades, renames and deletes |
| Settings | Migration (Sonarr/Radarr) | — | ✅ | Settings → Migration: connections + cutover, "only needed until cutover" |
| Settings | Connect / notifications | Sonarr/Radarr | 🟡 | Discord, ntfy, generic webhook (JSON, custom headers), Telegram, Pushover, email (SMTP), plus the in-app bell (Needs action / Recent); every problem carries fix buttons. Each channel has its own events and a Test button; secrets encrypted, last error shown. No severities yet |
| Settings | Metadata (Plex/Kodi files) | Sonarr/Radarr | 🟡 | Series: tvshow.nfo, season.nfo, episode NFOs, .plexmatch, poster/banner, from AnimeArr's catalog; user files never overwritten. Episode thumbnails (`-thumb.jpg`) and episode plots: TMDB, then Sonarr, optionally a video frame; only AnimeArr's own thumbnails are replaced or removed. No movie NFOs yet |
| Settings | Tags | Sonarr/Radarr | ✅ | Settings → Tags (add, rename, delete with a usage count; delete unlinks). Shows and movies carry tags (show/movie page, bulk from Library → Shows → Select); release rules can be limited to tags; the Sonarr-compatible API's `/tag` and series `tags` are the same tags. Not yet: scoping indexers, download clients and notifications by tag (indexers keep their own free-text tags) |
| Settings | Release rules (release profiles) | Sonarr | ✅ | Must contain / must not contain terms (plain text or `/regex/`, validated on save), preferred terms with a score as a small capped nudge after language, quality, SeaDex and group tiers, optional tags, a "Test against a title" box. One place applies them (ranking), so searches, automatic grabs, upgrades and movies obey them; blocked releases stay visible with the reason |
| System | Status, tasks, backups, logs | Sonarr/Radarr | 🟡 | Jobs, nightly backups/restore, update check against GitHub releases, a log viewer (last 2000 lines, level filter, search, download, secrets redacted) and backup download/upload (database + secret.key, checked and safety-copied before a restore) (Settings → System) |
| Setup | First-run setup wizard | — | 🟡 | **Built (first version):** Welcome: "I'm new" vs "I already use Sonarr/Radarr" (+ language, skip). New: account → folders (browser, writable check, Docker path note) → download clients (Test, create the category) → indexers (Prowlarr, catalogue starter picks, custom) → preferences (protocol priority, language profile, size preset) → Plex → metadata keys → notifications → done (add first show / import existing folders). Migration path: connect Sonarr/Radarr → preview what's found (anime series/movies, roots, naming, clients, indexers, Plex, tags, profiles) with per-item import → review screens → handover (unmonitor, import lists off, with backups and undo) → guided takeover checklist (adopt, verify first imports, resolver, switch with confirmation, remove connections). Saved and resumable; re-run from Settings → System; Test or preview on every step |
| API | REST API for other apps | Sonarr/Radarr | 🟡 | Own API documented in docs/API.md. Sonarr v3-compatible layer for request apps (Jellyseerr/Overseerr; other Sonarr clients may work but are not supported): system status, health, disk space, quality profiles (AnimeArr profiles, stable ids), languages, quality sizes, root folders, tags, series list/lookup/add/edit/delete (delete never removes files), episodes + monitor, calendar, queue (paged, details, status, remove/blocklist), history (grabbed, imported, failed, file deleted), wanted missing and cutoff unmet, episode files (read only; delete is 405), interactive release search + grab, commands (searches, rescan, RSS, backup) with polling. Not yet: Radarr-side API for movies, manual import, renamed-file history, custom formats; Bazarr may only partly work
| Library | Import an existing folder without Sonarr | Sonarr/Radarr | 🟡 | **Built (first version):** pick an allowed root (wizard "new" path, Settings → System), review each top-level folder's best match (folder-name `{tvdb-N}`/`[tvdbid-N]`/`{anidb-N}`/`[anidbid-N]`/`{tmdb-N}` IDs, else title + year via the alias index and AniList), accept, pick another, search by hand or skip, or add all confident matches. Adds natively with the existing folder as the path; files are recorded and mapped to episodes, unmappable ones listed; never moves, renames or deletes. Series only (no movies), and only the show folders directly inside a root (nothing deeper) |
| Calendar | iCal feed | Sonarr/Radarr | ✅ | `/feed/calendar/animearr.ics?apikey=…` with `pastDays` (7), `futureDays` (28), `unmonitored` (false) and `tags`; one event per episode air time (runtime as the length, absolute number when it differs) and all-day events for movie releases. The Calendar page has an "iCal link" button that builds and copies the URL |
| Lists | Import lists (AniList/MAL/Plex watchlist) | Sonarr/Radarr | 🟡 | **Built:** AniList and MyAnimeList (needs a free MAL client ID, stored encrypted) with statuses (Watching, Planning, Completed, Paused, Dropped, Rewatching), profile, folders, monitor, after-add, tags, Test, a sync every N hours plus Sync now, movies through the movie add path, list exclusions, practice mode respected, an Activity entry per add. A list only adds; the first sync is a preview that needs a confirm. **Not built:** Plex watchlist, other list types, and "clean library" (removing what leaves the list) on purpose |
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
| SeaDex input | ✅ | SeaDex's best/alt picks are part of ranking (cached per AniList entry, weekly, or on demand per show); a pick counts only when the release's source fits (a Blu-ray pick doesn't bless the group's WEB/TV release); dual-audio picks first in Dual/Either modes; shown on the show page and episode sheet |

## Absorbed tools

| Tool | Feature | AnimeArr | Notes |
|---|---|---|---|
| Cleanuparr | Queue cleaner (stalled, failed, metadata) | ✅ | Queue health |
| Cleanuparr | Strikes before removal | ✅ | A stalled or metadata-less download gets a strike per health check (at least 10 minutes apart; 3 by default, Settings → Queue health) and is removed only at the limit; moving again clears them. A failure the client reports is final. Strikes show in the queue |
| Cleanuparr | Malware blocker (e.g. .exe/.lnk in downloads) | ✅ | On by default. Executables and scripts (editable extension list), double extensions (episode.mkv.exe), password-protected archives instead of a video, and videos far too small for the runtime: removed from the client, blocklisted with the plain reason, next release searched, nothing imported. Torrents are checked while downloading, Usenet before import; names and sizes only, files are never opened |
| Cleanuparr | Download cleaner / seeding rules | ✅ | After a confirmed import, hourly sweep, failed downloads after an hour; qBittorrent, SABnzbd, NZBGet and Transmission, AnimeArr's own category/label only, seeding rules respected. Deluge and rTorrent downloads are only removed together with their grab; Usenet blackhole folders are cleaned, torrent blackholes never |
| Unpackerr | Unpack archives | ➖ | 7z/ZIP only, off by default. RAR is intentionally not supported: anime releases rarely use RAR, so it is not worth the licence and image-size cost; RAR downloads are flagged for you |
| Huntarr | Missing hunting | 🟡 | Missing-episode/movie search, managed shows only, per-hour cap, off by default |
| Huntarr | Upgrade hunting | ✅ | Quality upgrades towards each profile's goal, plus dual-audio upgrades; budgeted |
| Prowlarr | Indexer health | ✅ | Learned per indexer from failed download links |
