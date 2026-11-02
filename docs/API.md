# AnimeArr API

This is the guide for developers who want to talk to AnimeArr from their own code: a phone app, a dashboard widget
(Homepage and similar), a script. If you only want to run AnimeArr, you don't need this page.

- Machine-readable reference: [openapi.yaml](openapi.yaml) (OpenAPI 3.1; every operation is tagged `x-stability`).
- This page: how to authenticate, what to expect, and copy-paste examples for the common jobs.

AnimeArr's own API is what its web UI uses. It is JSON over HTTP, under `/api`. There is also an iCalendar feed and, for
request apps, a Sonarr v3-compatible layer under `/api/v3` (see [below](#sonarr-compatible-layer)).

## Contents

- [Base URL](#base-url)
- [Authentication](#authentication)
- [Conventions](#conventions)
- [Stability](#stability)
- [Common tasks](#common-tasks)
- [Endpoint index](#endpoint-index)
- [Sonarr-compatible layer](#sonarr-compatible-layer)
- [Building a dashboard widget](#building-a-dashboard-widget)

## Base URL

The examples use `http://animearr:8484`. Replace it with your own address. The default port is 8484.

If AnimeArr runs behind a reverse proxy on a sub-path, set the **URL base** (Settings -> System, or the `URL_BASE`
environment variable) and put it in front of every path: with a URL base of `/animearr`, the status call is
`https://example.com/animearr/api/status`. Paths in this document and in `openapi.yaml` are written without it.

## Authentication

Send AnimeArr's API key with every request, in either of two ways:

```sh
curl -H "X-Api-Key: YOUR_API_KEY" http://animearr:8484/api/status
curl "http://animearr:8484/api/status?apikey=YOUR_API_KEY"
```

The key is in AnimeArr under **Settings -> Security -> API key for other apps**. Prefer the header. The query
parameter exists for clients that cannot set headers (calendar apps, request apps), but URLs end up in logs and browser
history. Regenerating the key (a signed-in browser can do this on the same page) invalidates the old one immediately.

What you get without a valid credential:

| Situation | Response |
| --- | --- |
| No account created yet | `401` `{ "error": "Create an account first", "setupRequired": true }` |
| Missing or wrong key | `401` `{ "error": "Login required" }` |
| `GET /ping`, `GET /api/status` | `200`, no credentials needed (`/api/status` returns less; see below) |

To check that a key works, call `GET /api/status` and read `loggedIn` and `via` (`"apikey"` when your key was used).

A few operations are refused when called with an API key and need a signed-in browser session (or the account password):
regenerating the API key, turning the local-network mode on or off, backup download, upload and restore, and the cache
rebuild. They answer `403`. In `openapi.yaml` they carry `x-refused-for-api-key: true`. (`GET /api/settings/apikey`
answers `{ "apiKey": null }` to an API-key caller: the key is only shown to a browser session.) Likewise `POST
/api/system/restore` and `/api/system/backup/restore-upload` always need the account password in the body.

### Browser sessions and CSRF

The web UI signs in with `POST /api/auth/login` and keeps a session cookie (`animearr_session`, `SameSite=Strict`,
30 days). Browser requests that change data must send the header `X-AnimeArr: 1`, and if an `Origin` header is present it
must match the host, otherwise AnimeArr answers `403` "Cross-site request blocked". **Requests authenticated with the
API key are exempt**, so scripts and apps don't need that header. If you are building a web page that runs on another
origin, use the API key from a server-side component rather than a session cookie.

### "No password on my local network"

AnimeArr has an optional setting that lets devices on the home network in without logging in. When it is on, a request
from a private address (`10.0.0.0/8`, `192.168.0.0/16`, IPv6 ULA/link-local, or the networks listed in
`ANIMEARR_LOCAL_NETWORKS`) is accepted without a key, as long as it did not pass through a reverse proxy and addressed
AnimeArr by IP or a LAN name. `via` in `/api/status` then says `"local"`.

Don't build on it: it disappears when someone puts a proxy in front, enables the sign-in requirement, or reaches
AnimeArr by a public name. Always send the key. The iCalendar feed is stricter still: it **always** needs the key.

### Limits

There is no general rate limit. Sign-in and the restore calls slow down repeated wrong attempts per address (`429`).
JSON request bodies are limited to 1 MB; a backup upload may be up to 256 MiB.

## Conventions

- **JSON.** Requests with a body use `Content-Type: application/json`. Responses are JSON, with non-ASCII characters
  escaped (`\uXXXX`), which any JSON parser decodes for you.
- **Errors.** A failed call returns HTTP 400 or above and `{ "error": "plain-English message" }`. The message is written
  for people and is safe to show. Some errors add `detail` (raw technical text) and `fixes` (suggested actions for the web
  UI). Common codes: `400` bad input, `401` not authenticated, `403` refused (API key not allowed, or the show is
  outside the allowed folders), `404` unknown id, `409` conflict or stale state (for example, a grab after the search
  expired), `503` the database failed its integrity check and AnimeArr is read-only (writes fail until a backup is
  restored; reads still work).
- **Ids.** Shows are identified by **`tvdbId`** in URLs (`/api/series/{tvdbId}`) and in most payloads. A show that has
  no TVDB id gets a synthetic one, so treat it as an opaque number. `seriesId` and `id` on a show are internal and
  should not be stored. Episodes have an **episode `id`** (the same number across `/api/series/{tvdbId}`,
  `/api/calendar` as `episodeId`, and `/api/wanted`). Movies have a **movie `id`**. Downloads have a **grab `id`**.
  Adding a title takes an **`anilistId`**, which comes from the add-search results.
- **Times.** Fields such as `at`, `updatedAt`, `airUtc` and `releaseAt` are **milliseconds since the Unix epoch**
  (UTC). The calendar's `from` and `to` parameters are in the same unit. A few values that come straight from a search
  or from Sonarr are ISO 8601 strings: a release's `publishDate`, a show's `nextAiring`.
- **Paging.** Lists that page (`/api/history`, `/api/activity`, `/api/blocklist`) are newest first and take `before=<id>`:
  pass the smallest `id` you have seen to get the next older page.
- **Practice mode (dry-run).** AnimeArr can run in a mode where it decides everything but downloads nothing, either
  globally or per show. Grabs then return `dryRun: true` and appear in Activity as `would-grab`. `GET /api/status`
  has the global switch as `dryRun`.
- **Unknown fields.** Treat objects as open: new fields can appear. Ignore ones you don't know.
- **Case.** Paths are matched case-insensitively.

## Stability

Every operation in `openapi.yaml` has an `x-stability` value.

- **`stable`**: made for integrations. Within 1.x, a documented field of a stable operation will not be removed,
  renamed or change meaning, and a stable operation will not be removed, without a notice in the changelog. Additions
  (new fields, new optional parameters) can happen at any time. Anything not in the schema is not covered.
- **`internal`**: what the web UI needs. It may change shape or disappear in any release, with no notice. You can use
  it for a one-off script, but pin your AnimeArr version and expect to revisit it.

Be aware that **most of the API is internal today.** The stable set is deliberately small (24 operations) and covers the
jobs in [Common tasks](#common-tasks). AnimeArr is still before 1.0, so until 1.0 is released "stable" is a commitment of intent for those operations.
If you need something that is internal, please open an issue describing the use; promoting an operation costs us a
schema and a test, and that is the way it gets added.

The stable operations:

| Area | Operations |
| --- | --- |
| Status and health | `GET /ping`, `GET /api/status`, `GET /api/connections` |
| Library | `GET /api/shows`, `GET /api/series`, `GET /api/series/{tvdbId}`, `GET /api/rootfolders` |
| Add | `GET /api/add/search`, `POST /api/add` |
| Search and grab | `POST /api/autosearch`, `GET /api/autosearch/jobs`, `POST /api/search`, `POST /api/grab` |
| Queue and history | `GET /api/queue`, `GET /api/history`, `POST /api/queue/{id}/remove` |
| Calendar and wanted | `GET /api/calendar`, `GET /feed/calendar/animearr.ics`, `GET /api/wanted` |
| Activity | `GET /api/activity` |
| Blocklist | `GET /api/blocklist`, `DELETE /api/blocklist/{id}` |
| Tags | `GET /api/tags`, `POST /api/tags`, `PUT /api/series/{tvdbId}/tags` |

## Common tasks

All examples assume:

```sh
export ANIMEARR=http://animearr:8484
export KEY=YOUR_API_KEY
alias aa='curl -sS -H "X-Api-Key: $KEY" -H "Content-Type: application/json"'
```

(`jq` is used to pick fields; it is only for the examples.)

### Status, version and health

```sh
aa $ANIMEARR/api/status
```

```json
{
  "version": "0.11.0",
  "setupRequired": false,
  "loggedIn": true,
  "via": "apikey",
  "connected": { "sonarr": true, "radarr": false, "prowlarr": true, "sabnzbd": true, "qbittorrent": false },
  "dryRun": false,
  "managed": 12,
  "librarySeries": 140,
  "queue": { "active": 2, "attention": 0 },
  "warnings": []
}
```

(Abridged. `queue.active` and `queue.attention` are the numbers the web UI shows on its Queue badge: handy for a
single-number widget.)

For real health, ask for the status of each service. This probes your download clients, indexers and media servers, so
it takes a moment (the answer is cached for about 20 seconds; add `?fresh=1` to force a re-check):

```sh
aa $ANIMEARR/api/connections | jq '[.clients[] | select(.configured and .ok == false) | {name, error}]'
```

`ok` is `true`, `false`, or `null` for "not configured". `error` is a plain-English reason. A plain liveness probe that
needs no key is `GET /ping`, which returns `{ "status": "OK" }`.

### List shows

```sh
aa $ANIMEARR/api/shows | jq '.series[] | {tvdbId, title, status, monitored, managed, nextAiring}'
```

This returns every show in one response, sorted by title. `managed` means AnimeArr searches for and grabs the show's
episodes automatically. `cover` is a poster URL.

To search by title (up to 50 hits, matches alternative titles too):

```sh
aa "$ANIMEARR/api/series?q=frieren" | jq
```

### A show with its seasons and episodes

```sh
aa $ANIMEARR/api/series/424536 | jq '{title, seasons: (.episodes | group_by(.season) | map({season: .[0].season, episodes: length, have: (map(select(.hasFile)) | length)}))}'
```

`episodes` has every episode (`id`, `season`, `episode`, `absolute`, `title`, `airUtc`, `hasFile`, `monitored`).
Season `0` holds specials. `rows` is a richer per-episode view: `status` (`have`, `missing`, `downloading`, `unaired`,
`attention`), download `progress`, and the `file` (quality, release group, audio and subtitle languages, size).

### Calendar: what's coming up

```sh
FROM=$(date +%s)000; TO=$(( $(date +%s) + 7*86400 ))000
aa "$ANIMEARR/api/calendar?from=$FROM&to=$TO" | jq '.entries[] | {series, season, episode, airUtc: (.airUtc/1000 | todate), status}'
```

`entries` are episodes, `movies` are movie release dates (`kind` is `cinema`, `digital` or `physical`). Without
parameters you get the last 7 days and the next 14; a range may not exceed 120 days. `status` says whether you already
have it, it is downloading, it is missing, or it has not aired.

### Queue: what's downloading

```sh
aa $ANIMEARR/api/queue | jq '.items[] | {series, episodes, state, progress: (.live.progress // .progress), client: .clientName}'
```

Each item has the show, the episode labels, the release name, the `state` (`sending`, `downloading`, `importing`,
`needs-attention`), and `live`, the download client's own report (`progress` from 0 to 1, `etaSec`, `speed` in bytes per second). For items in `needs-attention`,
`summary` says why in one sentence.

### Recent activity and history

```sh
aa "$ANIMEARR/api/activity?kinds=grab,import,fail" | jq '.[] | {at: (.at/1000 | todate), kind, title, label, summary}'
aa "$ANIMEARR/api/history?state=done" | jq '.[] | {series, episodes, release}'
```

Activity is the decision log: every grab, import, failure and skip, each with a reason (`why`, and a one-line
`summary`). `history` is the list of finished and failed downloads. Pass `before=<id of the oldest item you have>` for
the next page.

### Wanted / missing episodes

```sh
aa $ANIMEARR/api/wanted | jq '{episodes, seasons, shows: [.series[] | {title, missing: (.missing | length)}]}'
```

Lists, per show, the aired and monitored episodes that have no file, and whole seasons with no files. Each missing
episode has the `id` you need for a search.

### Search a show by title and add it

Find the title (AniList plus AnimeArr's own catalog). `inLibrary` is set when you already have it:

```sh
aa "$ANIMEARR/api/add/search?q=sousou%20no%20frieren" | jq '.results[] | {anilistId, title, year, kind, inLibrary}'
```

Pick a root folder. Only the allowed ones are accepted:

```sh
aa $ANIMEARR/api/rootfolders | jq -r '.allowed[]'
```

Add it and start searching for the missing episodes:

```sh
aa -X POST $ANIMEARR/api/add -d '{
  "anilistId": 154587,
  "rootFolder": "/media/anime",
  "then": "search"
}'
```

The response has the new `tvdbId`. `then` is `search` (search the missing aired episodes now), `queue` (put them in the
paced fill-in queue; better for long shows) or `none`. Optional: `profileId` (a language profile), `sizePreset`
(`lean`, `balanced` or `best`), `kind: "movie"`. Practice mode still applies; check `dryRun` in `/api/status`.

### Trigger a search for an episode or a season

AnimeArr's automatic search ranks what the indexers return and grabs the best release that meets the show's language
profile. You pass episode ids; a season is just its episodes' ids.

```sh
# every episode of season 1 that has no file yet
IDS=$(aa $ANIMEARR/api/series/424536 | jq -c '[.episodes[] | select(.season==1 and (.hasFile|not) and .airUtc != null and .airUtc < (now*1000)) | .id]')
aa -X POST $ANIMEARR/api/autosearch -d "{\"tvdbId\": 424536, \"episodeIds\": $IDS}"
```

The answer comes at once: `{ "queued": true, "jobId": "…", "episodes": 3, "position": 0 }`. The search runs in the
background as a job; `episodes` is how many episodes it searches (one already being searched by an earlier call is
skipped), and `position` is how many jobs are waiting ahead of it (0 = it started). Follow it with
`GET /api/autosearch/jobs`:

```sh
aa $ANIMEARR/api/autosearch/jobs | jq '.jobs[] | select(.id == "JOB_ID") | {state, results}'
```

`state` goes `queued` → `running` → `done` (or `failed`, with `error`). When done, `results` lists an outcome per
episode group: `grabbed`, `would-grab` (practice mode), `needs-look`, `skipped` or `failed`, each with a `why`. Up to 26
episodes are searched per call; for more, the rest are handed to the scheduled searches and the job says so in
`queued`. Each job also leaves a line in `/api/activity`, and a grab shows up in `/api/queue`. Jobs are kept in memory:
a restart drops the ones not finished yet (Activity notes it). Poll every few seconds at most; finished jobs stay
listed for an hour.

### Interactive search, then grab a specific release

This is the "pick a version" flow. It runs in two steps; both must use the same `tvdbId` and `episodeIds`.

```sh
# 1. search (blocks until the indexers have answered; several seconds, sometimes up to a minute)
aa -X POST $ANIMEARR/api/search -d '{"tvdbId": 424536, "episodeIds": [111, 112]}' > search.json

jq -r '.results[] | "\(.rank.accept)\t\(.rank.score)\t\(.protocol)\t\(.label)\t\(.title)\n    \(.rank.why)"' search.json | head -20
```

Each result has a `guid`, the release `title`, `size`, `protocol`, `seeders`, the `indexer`, the episodes it covers
(`episodeIds`, `label`, `coversTarget`) and how AnimeArr judged it in `rank`:

| Field | Meaning |
| --- | --- |
| `rank.accept` | AnimeArr would grab it on its own. |
| `rank.score` | Higher is better; compare within one search only. |
| `rank.langProb` | 0 to 1: how likely the release meets the language profile. |
| `rank.why` | A sentence explaining the verdict. |
| `rank.reject` | When not acceptable, why. |
| `rank.flags[]` | Chips: `{ key, label, tone }` with tone `good`, `warn`, `bad` or `info` (burned-in subs, trusted group, and so on). |
| `confidence` | 0 to 100: how sure AnimeArr is the release maps to those episodes. |

Pick one and grab it:

```sh
GUID=$(jq -r '.results[] | select(.rank.accept) | .guid' search.json | head -1)
aa -X POST $ANIMEARR/api/grab -d "{\"tvdbId\": 424536, \"episodeIds\": [111, 112], \"guid\": \"$GUID\", \"confirm\": true}"
```

`confirm` must be `true`. The server remembers the search's results for 30 minutes; a grab after that, or with a
different `episodeIds` list, answers `409` "Search again first". Download links are never returned to the client: the
grab uses the server's copy. The other acceptable results become fallbacks if the chosen download fails.

### Blocklist

```sh
aa $ANIMEARR/api/blocklist | jq '.items[] | {id, title, release, reason}'
```

Remove an entry so the release can be picked again:

```sh
aa -X DELETE $ANIMEARR/api/blocklist/57
```

A release is blocklisted when a download fails, fails verification, or you remove it from the queue with
`blocklist: true`:

```sh
aa -X POST $ANIMEARR/api/queue/301/remove -d '{"blocklist": true, "searchNext": true, "confirm": true}'
```

(`301` is the download's `id` from `/api/queue`. `searchNext` makes AnimeArr try the next-best release.)

### Tags

```sh
aa $ANIMEARR/api/tags | jq
aa -X POST $ANIMEARR/api/tags -d '{"label": "airing"}'
aa -X PUT  $ANIMEARR/api/series/424536/tags -d '{"tags": [3, 5]}'    # replaces the show's tags
```

Tag ids are small integers. `PUT .../tags` sets the complete list, so read the show's `tags` first if you want to add to
it. Tags also filter the iCal feed.

### The iCalendar feed

Subscribe a calendar app to:

```
http://animearr:8484/feed/calendar/animearr.ics?apikey=YOUR_API_KEY
```

Episodes appear at their air time (length from the show's runtime, 24 minutes if unknown); anime movies as all-day events.
Optional parameters: `pastDays` (default 7), `futureDays` (default 28), `unmonitored=true`, and `tags=3,5` to limit it to
shows and movies with one of those tags. The feed always requires the key (calendar apps cannot log in), whatever the
local-network setting.

## Endpoint index

The full schema of every operation is in [openapi.yaml](openapi.yaml). `*` marks a **stable** operation; everything else
is internal and can change. (This list is generated from the OpenAPI file.)

### System

| | Operation | What it does |
| --- | --- | --- |
| * | `GET /ping` | Liveness check |
| * | `GET /api/status` | Version, auth state and a library/queue summary |
| * | `GET /api/connections` | Health of clients, indexers and services |
|  | `GET /api/system` | Version, uptime, background jobs, database state, backups |
|  | `GET /api/system/logs` | Recent log lines (secrets scrubbed) |
|  | `GET /api/system/logs/download` | Download the log as text |
|  | `POST /api/system/metadata` | Refresh metadata sources now |
|  | `GET /api/system/updates` | Newest release on GitHub |
|  | `POST /api/system/backup` | Create a backup now |
|  | `POST /api/system/restore` | Restore a backup by name (session or password only) |
|  | `GET /api/system/backup/download` | Download a whole backup (database + secret key) (a logged-in session only; the home-network bypass isn't enough) |
|  | `POST /api/system/backup/download` | The same, with `{ password }` (what the UI sends; never with the API key) |
|  | `POST /api/system/backup/upload` | Stage an uploaded backup for restore (session or password only) |
|  | `POST /api/system/backup/restore-upload` | Restore a staged backup (session or password only) |
|  | `POST /api/system/cache/reset` | Rebuild the library cache from Sonarr (session or password only) |
|  | `GET /api/img` | Poster thumbnail proxy |
|  | `GET /api/phone` | Addresses a phone on the network can use |
|  | `GET /api/catalog` | Status of the local anime catalog |
|  | `POST /api/catalog/refresh` | Refresh the anime catalog |
|  | `GET /api/catalog/indexers` | Built-in indexer catalog |
|  | `GET /api/anidb` | AniDB lookup status |
|  | `GET /api/repair/recent` | Recent after-import checks |
|  | `POST /api/repair/run` | Run the after-import check now |

### Auth

| | Operation | What it does |
| --- | --- | --- |
|  | `POST /api/auth/login` | Sign in and get a session cookie |
|  | `POST /api/auth/logout` | Clear the session cookie |
|  | `PUT /api/auth/account` | Change username and password |
|  | `PUT /api/auth/mode` | Turn the local-network no-password mode on or off (session or password only) |

### Settings

| | Operation | What it does |
| --- | --- | --- |
|  | `GET /api/settings` | All settings (secrets masked) |
|  | `PUT /api/settings` | Update settings |
|  | `GET /api/settings/apikey` | Read the API key |
|  | `POST /api/settings/apikey/regenerate` | Make a new API key (session or password only) |
|  | `POST /api/test/{service}` | Test a service connection with unsaved values |
|  | `POST /api/test/tmdb` | Test a TMDB key |
|  | `GET /api/wizard` | First-run wizard state |
|  | `PUT /api/wizard` | Save wizard progress |
|  | `GET /api/wizard/arr-preview` | Preview of what Sonarr/Radarr clients could be reused |
|  | `POST /api/wizard/arr-apply` | Apply the Sonarr/Radarr preview |
|  | `POST /api/wizard/category` | Create a download-client category |
|  | `GET /api/fs/folders` | Browse folders on the server |

### Library

| | Operation | What it does |
| --- | --- | --- |
| * | `GET /api/rootfolders` | Root folders and which are allowed |
| * | `GET /api/shows` | List every show in the library |
| * | `GET /api/series` | Search library shows by title |
| * | `GET /api/series/{tvdbId}` | One show with its seasons and episodes |
|  | `POST /api/library/sync` | Sync the library from Sonarr now |
|  | `GET /api/library/tags` | Sonarr's tag names (read-only) |
|  | `PUT /api/series/{tvdbId}/prefs` | Set a show's language profile, watch mode, size preset |
|  | `POST /api/series/{tvdbId}/drop` | Mark a show dropped (never grabbed again) |
|  | `DELETE /api/series/{tvdbId}/drop` | Un-drop a show |
|  | `GET /api/dropped` | Dropped shows |
|  | `POST /api/series/{tvdbId}/scan` | Rescan a show's folder |
|  | `GET /api/series/{tvdbId}/scope` | What a show's search scope would cover |
|  | `PUT /api/scope` | Set the search scope of shows |
|  | `GET /api/series/{tvdbId}/quality` | Quality details of a show's files |
|  | `POST /api/series/{tvdbId}/seadex/check` | Compare a show against SeaDex |
|  | `POST /api/series/{tvdbId}/upgrade-season` | Upgrade a season's files |
|  | `PUT /api/series/{tvdbId}/keep` | Keep a show's files as they are |
|  | `GET /api/series/{tvdbId}/catalog` | AniList catalog entries behind a show |
|  | `GET /api/series/{tvdbId}/anidb` | AniDB entries and their placement |
|  | `POST /api/series/{tvdbId}/anidb/fetch` | Fetch AniDB data for a show |
|  | `PUT /api/series/{tvdbId}/anidb/override` | Place an AniDB entry on a season |
|  | `GET /api/series/{tvdbId}/replace-season` | Preview replacing a season |
|  | `GET /api/series/{tvdbId}/rename` | Preview renaming a show's files |
|  | `POST /api/series/{tvdbId}/rename` | Rename a show's files |
|  | `POST /api/series/{tvdbId}/mediaout` | Write NFO/.plexmatch/artwork for a show |
|  | `GET /api/episodes/{id}` | One episode with its file and history |
|  | `POST /api/episodes/delete` | Delete episode files |
|  | `POST /api/episodes/regrab` | Delete and re-download episodes |
|  | `POST /api/episodes/search-soon` | Queue episodes for the next scheduled search |
|  | `PUT /api/franchise/link` | Link or unlink a movie to a show's franchise |

### Movies

| | Operation | What it does |
| --- | --- | --- |
|  | `GET /api/movies` | List anime movies |
|  | `GET /api/movies/{id}` | One movie with its file and history |
|  | `GET /api/movies-search` | Movie search summary |
|  | `PUT /api/movies/{id}/prefs` | Set a movie's language profile |
|  | `PUT /api/movies/{id}/tags` | Set a movie's tags |
|  | `POST /api/movies/wanted` | Mark movies wanted or not |
|  | `POST /api/movies/{id}/autosearch` | Search for a movie and grab the best release (a background job, like `POST /api/autosearch`) |
|  | `POST /api/movies/{id}/search` | Interactive search for a movie |
|  | `POST /api/movies/{id}/grab` | Grab a release from the last movie search |
|  | `POST /api/movies/{id}/scan` | Rescan a movie's file |

### Add

| | Operation | What it does |
| --- | --- | --- |
| * | `GET /api/add/search` | Search AniList and the local catalog for something to add |
|  | `GET /api/add/season` | This season's airing anime |
| * | `POST /api/add` | Add a show or movie |
|  | `DELETE /api/add/{tvdbId}` | Remove a show from AnimeArr |
|  | `DELETE /api/add/movie/{movieId}` | Remove a movie from AnimeArr |
|  | `GET /api/import/folders` | Show folders found under a root folder |
|  | `POST /api/import/match` | Match a folder name to an AniList entry |
|  | `POST /api/import/adopt` | Adopt an existing folder as a show |

### Search

| | Operation | What it does |
| --- | --- | --- |
| * | `POST /api/autosearch` | Search for episodes and grab the best release automatically (answers at once; runs as a job) |
| * | `GET /api/autosearch/jobs` | Automatic-search jobs: running, waiting and finished in the last hour, with each episode's outcome |
| * | `POST /api/search` | Interactive search: list releases with scores and reasons |
|  | `POST /api/search/start` | Start an interactive search as a job |
|  | `GET /api/search/job/{id}` | Progress and results of a search job |
| * | `POST /api/grab` | Grab one release from the last interactive search |
|  | `POST /api/identify` | Work out which show and episode a release name is |
|  | `GET /api/grabs` | Latest 100 grabs (raw rows) |
|  | `POST /api/grabs/{id}/keep` | Stop auto-removing a stalled download |
|  | `POST /api/grabs/{id}/next` | Skip to the next candidate release |
|  | `POST /api/grabs/{id}/retry` | Retry a failed grab |

### Queue

| | Operation | What it does |
| --- | --- | --- |
| * | `GET /api/queue` | What is downloading now |
| * | `GET /api/history` | Finished and failed grabs |
| * | `POST /api/queue/{id}/remove` | Remove a download from the queue, optionally blocklisting it |
|  | `GET /api/queue/sonarr` | Problems in Sonarr's own queue |
|  | `POST /api/queue/sonarr/{id}/remove` | Remove an item from Sonarr's queue |

### Calendar

| | Operation | What it does |
| --- | --- | --- |
| * | `GET /api/calendar` | Episodes and movies by air/release date |
| * | `GET /feed/calendar/animearr.ics` | iCalendar feed of upcoming episodes and movies |

### Wanted

| | Operation | What it does |
| --- | --- | --- |
| * | `GET /api/wanted` | Missing episodes and missing seasons |
|  | `GET /api/backlog` | Backlog search status |
|  | `GET /api/home` | The Home page summary |

### Activity

| | Operation | What it does |
| --- | --- | --- |
| * | `GET /api/activity` | Recent decisions and events |
|  | `POST /api/activity/{id}/undo` | Undo an activity entry |
|  | `GET /api/notifications` | The notification bell |
|  | `POST /api/notifications/read` | Mark notifications read |
|  | `POST /api/notifications/test` | Send a test notification |
|  | `GET /api/upgrades` | Pending dual-audio upgrades |

### Blocklist

| | Operation | What it does |
| --- | --- | --- |
| * | `GET /api/blocklist` | Releases AnimeArr will not grab again |
| * | `DELETE /api/blocklist/{id}` | Remove one release from the blocklist |
|  | `POST /api/blocklist/remove` | Remove several blocklist entries |

### Tags

| | Operation | What it does |
| --- | --- | --- |
| * | `GET /api/tags` | List tags |
| * | `POST /api/tags` | Create a tag |
|  | `PUT /api/tags/{id}` | Rename a tag |
|  | `DELETE /api/tags/{id}` | Delete a tag |
| * | `PUT /api/series/{tvdbId}/tags` | Set a show's tags |
|  | `POST /api/tags/bulk` | Add and remove tags on many shows or movies |
|  | `GET /api/release-rules` | List release rules |
|  | `POST /api/release-rules` | Create a release rule |
|  | `PUT /api/release-rules/{id}` | Update a release rule |
|  | `DELETE /api/release-rules/{id}` | Delete a release rule |
|  | `POST /api/release-rules/test` | Which rules match a sample release name |

### Profiles

| | Operation | What it does |
| --- | --- | --- |
|  | `GET /api/profiles` | List language profiles |
|  | `POST /api/profiles` | Create a language profile |
|  | `PUT /api/profiles/{id}` | Update a language profile |
|  | `DELETE /api/profiles/{id}` | Delete a language profile |
|  | `GET /api/quality/goal` | Quality goal of the default profile |
|  | `PUT /api/quality/goal` | Set the quality goal |
|  | `GET /api/quality/upgrades` | Quality-upgrade watcher status |
|  | `PUT /api/quality/upgrades` | Pause or configure quality upgrades |
|  | `POST /api/quality/upgrades/start` | Start quality upgrades |

### Managed shows

| | Operation | What it does |
| --- | --- | --- |
|  | `GET /api/managed` | Managed shows with their search schedule |
|  | `POST /api/managed` | Start or stop managing shows |
|  | `POST /api/managed/preview` | Preview what managing shows would do |
|  | `PUT /api/managed/{tvdbId}` | Set one show's practice mode |
|  | `POST /api/managed/{tvdbId}/sonarr-monitor` | Monitor or unmonitor the show in Sonarr |
|  | `POST /api/managed/run` | Run the automatic search round now |
|  | `GET /api/fillin` | The paced fill-in queue |
|  | `POST /api/fillin` | Add shows to the fill-in queue |
|  | `PUT /api/fillin/{tvdbId}` | Pause, resume or remove a fill-in entry |

### Audit

| | Operation | What it does |
| --- | --- | --- |
|  | `GET /api/audit/language` | Files without the profile's language |
|  | `GET /api/audit/duplicates` | Episodes listed under two shows |
|  | `GET /api/audit/specials` | Specials and extras |
|  | `POST /api/facts` | Record a fact about a show (e.g. burned-in subs) |
|  | `DELETE /api/facts/{id}` | Delete a fact |
|  | `POST /api/aliases` | Add an alternative title to a show |
|  | `DELETE /api/aliases/{id}` | Delete an alias |
|  | `POST /api/rules` | Add a numbering rule for a release group |
|  | `DELETE /api/rules/{id}` | Delete a numbering rule |
|  | `GET /api/files/summary` | File scan summary |
|  | `POST /api/files/scan` | Scan library files now |
|  | `GET /api/files/detail` | Streams and tracks of one file |
|  | `GET /api/files/peek` | Preview frames of one file |
|  | `POST /api/files/rescan` | Rescan one file |
|  | `POST /api/files/track` | Set the language of an audio/subtitle track |
|  | `POST /api/files/sidecar` | Use a sidecar subtitle file |
|  | `GET /api/watch` | Deep links to watch a file in a media server |

### Import

| | Operation | What it does |
| --- | --- | --- |
|  | `POST /api/import/plan` | Plan importing a finished download |
|  | `POST /api/import/run` | Import a finished download |
|  | `GET /api/import/browse` | Browse a download folder |
|  | `POST /api/import/movie-plan` | Plan importing a movie |
|  | `POST /api/import/movie-run` | Import a movie |
|  | `GET /api/media/rename-all` | Preview renaming the whole library |
|  | `GET /api/media/status` | Importer engine settings |
|  | `PUT /api/media/importer` | Change the importer engine and its limits |
|  | `POST /api/media/import-defaults` | Copy naming defaults from Sonarr |
|  | `POST /api/media/preview` | Preview a naming format |
|  | `GET /api/mediaout` | Media-server file sync status |
|  | `POST /api/mediaout/sync` | Write NFO/.plexmatch/artwork for every show |

### Downloads

| | Operation | What it does |
| --- | --- | --- |
|  | `GET /api/downloads/status` | Free-space and seeding rules status |
|  | `POST /api/downloads/cleanup/plan` | Plan cleaning finished downloads |
|  | `POST /api/downloads/cleanup/run` | Clean finished downloads |
|  | `PUT /api/downloads/allow-delete` | Allow AnimeArr to delete finished downloads |
|  | `POST /api/downloads/rules/disable` | Switch off a folder rule |
|  | `GET /api/recycle` | Recycle-bin status |
|  | `GET /api/recycle/animearr` | AnimeArr's own recycle bin |
|  | `POST /api/recycle/animearr/empty` | Empty AnimeArr's recycle bin (pinned files stay) |
|  | `POST /api/recycle/animearr/unpin` | `{ path }`: release a file pinned after an import couldn't put it back |
|  | `GET /api/recycle/setting` | Recycle-bin setting |

### Indexers & clients

| | Operation | What it does |
| --- | --- | --- |
|  | `GET /api/indexers` | Direct indexers |
|  | `POST /api/indexers` | Add a direct indexer |
|  | `PUT /api/indexers/{id}` | Update a direct indexer |
|  | `DELETE /api/indexers/{id}` | Delete a direct indexer |
|  | `POST /api/indexers/test` | Test an indexer |
|  | `POST /api/indexers/prowlarr/{id}/use` | Use or skip a Prowlarr indexer |
|  | `GET /api/indexers/breaker` | Indexer circuit-breaker state |
|  | `POST /api/indexers/breaker/{id}` | Test, re-enable or keep an indexer off |
|  | `POST /api/jackett/trackers` | List a Jackett instance's trackers |
|  | `POST /api/jackett/add` | Add a Jackett tracker as an indexer |
|  | `GET /api/clients` | Extra download clients |
|  | `POST /api/clients` | Add a download client |
|  | `PUT /api/clients/{id}` | Update a download client |
|  | `DELETE /api/clients/{id}` | Delete a download client |
|  | `PUT /api/clients/{id}/prefs` | Set a client's priority and on/off |
|  | `POST /api/clients/test` | Test a download client |

### Notification channels

| | Operation | What it does |
| --- | --- | --- |
|  | `GET /api/notify/channels` | List notification channels |
|  | `PUT /api/notify/channels` | Replace the notification channels |
|  | `POST /api/notify/channels/{id}/test` | Send a test through one channel |

### Import lists

| | Operation | What it does |
| --- | --- | --- |
|  | `GET /api/import-lists` | List import lists and exclusions |
|  | `POST /api/import-lists` | Create an import list |
|  | `PUT /api/import-lists/{id}` | Update an import list |
|  | `DELETE /api/import-lists/{id}` | Delete an import list |
|  | `POST /api/import-lists/test` | Preview what a list would add (unsaved) |
|  | `POST /api/import-lists/{id}/sync` | Sync one list now |
|  | `POST /api/import-lists/sync` | Sync every enabled list now |
|  | `POST /api/import-lists/exclusions` | Exclude a title from import lists |
|  | `DELETE /api/import-lists/exclusions/{anilistId}` | Remove an exclusion |

### Migration

| | Operation | What it does |
| --- | --- | --- |
|  | `GET /api/cutover` | Plan for moving shows off Sonarr |
|  | `POST /api/cutover/adopt` | Adopt shows into AnimeArr |
|  | `POST /api/cutover/remove` | Remove shows from Sonarr/Radarr |
|  | `POST /api/cutover/match-show` | Match a show to an AniList entry |
|  | `POST /api/cutover/match-movie` | Match a movie to an AniList entry |
|  | `POST /api/cutover/match-movies` | Match all movies automatically |
|  | `POST /api/cutover/unmatch` | Remove a match |
|  | `POST /api/cutover/ack-specials` | Acknowledge a show's specials |
|  | `PUT /api/cutover/allow` | Allow AnimeArr to write to Sonarr/Radarr |

## Sonarr-compatible layer

AnimeArr also answers a subset of Sonarr's v3 API under `/api/v3`. It exists so that **request apps (Jellyseerr,
Overseerr)** can add shows to AnimeArr as if it were a Sonarr server; see the README for how to set that up. It
authenticates the same way (API key), reports itself as a Sonarr 4 server named AnimeArr, and matches paths regardless
of case.

Other tools that speak Sonarr's API may work with it, but that is **not supported or tested**, and AnimeArr does not
promise to behave exactly like Sonarr. If you are writing a new integration, use AnimeArr's own API above. For the
request and response shapes of this layer, see [Sonarr's API documentation](https://sonarr.tv/docs/api/); it is not
documented here.

Endpoints present (all under `/api/v3`):

| Area | Endpoints |
| --- | --- |
| System | `GET system/status`, `GET health`, `GET diskspace` |
| Profiles and folders | `GET qualityprofile`, `GET qualityprofile/{id}`, `GET languageprofile`, `GET language`, `GET language/{id}`, `GET rootfolder`, `GET qualitydefinition` |
| Tags | `GET tag`, `GET tag/{id}`, `POST tag`, `PUT tag/{id}`, `DELETE tag/{id}` |
| Series | `GET series` (`?tvdbId=`), `GET series/lookup`, `GET series/{id}`, `POST series`, `PUT series`, `PUT series/{id}`, `PUT series/editor` (bulk monitored / quality profile / tags; `deleteFiles`, `moveFiles` and a different `rootFolderPath` are refused), `DELETE series/{id}` |
| Episodes | `GET episode`, `GET episode/{id}`, `PUT episode/monitor` |
| Files | `GET episodefile`, `GET episodefile/{id}` (deleting a file is refused with 405), `GET mediacover/{id}/{file}` |
| Commands | `POST command`, `GET command`, `GET command/{id}` (supports `SeriesSearch`, `MissingEpisodeSearch`, `SeasonSearch`, `EpisodeSearch`, `RescanSeries`, `RefreshSeries`, `RssSync`, `Backup`; others are refused) |
| Calendar | `GET calendar`, `GET calendar/{id}` |
| Queue | `GET queue`, `GET queue/details`, `GET queue/status`, `DELETE queue/{id}`, `DELETE queue/bulk` |
| History | `GET history`, `GET history/since`, `GET history/series`, `POST history/failed/{id}` |
| Wanted | `GET wanted/missing`, `GET wanted/cutoff` |
| Releases | `GET release` (interactive search for an episode), `POST release` (grab one) |

Query parameter names are matched in any case, as Sonarr does (`seriesId`, `seriesID` and `SERIESID` are the same).

There is no Radarr-side API (so movie requests are not possible).

## Building a dashboard widget

A Homepage-style widget polls a few cheap endpoints and shows numbers. A reasonable set, all stable:

| Widget field | Source |
| --- | --- |
| Is it up, which version | `GET /api/status`: `version`, `loggedIn` (use `/ping` if you have no key) |
| Downloading now / needs attention | `GET /api/status`: `queue.active`, `queue.attention` |
| Shows in library / managed | `GET /api/status`: `librarySeries`, `managed` |
| Currently downloading (list, progress) | `GET /api/queue`: `items[].series`, `episodes`, `live.progress` |
| Airing today and this week | `GET /api/calendar?from=<ms>&to=<ms>`: `entries[]` |
| Missing episodes | `GET /api/wanted`: `episodes`, `seasons` |
| Recently grabbed or imported | `GET /api/activity?kinds=grab,import`: first few entries |
| Failed downloads | `GET /api/history?state=failed` |
| Service problems | `GET /api/connections`: clients/indexers with `ok: false` |
| Practice mode on | `GET /api/status`: `dryRun` |

Poll no faster than every 30 seconds to 1 minute. `/api/status` is cheap. `/api/queue` asks the download client for live
progress (up to 4 seconds if the client is slow), `/api/wanted` walks the whole library, and `/api/connections` makes
live calls to your services, so keep those slower (a minute or more). Poster images: `cover` URLs are either a full image
URL or can be passed through `GET /api/img?u=<url>&s=md`, which serves a cached thumbnail (send your key there too).

If you need a field these endpoints don't return, say so in an issue rather than scraping an internal endpoint.

### Older endpoint names

`/api/sonarr/rootfolders`, `/api/library/candidates` and `/api/audit/gaps` answer exactly like `/api/rootfolders`,
`/api/shows` and `/api/wanted`. AnimeArr's own pages still use them, but they aren't part of the stable set: use the
new names.
