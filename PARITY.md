# Parity matrix (living)

The 1.0 release gate: before tagging 1.0, a separate parity-audit run checks every row below (and anything missing from it) as **cloned**, **dropped (why)** or **missing**. Kept up to date as features land.

Status: ✅ cloned · 🟡 partial · ❌ missing · ➖ intentionally dropped

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
| Search | RSS sync | Sonarr/Radarr | 🟡 | Managed shows only; full RSS = step 6 |
| Search | Missing search (Wanted → Missing) | Sonarr/Radarr | ✅ | Rate-limited, managed shows + monitored movies |
| Search | Cutoff unmet / upgrades | Sonarr/Radarr | 🟡 | Dual-audio upgrades; quality cutoff upgrades missing |
| Activity | Queue with live progress, remove/blocklist | Sonarr/Radarr | ✅ | Own downloads + Sonarr queue problems |
| Activity | History | Sonarr/Radarr | ✅ | Timeline grouped by day; one event per grab with a stage track; why, fixes, undo |
| Activity | Blocklist | Sonarr/Radarr | 🟡 | Blocklist exists; no management page yet |
| Calendar | Month / week / agenda, movies | Sonarr/Radarr | ✅ | |
| Import | Completed download handling | Sonarr/Radarr | ✅ | AnimeArr's own importer only |
| Import | Manual import UI | Sonarr/Radarr | ✅ | Series ⋯ → Import files; "Import manually…" fix button |
| Settings | Media management (naming, folders, importing, file management, permissions) | Sonarr/Radarr | 🟡 | Naming, importing, permissions; review against Sonarr in the audit |
| Settings | Profiles | Sonarr/Radarr | 🟡 | Language profiles + watch modes + size presets; quality profiles missing |
| Settings | Protocol priority + delay profiles | Sonarr | 🟡 | Per-profile protocol order exists; **1.0:** "Prefer Usenet / Prefer Torrent / No preference" per profile with a global default, Sonarr-style per-protocol delays (wait N min for Usenet before a torrent), shown at the top of Indexers and Download clients, reflected in grab "why" texts |
| Settings | Indexers | Sonarr/Radarr | 🟡 | Settings → Indexers: card grid, Usenet \| Torrent columns, Prowlarr's indexers with protocol, priority and learned health. **1.0:** direct Newznab/Torznab (custom forms: URL, API path, key/passkey encrypted and redacted, categories with anime presets 5070/5000 and 2000 for movies, priority, seed ratio/time, tags, Test with a sample search); Jackett as an indexer manager; a curated, versioned anime indexer catalogue (JSON in the repo, each entry verified live with a date: AnimeTosho Newznab/Torznab, Nyaa, SubsPlease RSS, TokyoTosho, AniDex, AniRena, Shana Project, Bangumi Moe/acg.rip, Mikan and dmhy as Chinese sources, Usenet presets such as NZBgeek/NZBPlanet/DrunkenSlug/NinjaCentral/nzb.su/NZBFinder, private presets such as AnimeBytes/AnimeTorrents); duplicate detection (same site via Prowlarr and direct) |
| Settings | Download clients | Sonarr/Radarr | 🟡 | Settings → Download clients: cards in Usenet \| Torrent columns (SABnzbd, qBittorrent), live status, usage. **1.0:** multiple clients with "+ Add" (SABnzbd, NZBGet, qBittorrent, Transmission; Deluge and rTorrent later), each with category, priority, enabled, remove-completed, Test and remote path mapping; the client is picked per protocol by priority |
| Settings | Media servers | Sonarr/Radarr | 🟡 | Plex (scan after import/rename). Jellyfin/Emby later |
| Settings | Migration (Sonarr/Radarr) | — | ✅ | Settings → Migration: connections + cutover, "only needed until cutover" |
| Settings | Connect / notifications | Sonarr/Radarr | ✅ | Discord, ntfy, in-app bell; deep links; every problem carries fix buttons |
| Settings | Metadata (Plex/Kodi files) | Sonarr/Radarr | ❌ | Step 3 (.plexmatch) |
| Settings | Tags | Sonarr/Radarr | ❌ | |
| System | Status, tasks, backups, logs | Sonarr/Radarr | 🟡 | Jobs, backups/restore; no log viewer |
| Setup | First-run setup wizard | — | ❌ | **1.0.** Welcome: "I'm new" vs "I already use Sonarr/Radarr" (+ language, skip). New: account → folders (browser, writable check, Docker path note) → download clients (Test, create the category) → indexers (Prowlarr, catalogue starter picks, custom) → preferences (protocol priority, language profile, size preset) → Plex → metadata keys → notifications → done (add first show / import existing folders). Migration path: connect Sonarr/Radarr → preview what's found (anime series/movies, roots, naming, clients, indexers, Plex, tags, profiles) with per-item import → review screens → handover (unmonitor, import lists off, with backups and undo) → guided takeover checklist (adopt, verify first imports, resolver, switch with confirmation, remove connections). Saved and resumable; re-run from Settings → System; Test or preview on every step |
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
| AniDB/AniList franchise model | ✅ | Own catalog; AniDB provider with strict rate limits |
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
