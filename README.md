# AnimeArr

<p>
  <a href="https://ko-fi.com/moritranslates"><img src="https://ko-fi.com/img/githubbutton_sm.svg" alt="Support on Ko-fi"></a>
</p>

**Status: pre-1.0, in development (v0.1.0-dev). Not ready for general use.**

An anime-first, phone-first companion for Sonarr, Radarr and Prowlarr. v0.1 is the "smart download layer":

- imports your existing Sonarr/Radarr anime library (read-only) and matches it to AniDB;
- identifies anime release names properly (fan "S6 - 01" numbering, absolute numbers, AniDB aliases, per-show rules), without TheXEM;
- audits: files missing your subtitle language, gaps, and Season 0 specials (junk vs real, movies that belong in Radarr);
- Deep Search across Prowlarr with every result explained (language likelihood, burn-in, raw, foreign-only, Usenet first);
- grabs with confirmation, imports through Sonarr with explicit episode IDs, then verifies the file;
- "Managed shows" for the current season, with dry-run on by default.

See [BACKLOG.md](BACKLOG.md) for what is planned.

## Run locally

```bash
npm install
npm run dev        # builds the web UI, then runs the server on http://localhost:8484 (config in ./.devconfig)
npm test           # parser, resolver, ranking and pipeline tests
```

Docker: `docker build -t animearr .` then run with `-p 8484:8484 -v /path/to/appdata/animearr:/config`.
Mount the downloads (e.g. `/data`) and the anime libraries (e.g. `/media/Anime`) at the same paths Sonarr uses, so
AnimeArr can check files with ffprobe before importing them.
Keep `/config` on a local disk (on Unraid `/mnt/cache/appdata`, not `/mnt/user`): SQLite can be damaged on network or FUSE filesystems.

## First login

The default login is **admin / animearr**. The app shows a banner until you change it in Settings → Security, where you can also
tick "No password on my local network" (applies to private LAN addresses only; anything through a reverse proxy still logs in).

## Licence

GPL-3.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) (portions ported from Sonarr; based on Tastearr).

## Support

AnimeArr is free and open source. If it's useful to you, you can support development on [Ko-fi](https://ko-fi.com/moritranslates).
