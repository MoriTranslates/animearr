# Changelog

All notable changes, newest first. The commit history has the crew's version of events; this is the Captain's log.

## Unreleased

### Added
- **Works with nzb360, LunaSea and Homepage: add AnimeArr as a Sonarr server.** The Sonarr-compatible API now also answers
  the calendar, the queue (paged, with remove and blocklist), history, wanted (missing, and below your quality goal), episode
  files with their media info, disk space, health, languages and quality sizes. A manual search lists releases with
  AnimeArr's score and its reasons for rejecting one, and picking a release grabs it through the normal checks (practice
  mode still applies). Commands now cover season search, rescan, RSS check and backup, and clients can poll them.
  Episode files can't be deleted through the API. See the README for how to connect nzb360.
- **More ways to be notified.** Settings → Connections → Notifications can now add webhook, Telegram, Pushover and email
  (SMTP) channels next to Discord and ntfy. The webhook sends JSON per event (POST or PUT, with your own headers, such
  as an Authorization token). Telegram takes a bot token and chat id, with an optional topic and a silent switch.
  Pushover takes your user key and app token, with priority, device and sound. Email takes a server, port, encryption
  (none, STARTTLS or TLS), login and addresses. Every channel has its own on switch, event toggles and a Test button;
  tokens and passwords are stored encrypted and never shown again, and a channel that fails shows its last error
  without holding anything up. The webhook's payload is described in the README.
- **A log viewer.** Settings → System → Logs shows the last 2000 lines AnimeArr printed, with a level filter, search,
  refresh every 5 seconds and a download. API keys, tokens and passwords are blanked out. A copy is kept in
  `/config/logs` (5 MB, one older file), so the lines survive a restart.
- **Download and upload a backup.** Settings → System → Backups can download one file with a consistent copy of the
  database and the key that unlocks your saved passwords (so keep it private), and restore from such a file on another
  machine or after a disaster. The file is checked first (a backup from a newer AnimeArr is refused), a safety copy of
  what is there now is kept, and restoring asks for your password and restarts AnimeArr.
- **The new-release watch also looks after files you already have.** Every few minutes AnimeArr checks each indexer's
  newest releases. As before, a release for an episode or movie you are waiting for makes its search run now. Now, a
  newer version (v2, REPACK) from the same group as an episode you have, or a better release (say a Blu-ray) for a
  season whose files are below your quality goal, brings that check forward instead of waiting days or weeks. The
  Activity log says what it saw ("New release seen: SubsPlease v2 of episode 9, checking for a newer version"). Nothing
  is grabbed straight from the feed: the normal search still ranks every release, and the upgrade watcher's limits (daily
  size, seasons a day, the first-day wait, pause, locks, the recycling bin) still apply.
- **The new-release watch asks each indexer for its own newest releases.** Before, one shared list of 300 could be
  filled by a busy indexer and push a quieter one's new releases out between checks. Now each Prowlarr indexer is asked
  for its newest 100 in its own request.
- **v2 and repack releases count.** Fansub groups often re-release an episode as v2 or v3 to fix mistakes, and scene
  groups call theirs PROPER or REPACK. AnimeArr now reads all of these as a newer version. With Settings → Media
  management → Propers and repacks on "Prefer and upgrade" (the default), a newer version from the same group as the
  file you have replaces it, even when the quality is the same, and searches mark it "Newer version" with the reason
  ("v2 of the episode you have from SubsPlease (fixes a v1) — upgrade"). A different group's v2 is not a swap, a
  locked show, season or file ([Keep] / [Remaster]) is never replaced, and your release rules and blocklist still apply
  first. The quality upgrade watcher also checks episodes that aired in the last two weeks for a newer version, and
  the ⚡ search on an episode you already have looks for one (it needs a recycling bin). "Do not upgrade automatically"
  prefers newer versions when picking a new release but never replaces a file you have; "Do not prefer" ignores versions.
- **Change file date and delete empty folders now work.** Settings → Media management → Change file date sets an
  imported or renamed episode's modified date to its air date (none, local day, or exact UTC time). Delete empty
  folders removes a season or show folder that AnimeArr's own importer or renamer just left empty; folders with
  anything inside (hidden files too) and your library folders are never removed. Both are for AnimeArr's own importer;
  shows imported through Sonarr keep Sonarr's behaviour.
- **Release rules.** Settings → Release rules works like Sonarr's release profiles: a rule lists terms a release name
  must contain (any one of them) and terms it must not contain, plus optional preferred terms with a score. A term is
  plain text (capitals don't matter) or a regular expression between slashes, like `/(x265|hevc)/`; a
  regular expression that doesn't work is refused when you save. A release a rule blocks is skipped everywhere
  (searches, automatic grabs, upgrades, movies) and shown with the reason: "Blocked by release rule 'No HEVC':
  contains 'x265'". Preferred terms only nudge the order (at most 8 points), after language, quality and SeaDex, so
  they never win over a better language fit or rescue a blocked release. A rule can be limited to shows and movies
  with certain tags, and a "Test against a title" box shows what your rules do to a sample name.
- **Tags.** Settings → Tags adds, renames and deletes tags (deleting shows what uses the tag and unlinks it). Put tags
  on a show or movie from its page, or on many shows at once with Library → Shows → Select → Tags. Request apps like
  Jellyseerr see the same tags through the Sonarr-compatible API, and tags they set are real tags in AnimeArr.

## 0.10.0-beta (2026-10-31): works with your apps, aims for the best

### Added
- **Malware blocker.** A download that holds an executable or script (`.exe .scr .bat .cmd .com .msi .lnk .vbs .js
  .ps1 .jar .apk`, editable in Settings), a video with a second extension (`episode.mkv.exe`), a password-protected
  archive instead of a video, or a video far too small for the episode's runtime is removed from the download client,
  blocklisted with a plain reason ("contained Episode 05.mkv.lnk") and never imported; AnimeArr searches for the next
  release. Torrents are checked while they download (when the client lists their files), every download before
  import. On by default; the check reads names and sizes only. It is logged in Activity.
- **Strikes before removal.** A stalled download, or a torrent that finds no metadata, gets a strike per health check
  (at least 10 minutes apart) and is removed only at the limit (3 by default, Settings → Stalled and failed
  downloads). A download that starts moving again loses its strikes. The queue shows the strikes. A failure the
  download client itself reports is still final.
- **NZBGet and Transmission clean-up.** After a confirmed import, NZBGet's finished job leaves its history (the
  "remove finished jobs" client setting now does this) once no video is left in its folder, and Transmission torrents
  are removed with their data once the seeding rules are met, like SABnzbd and qBittorrent. Only AnimeArr's own
  category or label, and only inside its own download folders.
- **Blocklist page.** Activity → Blocklist lists blocklisted releases with show or movie, reason, date, protocol and
  indexer. Remove one or several (a release can then be picked again), and filter by show.
- **Import an existing anime folder without Sonarr.** Pick a library folder (setup wizard for new users, or
  Settings → System → Import existing folders) and AnimeArr lists its show folders, skipping hidden folders and ones
  a show already owns. Each folder is matched to a show with a confidence and a plain reason: IDs in the folder name
  (`{tvdb-N}`, `[tvdbid-N]`, `{anidb-N}`, `[anidbid-N]`, `{tmdb-N}`) win; otherwise "Title (Year)" is matched against
  AnimeArr's alias index and AniList (one folder at a time, within the existing AniList budget). You accept a match,
  pick another candidate, search by hand or skip, or add all confident matches at once. Shows are added as the
  native Add does (managed, same defaults) but keep the existing folder as their path; the files in it are recorded
  and matched to episodes. Nothing is moved, renamed or deleted: files that can't be matched are listed and left
  alone, and renaming stays the separate "Rename files" action. Series only; movies aren't imported this way.
- **Use AnimeArr with Jellyseerr or Overseerr.** AnimeArr now answers a Sonarr v3-compatible API (`/api/v3`), so
  request apps can add AnimeArr as a Sonarr server. A request becomes a native AnimeArr show, managed, with only the
  requested seasons monitored, and a search for what's missing. Availability and download progress flow back.
  See "Use with Jellyseerr / Overseerr" in the README.
- Settings → Security shows AnimeArr's API key (copy, or make a new one) for those apps.
- Monitoring scopes have a "picked seasons" option, which is what a request sets.
- **Quality goals.** Each profile has a goal: Good enough (WEB 1080p), Aim high (Blu-ray 1080p, the default) or
  Collector (SeaDex's best). The setup wizard asks for it; existing installs get the question once on Home.
- **Quality categories with an anime rebase.** Sonarr's quality names, grouped like the TRaSH Guides anime profile:
  WEB-DL and WEBRip are one category, HDTV captures rank lower inside it, a 2160p release counts as 1080p unless it's
  a real UHD Blu-ray, and a show with no Blu-ray release aims for the best that exists (the DVD for older shows).
- **SeaDex is part of ranking.** SeaDex's best pick for a show scores highest, its alternative next; Dual and Either
  watch modes prefer the dual-audio picks. TRaSH's anime BD/Web group tiers fill in where SeaDex has no entry, and
  low-quality groups rank last. The show page lists SeaDex's picks per season.
- **Automatic quality upgrades.** Seasons below their goal are searched now and then (weekly in the Blu-ray window,
  3–6 months after airing) and swapped through Replace season: each new file replaces its episode only after it
  passes the checks, and old files go to the recycling bin. Guard rails: the first run only lists its plan (grabs
  start a day later, or with "Start now"), a pause switch, a daily budget of seasons, and no churn: inside the same
  quality category a file is only replaced when it isn't already that category's best. Files are judged by their
  original release, so a file Tdarr re-encoded isn't seen as a downgrade. See Audit → Maintenance → Quality upgrades.
- **Keep as is.** Lock a show or a season on its page, or set a profile to keep original files: those files are never
  upgraded, and their names get `[Keep]` through the new `{Keep Tag}` naming token, so a one-step Tdarr guard (shown
  in Settings → Profiles) skips them. Files named `[Remaster]` count the same.
- Request apps see each profile with its goal (e.g. "English subs: Aim high (Bluray 1080p)") and AnimeArr's quality
  categories as the profile's qualities.
- **Duplicate-listing guard.** TVDB sometimes lists an OVA or sequel twice: as specials or a season of a parent show
  and as its own show. AnimeArr's catalog knows where each AniList entry is filed, so an episode the library already
  holds under another show ("owned elsewhere, filed as Slayers S00E03") is no longer counted as missing and is never
  searched or grabbed automatically: not by the scheduler, the missing-episode search, fill-in, ⚡ search or the
  quality upgrade watcher (the grab itself refuses it as a last line). Shows are matched by AniDB/AniList ids; a title
  is used only when no id resolves and the episode counts agree. Picking a release by hand is still allowed, with a
  warning. Audit → Maintenance → Duplicate listings shows each pair with the overlapping episodes and file counts on
  both sides, and "Stop managing this show" (AnimeArr only; for Sonarr's shows it explains how to retire the copy in
  Sonarr, which AnimeArr never changes). A duplicate whose other listing has no files yet is listed but not blocked.
- **SeaDex on the show page.** Details compares each season's files with SeaDex's picks (best, alt, or "you have X WEB;
  SeaDex's best is Y"), using each file's original release name so Tdarr re-encodes still count as their source. The
  episode sheet gets a "SeaDex best" / "SeaDex alt" chip, and release lists (including Replace season's packs) mark
  SeaDex's picks. "Check SeaDex now" fetches a show's picks immediately (once per 30 minutes per show). "Upgrade now"
  per season runs the upgrade watcher's own pick right away, after showing what it would grab and its size; locks,
  the goal, practice mode and the no-churn rule apply, and the grab counts towards the daily budgets.
- The upgrade watcher has a daily download-size budget (100 GB by default, Audit → Maintenance → Quality upgrades)
  next to the seasons-a-day budget. A season whose estimated size doesn't fit the rest of the day waits and is tried
  again later; one bigger than the whole budget is grabbed alone, only on a day nothing else was, and is logged.

### Changed
- A SeaDex pick now counts for a release only when its source fits: a Blu-ray pick no longer blesses the same group's
  HDTV, TV raw or WEB release. Picks are taken as Blu-ray unless SeaDex tags them otherwise; a release that names no
  source still matches by group.

### Notes
- RAR unpacking is intentionally not supported (anime releases rarely use RAR). 7z and ZIP unpacking stay.
- Removing a show through the API removes it from AnimeArr only: files are never deleted, whatever the request app
  asks. Shows that Sonarr still owns can't be removed through it.

### Media servers
- Jellyfin, Emby and Kodi connections next to Plex (Settings → Media servers): Test, path mappings, and a scan of just
  the changed folder after AnimeArr imports, upgrades, renames or deletes something.
- Optional files for the media servers, written beside the videos from AnimeArr's own catalog so every server shows
  AnimeArr's numbering: NFO files (tvshow.nfo, season.nfo, one per episode file; read by Jellyfin, Emby and Kodi),
  .plexmatch for Plex, and poster/banner artwork from AniList when a folder has none. Kept in step on imports,
  upgrades, renames and deletes. Files you made yourself (no AnimeArr marker line) are never overwritten or removed.
  Off by default on existing installs; "Write them for every show now" fills in an existing library.
- The new-user wizard asks which media server(s) you use and switches on the files they read.
- New naming token `{Server Id Hint}` for series folders: `{tvdb-12345}` (Plex) or `[tvdbid-12345]` (Jellyfin, Emby),
  following the main media server.

## 0.9.0-beta (2026-10-30): first public beta

Everything is new, so here are the highlights rather than a list of 100 commits.

### Finding and grabbing
- Anime-aware identification: AniList + AniDB + Anime-Lists numbering, fansub "S6 - 01", absolute episodes, split
  cours, season packs ("Season 1", "(01-12)", "(Complete)"), per-show aliases and rules. No TheXEM.
- Search across Prowlarr and direct indexers (Newznab, Torznab, Nyaa, SubsPlease, RSS) with a curated anime catalogue;
  every result explains itself. A circuit breaker turns off indexers whose downloads keep failing and checks them again.
- Ranking by your language profile (Sub / Dub / Dual / Either), size preset, protocol preference and group consistency
  within a season. Burned-in and signs-only subtitles are spotted.
- Managed shows, RSS-triggered and scheduled searches, a slow "fill-in" queue for backlogs, movie search, dual-audio
  upgrades. All start in dry run.
- Smart batch grabs: per season, only the missing episodes or the whole season as a Replace season (one group, same
  quality or better), with the reason in plain words. Torrent clients that can skip files (qBittorrent, Transmission,
  Deluge, rTorrent) download only the wanted episodes of a batch; the rest download it whole and the unneeded files are
  cleaned up after a confirmed import.
- Download clients: SABnzbd, NZBGet, qBittorrent, Transmission, Deluge and rTorrent/ruTorrent, plus Usenet and Torrent
  Blackhole (folder drop) for anything else: off by default, with a plain list of what you lose on its card.

### Checking and importing
- Every download is probed before import (full subtitles in your language, the right audio, not a sample); failures are
  blocklisted and the next release is tried; successes are imported and renamed by AnimeArr itself.
- Replace season: a whole season swapped for a better pack, one verified episode at a time.
- Replace season opens on a "Season packs" tab (whole season first, then upgrades over what you have) with "Single
  episodes" on their own tab; each pack says whether it beats your current files (TV < WEB-DL < Blu-ray < remux, then
  resolution).
- Wrong files caught before they land: a series batch posing as a movie, a release that fits another movie better, a
  dub without the original audio, subtitles in another language. The after-import check also looks at Sonarr's imports.
- Dual-audio upgrades for Dual-mode shows: sub-only episodes are upgraded when a real dual-audio release appears
  (report-only by default; the import checks both audio tracks).
- Multi-part movies imported as Plex-stacked parts. Creditless openings and endings treated as real extras.
- Fix detection for wrongly tagged tracks, Watch in Plex, Peek (three frames from the middle).
- Clean-up after imports, stalled-download handling, a recycling bin with retention.

### Living with it
- Home with Airing today (countdowns), Just arrived, Ready to binge; a seasonal calendar; Activity with plain-language
  cards and undo; a bell that only counts what needs you.
- Installable on phones (QR code in Settings, an "Add to home screen" card on the phone itself), text size,
  light/dark, Comic mode, and manga speech-bubble toasts.
- A new icon: the mast-and-pennant "A", in the favicon, phone app icons, sidebar, Unraid template and README.
- Setup wizard for new users and for people coming from Sonarr/Radarr, with a guided migration.
- ▶ Trailer on Find & add, the Add dialog and the show page, to see a show's art style first: plays the official
  trailer from YouTube (or Dailymotion); nothing is downloaded or stored but the video's id.

### Running it
- Multi-arch Docker image (amd64 + arm64), PUID/PGID/UMASK/TZ, URL base for sub-path proxies, Unraid template.
- Default login captain / morebooty, which works only on your home network until you change it (the wizard and a
  banner ask you to). Existing accounts are never touched. Encrypted secrets, CSRF protection, no framing.
  SECURITY.md explains the limits of the home-network check (port-forwards and TCP forwarders can look local).
- Hardening from a pre-launch security review: indexer API paths can't redirect a saved key, the recycling bin can't
  be AnimeArr's own data folder, and the Alpine 3.24 base image brings 7-Zip's fix for CVE-2025-55188.

### Known limitations
- Files imported before AnimeArr took over a show aren't re-audited yet; a library audit is planned for 0.9.1.
- More in the README's "Known limitations" and PARITY.md.
