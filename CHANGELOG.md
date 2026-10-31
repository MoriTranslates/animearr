# Changelog

All notable changes, newest first. The commit history has the crew's version of events; this is the Captain's log.

## Unreleased

### Added
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

### Notes
- Removing a show through the API removes it from AnimeArr only: files are never deleted, whatever the request app
  asks. Shows that Sonarr still owns can't be removed through it.

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
