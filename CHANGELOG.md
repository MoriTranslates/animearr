# Changelog

All notable changes, newest first. The commit history has the crew's version of events; this is the Captain's log.

## Unreleased

### Safety
- **A replace that can't be undone says where both files are.** If an import replaced a file, failed, and then couldn't
  put the old file back, the message now names the old file's place in the recycling bin and where the new file is. The
  grab waits in "needs attention", and the old file is pinned in the bin: the daily purge and "Empty bin now" leave it
  alone until you press "I dealt with it" in Audit → Recycle.
- **Restoring a backup can't leave you without a database.** The backup is copied next to the live database, checked,
  and only then swapped in with one rename. If AnimeArr can't save a copy of the current database first, nothing is
  restored.
- **A batch import checks free space for all its files together.** Before, each file was checked on its own, so a big
  batch of copies could eat through the Minimum Free Space. Hardlinks and moves on the same disk still need no room.
- **The clean-up never deletes a folder that holds your library** (or AnimeArr's own data folder), even if a download
  client reports such a folder as a download.
- **Downloading a backup file asks for your password**, also when "no password on my home network" is on: the file
  holds the key to every saved password.
- **Cutover:** if Sonarr removes a show but its answer never arrives, AnimeArr finishes the switch on its next start (or
  when you switch the show again) instead of leaving it half done.
- Service addresses refuse link-local and cloud metadata addresses in every IPv6 spelling too.
- **The calendar link no longer contains your API key.** The iCal feed has its own read-only token that opens nothing
  else. **Re-subscribe once:** copy the new link from Calendar → iCal link into Google, Apple or Outlook; old links with
  `?apikey=` stop working. Making a new API key also changes the calendar link. If you shared an old calendar link,
  make a new API key (Settings → Security), since the old one was in it.
- **The API key can't change settings or delete files.** It still works for the Sonarr-compatible API and the
  documented automation routes, but changing settings, the account, notification channels, indexers, download clients
  or the setup wizard, deleting episode or season files and emptying the recycling bin now need a signed-in browser.
- **Notification secrets don't follow a new address.** Pointing a webhook at a new URL, or an email channel at a new
  server, port or security setting, drops the saved header values or SMTP password unless you type them again.
- **"No password on my local network" ignores forwarded traffic with a `TRUST_PROXY` list too.** Before, setting
  `TRUST_PROXY` to your proxy's address let any LAN device that sent `X-Forwarded-For` (a second tunnel or proxy, such
  as cloudflared) in without a password.
- **The login page can't be used to tie up the server.** It reads at most 8 KB per request (before, anyone could make
  AnimeArr hold up to 256 MB in memory per request), and the record of failed logins is capped: one address trying
  many user names, or a flood of addresses, can't grow it without limit or wipe the back-off of a real guesser.
  IPv6 clients are counted per /64 (one home or server), so rotating through their own addresses doesn't help.
- **Private IPv6 (ULA, `fd…`/`fc…`) no longer counts as your home network by default**, just like Docker's 172.16/12:
  Docker's own IPv6 networks use it, so traffic through a Docker gateway could look local. **If you reach AnimeArr
  over Tailscale or a ULA address** and use "No password on my local network" (or still have the default password),
  list the range in `ANIMEARR_LOCAL_NETWORKS`, which now takes IPv6 too, e.g.
  `ANIMEARR_LOCAL_NETWORKS=10.0.0.0/8,192.168.0.0/16,fd7a:115c:a1e0::/48`. Plain IPv4 home networks and IPv6
  link-local are unchanged.
- **A fresh install behind a reverse proxy set up with a hop count (`TRUST_PROXY=1`) can log in.** The default login
  was refused everywhere, so the password could never be changed. It now works from home through your proxy (when the
  proxy has a private or loopback address and you open AnimeArr by IP, a LAN name or a name in
  `ANIMEARR_ALLOWED_HOSTS`); it is still refused for clients outside your home network.
- **Logging out really ends the session.** Before, the session stayed valid for 30 days after "Log out" (only the
  browser forgot it), so a copied session cookie kept working. Logging out now signs out **every** browser, like a
  password change does; log in again on your other devices.

### Fixed
- The Sonarr-compatible API matches query names in any case (`seriesID` works like `seriesId`), and answers
  `PUT series/editor` (bulk monitoring, quality profile and tags; nothing that moves or deletes files).
- The Sonarr-compatible API's `PUT series/{id}` now treats `monitored: false` the way the series editor does: the show
  is no longer managed by AnimeArr (its files stay). Before, a single show ignored it.
- The Sonarr-compatible API reports repacks and `v2` releases correctly again.
- Remux releases are recognised as remuxes again when season packs and search results are compared (a few patterns had
  been saved with an invisible control character instead of a word boundary).
- Browsing a big download folder in the manual import no longer pauses the rest of the app; pages stop polling while
  their browser tab is hidden.

### Added
- **Episode thumbnails and descriptions for Jellyfin, Emby and Kodi.** Next to each video AnimeArr can now write a
  `name-thumb.jpg` picture, and each episode's NFO gets its description. They come from TMDB first (the right episode,
  following AnimeArr's season numbering; needs the TMDB key in Settings → Metadata; each season is fetched once and
  remembered for a week), then from Sonarr if it is connected. A frame cut from the video itself is available as a last
  resort, off by default, because it reads every file (wakes sleeping disks, slow on a big library) and skips anything
  still downloading or importing. Settings → Media servers has the two switches; thumbnails need the poster and banner
  switch to be on. AnimeArr only ever replaces or removes thumbnails it wrote itself: yours, or ones Sonarr left, stay
  as they are. Its own follow the video when it is renamed and go when it is deleted. Plex ignores these files and
  uses its own pictures.
- **Pick where a season's episode descriptions and thumbnails come from.** When TMDB is filed differently from the show
  (say a sequel TVDB lists as season 2 is its own show on TMDB), a season's menu on the show page now has "Episode info
  source…". Search TMDB, pick the show and season, set an episode offset if the numbering is shifted, check the first
  titles line up side by side, and save. "Back to automatic" undoes it. This only changes the descriptions and
  thumbnails written for your media server; searching, numbering and importing never use it. Rewrite the show's
  metadata afterwards to see the change.
- **Big changes make one library scan.** When more than 20 folders change at once, Plex, Jellyfin, Emby and Kodi are
  asked to scan the library once instead of folder by folder.
- **A fuller Sonarr-compatible API.** Besides what request apps use, it now also answers the calendar, the queue (paged,
  with remove and blocklist), history, wanted (missing, and below your quality goal), episode files with their media info,
  disk space, health, languages and quality sizes, a manual release search and grab (through the normal checks; practice
  mode still applies), and more commands (season search, rescan, RSS check, backup) that clients can poll. Episode files
  can't be deleted through it. Other Sonarr clients may work with this, but only request apps are supported.
- **AnimeArr's own API is documented** in docs/API.md, for anyone who wants to build on AnimeArr directly.
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
- **Import lists: AniList and MyAnimeList.** Settings → Import lists adds the shows on your AniList or MyAnimeList
  account to AnimeArr by itself, the way Sonarr's import lists do. Pick the account, which statuses to import
  (Watching and Planning by default; Completed, Paused, Dropped and Rewatching are optional), the language profile,
  folders, how to monitor, tags and whether new shows go to the fill-in queue. Test shows what it found. Lists check
  every 6 hours (changeable) and Sync now runs one at once. Shows already in your library are skipped (another season
  of a show you have counts), and movies on a list are added as movies. A list only ever adds: it never removes or
  unmonitors anything. A new list first shows what it would add and adds nothing until you confirm; after that it adds
  new shows by itself, up to 50 per check. Exclude a show to keep every list from adding it, and tick "Don't let my
  import lists add it again" when you remove a show. In practice mode shows are added but nothing downloads. Each add
  appears in Activity as "Added from AniList list 'name'". MyAnimeList needs a free client ID from
  myanimelist.net/apiconfig (stored encrypted); AniList needs nothing.
- **A calendar feed for your calendar app.** The Calendar page has an "iCal link" button. The link
  (`/feed/calendar/animearr.ics?apikey=…`) works in Google Calendar, Apple Calendar, Outlook and others, and shows
  every episode at its air time (with its length) and movie releases as all-day events. Choose how many days back and
  ahead, whether to include shows you don't monitor, and only some tags. The link contains your API key, so treat it
  like a password.
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
  plain text (capitals don't matter) or a regular expression between slashes, like `/\b(x265|hevc)\b/`; a
  regular expression that doesn't work is refused when you save. A release a rule blocks is skipped everywhere
  (searches, automatic grabs, upgrades, movies) and shown with the reason: "Blocked by release rule 'No HEVC':
  contains 'x265'". Preferred terms only nudge the order (at most 8 points), after language, quality and SeaDex, so
  they never win over a better language fit or rescue a blocked release. A rule can be limited to shows and movies
  with certain tags, and a "Test against a title" box shows what your rules do to a sample name.
- **Tags.** Settings → Tags adds, renames and deletes tags (deleting shows what uses the tag and unlinks it). Put tags
  on a show or movie from its page, or on many shows at once with Library → Shows → Select → Tags. Request apps like
  Jellyseerr see the same tags through the Sonarr-compatible API, and tags they set are real tags in AnimeArr.

### Changed
- **⚡ no longer makes you wait.** Tapping ⚡ (Download automatically) answers at once with "Searching N episodes…
  (results in Activity)"; the search runs in the background. The episodes show "Searching…" until it's done, then a
  message says what happened (download started, needs a look, skipped and why), the same as before. Activity has one
  line per search with the outcome of each episode, and grabs and failures still reach the bell. Tapping ⚡ again on an
  episode that is still being searched skips it ("already being searched"). Movies work the same way. A search that
  hadn't finished when AnimeArr restarts is noted in Activity; the scheduled searches pick those episodes up again.
- **Faster searches.** All searches in AnimeArr now share one limit of 6 indexer queries at a time and take turns, so
  one big ⚡ doesn't hold up the next one and your indexers aren't flooded. An indexer that takes longer than 20 seconds
  to answer a query is left out of that query instead of holding everything up (it counts as a failed search for its
  health, so one that keeps timing out is flagged as before). The same query asked again within 10 minutes reuses the
  answer, so ⚡ right after "Pick a version…" or two ⚡ on the same show don't ask the indexers twice. And when ⚡ has
  already found SeaDex's best release for an episode, with the right language, from your preferred protocol and with
  nothing to warn about, it stops searching for that episode early (Activity says "stopped early").

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
