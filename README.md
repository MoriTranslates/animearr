# AnimeArr

**Status: pre-1.0, in development (v0.1.0-dev). Not ready for general use.**

An anime-first, phone-first companion for Sonarr, Radarr and Prowlarr. v0.1 is the "smart download layer":

- imports your existing Sonarr/Radarr anime library (read-only) and matches it to AniDB;
- identifies anime release names properly (fan "S6 - 01" numbering, absolute numbers, AniDB aliases, per-show rules), without TheXEM;
- audits: files missing your subtitle language, gaps, and Season 0 specials (junk vs real, movies that belong in Radarr);
- Deep Search across Prowlarr with every result explained (language likelihood, burn-in, raw, foreign-only, Usenet first);
- grabs with confirmation, imports through Sonarr with explicit episode IDs, then verifies the file;
- "Managed shows" for the current season, with dry-run on by default.

See [PROPOSAL.md](PROPOSAL.md) (release plan at the top) and [BACKLOG.md](BACKLOG.md).

## Run locally

```bash
npm install
npm run dev        # builds the web UI, then runs the server on http://localhost:8484 (config in ./.devconfig)
npm test           # parser, resolver, ranking and pipeline tests
```

Docker: `docker build -t animearr .` then run with `-p 8484:8484 -v /mnt/cache/appdata/animearr:/config`.
Keep `/config` on a local disk (on Unraid `/mnt/cache/appdata`, not `/mnt/user`): SQLite can be damaged on network or FUSE filesystems.

## Licence

GPL-3.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) (portions ported from Sonarr; based on Tastearr).
