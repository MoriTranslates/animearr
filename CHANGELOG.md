# Changelog

All notable changes, newest first. The commit history has the crew's version of events; this is the Captain's log.

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
- Multi-part movies imported as Plex-stacked parts. Creditless openings and endings treated as real extras.
- Fix detection for wrongly tagged tracks, Watch in Plex, Peek (three frames from the middle).
- Clean-up after imports, stalled-download handling, a recycling bin with retention.

### Living with it
- Home with Airing today (countdowns), Just arrived, Ready to binge; a seasonal calendar; Activity with plain-language
  cards and undo; a bell that only counts what needs you.
- Installable on phones (QR code in Settings), text size, light/dark, Comic mode, and manga speech-bubble toasts.
- Setup wizard for new users and for people coming from Sonarr/Radarr, with a guided migration.
- ▶ Trailer on Find & add, the Add dialog and the show page, to see a show's art style first: plays the official
  trailer from YouTube (or Dailymotion); nothing is downloaded or stored but the video's id.

### Running it
- Multi-arch Docker image (amd64 + arm64), PUID/PGID/UMASK/TZ, URL base for sub-path proxies, Unraid template.
- Default login captain / morebooty, which works only on your home network until you change it (the wizard and a
  banner ask you to). Existing accounts are never touched. Encrypted secrets, CSRF protection, no framing.

### Known limitations
See the README's "Known limitations" and PARITY.md.
