# Parity matrix (living)

The 1.0 release gate: before tagging 1.0, a separate parity-audit run checks every row below (and anything missing from it) as **cloned**, **dropped (why)** or **missing**. Kept up to date as features land.

Status: ✅ cloned · 🟡 partial · ❌ missing · ➖ intentionally dropped

## Sonarr / Radarr

| Area | Feature | Source | AnimeArr | Notes |
|---|---|---|---|---|
| Library | Series list, series page, episode list | Sonarr | 🟡 | From Sonarr's data (companion); own metadata is takeover step 4 |
| Library | Movies list, movie page | Radarr | 🟡 | From Radarr's data; takeover step 4 |
| Library | Add series / add movie | Sonarr/Radarr | ❌ | Takeover step 5 |
| Library | Delete episode file (recycle bin) | Sonarr | ✅ | Through Sonarr today |
| Library | Rename files (preview + apply) | Sonarr/Radarr | ❌ | Takeover step 2 |
| Library | Rescan / analyse media files | Sonarr/Radarr | ✅ | Own ffprobe scanner (step 1), forced flags included |
| Search | Automatic search (episode, season, bulk, movie) | Sonarr/Radarr | ✅ | ⚡ Search; season packs preferred; confidence gate → "needs a look" |
| Search | Interactive search | Sonarr/Radarr | ✅ | 🔍 Deep Search (alias-expanded, explained) |
| Search | RSS sync | Sonarr/Radarr | 🟡 | Managed shows only; full RSS = step 6 |
| Search | Missing search (Wanted → Missing) | Sonarr/Radarr | ✅ | Rate-limited, managed shows + monitored movies |
| Search | Cutoff unmet / upgrades | Sonarr/Radarr | 🟡 | Dual-audio upgrades; quality cutoff upgrades missing |
| Activity | Queue with live progress, remove/blocklist | Sonarr/Radarr | ✅ | Own downloads + Sonarr queue problems |
| Activity | History | Sonarr/Radarr | ✅ | Grab history + activity log with "why" and undo |
| Activity | Blocklist | Sonarr/Radarr | 🟡 | Blocklist exists; no management page yet |
| Calendar | Month / week / agenda, movies | Sonarr/Radarr | ✅ | |
| Import | Completed download handling | Sonarr/Radarr | 🟡 | Through Sonarr/Radarr ManualImport; own importer = step 2 |
| Import | Manual import UI | Sonarr/Radarr | ❌ | Step 2 |
| Settings | Media management (naming, folders, importing, file management, permissions) | Sonarr/Radarr | ❌ | Step 2 |
| Settings | Profiles | Sonarr/Radarr | 🟡 | Language profiles + watch modes (anime-specific); quality profiles missing |
| Settings | Indexers | Sonarr/Radarr | ➖ | Prowlarr owns indexers |
| Settings | Download clients | Sonarr/Radarr | ✅ | SABnzbd, qBittorrent |
| Settings | Connect / notifications | Sonarr/Radarr | ❌ | Step 8 (Discord, ntfy/Gotify) |
| Settings | Metadata (Plex/Kodi files) | Sonarr/Radarr | ❌ | Step 3 (.plexmatch) |
| Settings | Tags | Sonarr/Radarr | ❌ | |
| System | Status, tasks, backups, logs | Sonarr/Radarr | 🟡 | Jobs, backups/restore; no log viewer |
| API | REST API for other apps | Sonarr/Radarr | ❌ | Sonarr-compatible API is a takeover item |

## Anime-specific (PROPOSAL)

| Feature | AnimeArr | Notes |
|---|---|---|
| Alias index, anime parser, numbering resolver (no XEM) | ✅ | |
| Language verification (ffprobe), learned group languages | ✅ | |
| Watch modes (sub/dub/dual/either), per-show profiles | ✅ | |
| Burned-in facts, forced/signs detection | ✅ | |
| After-import check with auto repair | ✅ | Log-only by default |
| Series ↔ movie franchise links, S0 movie guard | ✅ | |
| AniDB/AniList franchise model | ❌ | Step 4 |
| SeaDex input | ❌ | |

## Absorbed tools

| Tool | Feature | AnimeArr | Notes |
|---|---|---|---|
| Cleanuparr | Queue cleaner (stalled, failed, metadata) | ✅ | Queue health |
| Cleanuparr | Strikes before removal | ❌ | Single timeout today |
| Cleanuparr | Malware blocker (e.g. .exe/.lnk in downloads) | ❌ | |
| Cleanuparr | Download cleaner / seeding rules | ❌ | |
| Unpackerr | Unpack archives | 🟡 | 7z/ZIP; RAR needs a user decision; off by default |
| Huntarr | Missing hunting | ✅ | Missing-episode/movie search |
| Huntarr | Upgrade hunting | 🟡 | Dual-audio only |
| Prowlarr | Indexer health | ✅ | Learned per indexer from failed download links |
