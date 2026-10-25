# AnimeArr – Codebase Study of Sonarr (and Radarr)

**Method.** I made shallow clones on 2026-10-25 and read the files directly. Every path below was opened or grepped, except where a line is marked *(unverified)*.

- **Sonarr `develop`** @ `465b519` (2026-10-24). This branch is now **v5**: `.github/workflows/build_v5.yml` sets `SONARR_MAJOR_VERSION: 5`, and it adds the `src/Sonarr.Api.V5/` project.
- **Sonarr `main`** @ `bc54afb`. This is the current **v4 stable** (`SONARR_MAJOR_VERSION: 4`). I compared it with develop where they differ.
- **Radarr `develop`** @ 2026-10-25.
- **Prowlarr**: read through the GitHub API, only for the Sonarr sync code.

Unless stated otherwise, paths are relative to `src/` in the Sonarr repo.

> **Fork-base decision up front:** `main` (v4) is stable but frozen. `develop` (v5) already includes several anime-relevant changes: `Series.SeasonType`/`SeasonTypes` (alternate TVDB orderings), multi-season packs (`ParsedEpisodeInfo.SeasonNumbers` is a list), and `Series.MalIds`/`AniListIds` (these exist in v4 too). Forking develop gets you those, but you'll be tracking a moving target.

---

## 1. Architecture overview

| Layer | Location | Notes |
|---|---|---|
| Core domain/services | `NzbDrone.Core/` (assembly `Sonarr.Core.csproj`) | Everything: `Tv/`, `Parser/`, `DecisionEngine/`, `IndexerSearch/`, `Indexers/`, `Download/`, `MediaFiles/`, `Extras/`, `DataAugmentation/`, `MetadataSource/`, `CustomFormats/`, `Profiles/`, `Notifications/`, `Jobs/`, `Messaging/`, `Datastore/` |
| Shared infra | `NzbDrone.Common/` | HTTP client, disk, caching, `Composition/` (DI), `Cloud/SonarrCloudRequestBuilder.cs` |
| REST API | `Sonarr.Api.V3/` (and `Sonarr.Api.V5/` on develop), `Sonarr.Http/` | Controllers per area (`Series/`, `Episodes/`, `Indexers/`, `ManualImport/`, `Parse/`, …) |
| Host | `NzbDrone.Host/Bootstrap.cs`, `Startup.cs` | ASP.NET Core host. `NzbDrone.SignalR/` pushes live updates to the UI |
| Platform shims | `NzbDrone.Windows/`, `NzbDrone.Mono/`, `NzbDrone.Update/`, `NzbDrone.Console/` | |
| Frontend | repo-root `frontend/src/` | React 18.3.1, TypeScript 5.9, Vite 8, `@tanstack/react-query` 5, `zustand` 5, react-router 7. Feature folders: `Series/`, `Episode/`, `InteractiveImport/`, `InteractiveSearch/`, `Settings/`, `Parse/` … |

- **DI.** DryIoc, wired in `NzbDrone.Host/Bootstrap.cs` with `new DryIocServiceProviderFactory(new Container(rules => rules.WithNzbDroneRules()))` and `c.AutoAddServices(ASSEMBLIES)`. `NzbDrone.Common/Composition/Extensions.cs` `AutoAddServices` registers **every interface implementation as a Singleton** and concrete types as Transient (`RegisterMany`).
  - Consequence for a fork: you add a feature by **dropping in a class that implements a known interface**. Examples: `IDownloadDecisionEngineSpecification`, `IImportDecisionEngineSpecification`, `ISceneMappingProvider`, `IHandle<TEvent>`, `IExecute<TCommand>`. Consumers get them through `IEnumerable<T>`. No registration code is needed.
- **Database.** Dapper + FluentMigrator, with SQLite and Postgres runners (`Sonarr.Core.csproj` references `FluentMigrator.Runner.SQLite`/`.Postgres`, `Npgsql`, `Dapper`).
  - Key files: `Datastore/DbFactory.cs`, `Datastore/TableMapping.cs` (entity → table, e.g. `Mapper.Entity<SceneMapping>("SceneMappings")`), `Datastore/BasicRepository.cs`.
  - Migrations: `Datastore/Migration/NNN_*.cs`, 231 files, the latest being `237_pending_releases_season_numbers.cs`.
  - Embedded objects (e.g. `Season`, `SeasonType`, `MediaInfoSubtitleStreamModel`) implement `IEmbeddedDocument` and are stored as JSON columns.
- **Messaging, commands and jobs.**
  - `Messaging/Events` uses `IEventAggregator` with `IHandle<T>`/`IHandleAsync<T>`.
  - `Messaging/Commands` contains `Command`, `IExecute<TCommand>`, `CommandQueueManager`, `CommandExecutor`.
  - Scheduled jobs are a hard-coded list of `ScheduledTask { TypeName = typeof(XCommand).FullName, Interval }` in `Jobs/TaskManager.cs`. That list includes `RssSyncCommand`, `RefreshSeriesCommand`, `UpdateSceneMappingCommand`, `HousekeepingCommand`, `ImportListSyncCommand` and `BackupCommand`. `Jobs/Scheduler.cs` fires them.
- **TV model** (`Tv/`):
  - `Series : ModelBase` holds `TvdbId` (the *de facto* primary external key), `TvRageId`, `TvMazeId`, `ImdbId`, `TmdbId`, `HashSet<int> MalIds`, `HashSet<int> AniListIds`, `SeriesType` (`SeriesTypes { Standard, Daily, Anime }`), `UseSceneNumbering`, `List<Season> Seasons` (embedded), `SeasonType` (string; `"official"` by default) plus `List<SeasonType> SeasonTypes` *(develop only)*, `Translations`, `OriginalTitle`/`CleanOriginalTitle`.
  - `Season : IEmbeddedDocument` holds `SeasonNumber`, `Monitored`, `Title`, `Images`. It is **not its own table**.
  - `Episode : ModelBase` (table Episodes) holds `SeriesId`, `TvdbId`, `SeasonNumber`, `EpisodeNumber`, `AbsoluteEpisodeNumber?`, `SceneAbsoluteEpisodeNumber?`, `SceneSeasonNumber?`, `SceneEpisodeNumber?`, `AiredAfterSeasonNumber?`, `AiredBeforeSeasonNumber?`, `AiredBeforeEpisodeNumber?`, `UnverifiedSceneNumbering`, `EpisodeFileId`, `FinaleType`.
  - Episode files: `MediaFiles/EpisodeFile.cs`. One file can cover several episodes.

## 2. Metadata (SkyHook)

- **Interfaces.** `MetadataSource/IProvideSeriesInfo.cs` declares `Tuple<Series, List<Episode>> GetSeriesInfo(int tvdbSeriesId, Language language, string seasonType)`. `MetadataSource/ISearchForNewSeries.cs` covers search by title, IMDb, **AniList**, TMDb and **MAL** ID.
- **Only implementation:** `MetadataSource/SkyHook/SkyHookProxy.cs`.
  - It calls `https://skyhook.sonarr.tv/v2/tvdb/{route}/` (`NzbDrone.Common/Cloud/SonarrCloudRequestBuilder.cs`, property `SkyHookTvdb`) with `shows/{lang3}/{tvdbId}/{seasonType}`.
  - Search terms are `tvdb:`, `imdb:`, `anilist:`, `mal:` and `tmdb:`, all resolved **server-side** by Sonarr's proxy.
  - DTOs live in `MetadataSource/SkyHook/Resource/` (`ShowResource`, `EpisodeResource`, `SeasonResource`, `SeasonTypeResource`, …).
- **Callers:** `Tv/AddSeriesService.cs` and `Tv/RefreshSeriesService.cs` (line ~69: `_seriesInfo.GetSeriesInfo(series.TvdbId, series.Language, series.SeasonType)`). `Tv/RefreshEpisodeService.cs` merges the returned episodes into the DB, keyed on `Episode.TvdbId`.
- **Swap difficulty.**
  - The *interface* is easy to replace: write an `AniDbProxy : IProvideSeriesInfo, ISearchForNewSeries`, and DI picks it up if you delete or replace `SkyHookProxy`.
  - The problem is that the **ID is hard-coded as a TVDB int**. `TvdbId` appears **232 times in 79 files in NzbDrone.Core**. It is the key for scene mappings (`SceneMapping.TvdbId`), XEM, Newznab `&tvdbid=` searches, episode refresh matching (`Episode.TvdbId`), import-list exclusions, the API and the frontend.
  - **Options, cheapest first:**
    - (a) Keep TVDB as the spine and *enrich* episodes and titles from AniDB/AniList, e.g. a custom proxy that serves SkyHook-shaped JSON. You can point `SkyHookTvdb` at your own server, and Sonarr's code barely changes.
    - (b) Treat `TvdbId` as "provider series id" with a provider discriminator. This is a large refactor.
  - AniDB also has strict API rate limits and bans *(general knowledge, unverified here)*, so a caching proxy is advisable either way.

## 3. Scene mapping, XEM and alternate titles

**Files:** `DataAugmentation/Scene/` (`SceneMapping.cs`, `SceneMappingService.cs`, `ISceneMappingProvider.cs`, `ServicesProvider.cs`, `SceneMappingProxy.cs`, `SceneMappingRepository.cs`, `UpdateSceneMappingCommand.cs`) and `DataAugmentation/Xem/` (`XemService.cs`, `XemProxy.cs`).

- **`SceneMapping`** (DB table `SceneMappings`) has these fields: `MappingId`, `Title`, `ParseTerm` (cleaned title), `SearchTerm`, `TvdbId`, `SeasonNumber?` (TVDB season), `SceneSeasonNumber?`, `SceneOrigin` (e.g. `tvdb`, `mixed`, `unknown`), `SearchMode` (flags: `SearchID`, `SearchTitle`), `Comment`, `FilterRegex`, `Type` (provider class name).
- **Providers** implement `ISceneMappingProvider.GetSceneMappings()`. There are two:
  - `ServicesProvider` → `SceneMappingProxy` → `https://services.sonarr.tv/v1/scenemapping`. This is the curated list Sonarr's team maintains. *(Unverified: it is curated centrally, users request entries via the Sonarr team.)*
  - `XemService` (also an `ISceneMappingProvider`) → `XemProxy` → `https://thexem.info/map/allNames` for names, `/all?id=` for numbering, `/havemap` for the list of mapped IDs.
- **`SceneMappingService.UpdateMappings()`** loops through every injected provider. For each one it diffs by `MappingId` against `_repository.GetAllByType(providerType)`, then `DeleteMany`/`UpdateMany`/`InsertMany`. It then rebuilds two caches: `ParseTerm → mappings` and `TvdbId → mappings`.
- **XEM numbering.** `XemService.PerformUpdate(series)` runs on `SeriesUpdatedEvent`. It writes `Episode.SceneSeasonNumber/SceneEpisodeNumber/SceneAbsoluteEpisodeNumber`, extrapolates unmapped episodes (`UnverifiedSceneNumbering`), and sets `Series.UseSceneNumbering`. It is **skipped if `series.SeasonType != "official"`**.
- **Alternate titles in the API.** `Sonarr.Api.V3/Series/AlternateTitleResource.cs` maps `SceneMapping` to read-only `alternateTitles` on `SeriesResource`. There is no POST, PUT or DELETE controller.
- **Release title to series and episodes** (`Parser/ParsingService.cs`):
  1. `Parser.ParseTitle(title)`, a static regex pass, produces `ParsedEpisodeInfo` (`SeriesTitle`, `SeasonNumbers`, `EpisodeNumbers`, `AbsoluteEpisodeNumbers`, `Special`, `FullSeason`, …).
  2. `Map(...)` calls `_sceneMappingService.FindSceneMapping(SeriesTitle, ReleaseTitle, season)`. This does a cache lookup on `CleanSeriesTitle()`, applies `FilterRegex` against the simplified release title, picks the best season-scoped mapping, then the closest title by Levenshtein distance. If several TVDB IDs remain, it throws `InvalidSceneMappingException`.
  3. The mapping shifts `MappedSeasonNumber` by `SeasonNumber − SceneSeasonNumber`.
  4. `FindSeries(...)` tries, in order: the scene mapping's TvdbId; `SeriesService.FindByTitle`, which matches only `CleanTitle` or `CleanOriginalTitle` (`Tv/SeriesRepository.cs:41`); all `title` captures; title plus year; then the indexer-provided `tvdbid`/`rid`/`imdbid`, logged as "an alias may be needed".
  5. `GetEpisodes(...)` branches on full season, daily, `IsAbsoluteNumbering` (→ `GetAnimeEpisodes`), possible scene special, or standard.
- **Absolute numbering.** `ParsingService.GetAnimeEpisodes` first looks up a scene season from the mapping. It then tries `EpisodeService.FindEpisodesBySceneNumbering(seriesId, sceneSeason, abs)` and falls back to `FindEpisode(seriesId, abs)` (matching `AbsoluteEpisodeNumber`). With no mapping, if the scene-absolute lookup returns more than one result, **it discards them** ("Don't allow multiple results without a scene name mapping"). `SeriesTypes.Anime` changes search (§8), the import specification `MediaFiles/EpisodeImport/Specifications/AbsoluteEpisodeNumberSpecification.cs`, and naming.
- **Why custom aliases aren't supported.**
  - (1) There is **no persistence path for user rows**. The table is owned by providers, and `UpdateMappings` deletes anything of the provider's `Type` that the remote didn't return.
  - (2) The only providers are remote: the services API and XEM.
  - (3) The API exposes alternate titles read-only.
  - (4) `Series` has no alias field, and `FindByTitle` checks only `CleanTitle`/`CleanOriginalTitle`.
  - This is a policy choice, not a technical limit. Upstream wants one central list. Radarr, by contrast, has `AlternativeTitle.SourceType.User = 2` in its enum (`Radarr src/NzbDrone.Core/Movies/AlternativeTitles/AlternativeTitle.cs`), but I found **no code that uses `SourceType.User`**.
- **Where a user alias table plugs in** (the cleanest route):
  - Add `UserAliasProvider : ISceneMappingProvider`, backed by a new `UserSceneMappings` table and repository, or by rows in `SceneMappings` with `Type = "UserAliasProvider"`.
  - Every row needs a stable `MappingId` (e.g. `user-{id}`), or `UpdateMappings` skips it.
  - Because the service diffs per provider type, user rows survive services and XEM refreshes, and they flow automatically into parsing (`FindSceneMapping`), search (`GetSceneNames` → `SceneTitles`), `FilterRegex` and season offsets.
  - To finish it: add CRUD in `Sonarr.Api.V3/Series/` (new `AliasController`) plus a UI under `frontend/src/Series/Details/`, and call `UpdateMappings`/`RefreshCache` after edits. The existing `UpdateSceneMappingCommand` works for this.
  - One caveat: `UpdateMappings` warns and does nothing when a provider returns an empty list. That's fine, but deleting the last user alias then won't delete the row, so handle deletion directly in the repository.

## 4. The parser, and why "Quan.Zhi.Fa.Shi.S6.-.01" fails

- **Files:**
  - `Parser/Parser.cs`: static, 1,369 lines. `ReportTitleRegex[]` holds **about 109 ordered regexes** on develop and 98 on main. **First match wins.**
  - `Parser/ParserCommon.cs`: `PreSubstitutionRegex` holds global rewrites applied before matching, e.g. Chinese fansub bracket normalisation and Korean `E\d+` → `S01E`.
  - `Parser/ParsingService.cs`, `Parser/QualityParser.cs`, `Parser/LanguageParser.cs`, `Parser/ReleaseGroupParser.cs`, `Parser/Model/ParsedEpisodeInfo.cs`.
- **Anime regexes** are interleaved through `ReportTitleRegex`. Their comments start "Anime - [SubGroup] Title …" or "Anime - Title Absolute Episode Number …", and the last entry is "Anime OVA special".
- **What happens to `Quan.Zhi.Fa.Shi.S6.-.01`.** I extracted the regex list and ran it with Python's `regex` module, which handles .NET-style syntax. The scratch script is `scratchpad/scripts/parsetest.py`.
  - On both branches the first match is **"// Multi-season pack"**:
    ```
    ^(?<title>.+?)(Complete Series)?[-_. ]+(?:S|(?:Season|…)[_. ])(?<season>\d{1,2})(?:[-_. ]{1}|[-_. ]{3})(?:S|Season…)?(?<season>\d{1,2})
    ```
    The `[-_. ]{3}` separator accepts `.-.` or ` - `, and the second `S` is **optional**. So `S6.-.01` reads as "season 6 to season 01": `title=Quan.Zhi.Fa.Shi`, `season=[6, 01]`.
  - `ParseMatchCollection` finds no `episode` or `absoluteepisode` capture, so it sets **`FullSeason = true`**.
  - **On v4 `main`:** `if (seasons.Distinct().Count() > 1) result.IsMultiSeason = true;` then `result.SeasonNumber = seasons.First()` gives **season 6, no episodes, flagged multi-season**. `DecisionEngine/Specifications/MultiSeasonSpecification.cs` then rejects it ("Multi-season releases are not supported"). That is exactly the symptom.
  - **On `develop` (v5):** the seasons are sorted and turned into a range, giving `SeasonNumbers = [1..6]` with `IsMultiSeason => SeasonNumbers.Count > 1`. It's still a "season pack" with no episode, so it is still wrong.
  - The regex never reaches the "Anime - Title with season number - Absolute Episode Number (Title S01 - EP14)" pattern further down the list.
  - Contrast: `[SubsPlease] Quan Zhi Fa Shi S6 - 01 (1080p)` (with a sub-group) matches "Anime - [SubGroup] Title with trailing 3-digit number…" as `title="Quan Zhi Fa Shi S6"`, `absolute=01`. That parses an episode, but the series title then includes "S6", so you'd need an alias for "Quan Zhi Fa Shi S6". `Quan Zhi Fa Shi - 01` gives `absolute=01`. `…S06E01…` parses correctly.
- **Where per-series parse rules could go.** `Parser.ParseTitle` is **static and has no series context**. It is called from about 30 places: `DownloadDecisionMaker`, `TrackedDownloadService`, `DownloadedEpisodesImportService`, `ManualImportService`, `CustomFormatCalculationService`, and others. Options:
  1. **Title rewrite pre-pass** (recommended). Add a user table of `{pattern, replacement, optional seriesId}`, e.g. `^(Quan[ ._]Zhi[ ._]Fa[ ._]Shi)[ ._]S(\d+)[ ._]-[ ._](\d+)` → `$1 S$2E$3`. Apply it in `ParseTitle` right after the built-in `PreSubstitutionRegex` loop. Because `Parser` is static, the rules have to be pushed into a static, thread-safe cache, e.g. by a service that handles an event and on startup. Alternatively, convert `Parser` into an injectable service, which is a large mechanical change.
  2. **A per-series alias with a season** (`SceneMapping.Title="Quan Zhi Fa Shi S6"`, `SceneSeasonNumber=6`). This fixes only the sub-group variant.
  3. Fix the core bug: require `S` or `Season` on the second capture in the multi-season regex. This is a one-line fix, but you need to run the large `NzbDrone.Core.Test/ParserTests` suite.

## 5. Specials, season 0, Radarr movies, and a "franchise" entity

- **Sonarr specials** are ordinary `Episode` rows with `SeasonNumber == 0`.
  - `Organizer/FileNameBuilder.cs:300` uses `NamingConfig.SpecialsFolderFormat` (default "Specials").
  - `Tv/MonitoringOptions.cs` has `MonitorSpecials` and `UnmonitorSpecials`.
  - Search: `IndexerSearch/ReleaseSearchService.EpisodeSearch` sends season 0 to `SearchSpecial`, which builds `SpecialEpisodeSearchCriteria.EpisodeQueryTitles` from "series title + episode title". For anime this only happens when the episode has no absolute number; otherwise it goes to `SearchAnime`.
  - Parsing: `ParsingService.ParseSpecialEpisodeTitle` fuzzy-matches the release title against season-0 episode titles (`EpisodeService.FindEpisodeByTitle(series.Id, 0, releaseTitle)`). It skips this when XEM maps an SxxE00 episode. `Parser.cs` also has an `AnimeSpecialMarkerRegex` (`special|ova|ovd|ncop|nced`) and an "Anime OVA special" regex. A decimal absolute such as `12.5` becomes `SpecialAbsoluteEpisodeNumbers` with `Special = true`.
  - `Episode.AiredAfterSeasonNumber`/`AiredBeforeSeasonNumber` exist (TVDB placement), but they are used for display and ordering only.
- **Radarr model.** `Movie` (user state: `MovieMetadataId`, `Monitored`, `MinimumAvailability`, `QualityProfileId`, `Path`, `MovieFileId`, `Tags`) is split from `MovieMetadata : Entity<MovieMetadata>` (`TmdbId`, `ImdbId`, `CollectionTmdbId`, `CollectionTitle`, `AlternativeTitles`, `Translations`, release dates…).
  - `Movies/Collections/MovieCollection.cs` (`TmdbId`, `Monitored`, `QualityProfileId`, `RootFolderPath`, `SearchOnAdd`, `List<MovieMetadata> Movies`) is Radarr's grouping concept.
  - Metadata comes from `api.radarr.video/v1` plus TMDb (`Radarr src/NzbDrone.Common/Cloud/RadarrCloudRequestBuilder.cs`).
  - Alternative titles are a real table with `SourceType {Tmdb, Mappings, User, Indexer}`.
  - Each movie has one file (`MovieFile`).

| Aspect | Sonarr | Radarr |
|---|---|---|
| Root entity | `Series` (TVDB-keyed) | `Movie` → `MovieMetadata` (TMDb-keyed) |
| Children | `Episode` rows; `Season` embedded JSON | none (1 movie = 1 file) |
| Grouping | none above series | `MovieCollection` (TMDb collection) |
| Aliases | `SceneMappings` (provider-owned) | `AlternativeTitles` table (has `User` source type) |
| Parser output | `ParsedEpisodeInfo` → `RemoteEpisode` | `ParsedMovieInfo` → `RemoteMovie` |
| Files | `EpisodeFile` (multi-episode) | `MovieFile` |

- **One franchise entity holding TV seasons, OVAs and movies.** Two designs:
  - **(A) Light:** a new `Franchise` table (`Id`, `Title`, `AniListIds`, `RootFolder`) plus `FranchiseMember` (`FranchiseId`, `SeriesId` or `MovieId`, `Order`, `Kind`). Series and movies stay in their own pipelines, and the franchise is a UI/grouping/path layer (Radarr's `MovieCollection` is the precedent). You still have to merge Radarr's `Movies/`, `MovieFiles`, Parser-for-movies, `RemoteMovie` decision engine and search into the Sonarr codebase. That doubles every pipeline: decision specs, import specs, history, queue, blocklist, custom-format inputs, API and UI. **Large.**
  - **(B) Movies as episodes:** model each movie/OVA as an `Episode` in season 0, or in synthetic "seasons" ≥ 100, of the series. Add an `EpisodeType` (TV, OVA, ONA, Movie, Special) column plus naming and search rules. This reuses the whole Sonarr pipeline. Search for movie-type episodes would use title search (like `SearchSpecial`) instead of absolute numbers. **Medium**, and much cheaper than merging Radarr. Its weakness is that movie release names ("Title.2019.1080p…") parse with no S/E. You'd extend the `ParseSpecialEpisodeTitle` fallback to match movie-type episodes by title and year.
  - **Recommendation:** start with (B).

## 6. Custom formats, quality profiles and the decision engine

- **`DecisionEngine/DownloadDecisionMaker.cs`** takes `IEnumerable<IDownloadDecisionEngineSpecification>`. For each release it runs `Parser.ParseTitle` → `ParsingService.Map` → `RemoteEpisodeAggregationService` → `CustomFormatCalculationService` → every specification. Each spec returns `DownloadSpecDecision.Accept()` or `Reject(DownloadRejectionReason, msg)`, and declares a `RejectionType` (Permanent or Temporary) and a `SpecificationPriority`.
  - Specs live in `DecisionEngine/Specifications/`: `QualityAllowedByProfileSpecification`, `CustomFormatAllowedByProfileSpecification`, `MultiSeasonSpecification`, `SceneMappingSpecification` (rejects `mixed` or `unknown` scene origins), `AnimeVersionUpgradeSpecification`, `BlocklistSpecification`, plus `RssSync/` and `Search/` subfolders.
  - Prioritisation: `DownloadDecisionPriorizationService` and `DownloadDecisionComparer`.
- **Custom formats** (`CustomFormats/`) are built from `ICustomFormatSpecification`s: `ReleaseTitleSpecification` (regex), `LanguageSpecification`, `ReleaseGroupSpecification`, `SourceSpecification`, `ResolutionSpecification`, `SizeSpecification`, `IndexerFlagSpecification`, `ReleaseTypeSpecification`. The input is `CustomFormatInput { EpisodeInfo, Series, Size, IndexerFlags, Languages, Filename, ReleaseType }`. Profiles live in `Profiles/Qualities/`, and release profiles are in `Profiles/Releases/`.
- **Pre-grab "requires English subs".**
  - Today's workaround is a `ReleaseTitleSpecification` CF with a regex like `\b(eng(lish)?[ ._-]?subs?|multi[ ._-]?subs?)\b` and a negative score. That is config only.
  - `LanguageParser` deliberately **ignores** language tokens followed by "subs": `LanguageRegex = (?:…)(?!(?:[-_. ](?:…))*[-_. ]subs?)`. Release-level subtitle languages are therefore not modelled.
  - A proper solution adds `SubtitleLanguages` to `ParsedEpisodeInfo`, a parser in `LanguageParser`, a `SubtitleLanguageSpecification : CustomFormatSpecificationBase`, and optionally an `IDownloadDecisionEngineSpecification` hard reject. Anime release names rarely state subtitle languages, so pre-grab detection will be heuristic (group whitelist, "Multi-Subs").
- **Post-download verification (the reliable route).**
  - MediaInfo is read **before** the import decision. `MediaFiles/EpisodeImport/Aggregation/AggregationService.cs:60` calls `localEpisode.MediaInfo = _videoFileInfoReader.GetMediaInfo(path)`, implemented in `MediaFiles/MediaInfo/VideoFileInfoReader.cs` via FFProbe (`Openur.FFMpegCore` and `Openur.FFprobeStatic` packages).
  - `MediaInfoModel.SubtitleStreams : List<MediaInfoSubtitleStreamModel { Language, Format, Title, Forced, HearingImpaired }>` is already populated.
  - The template is `MediaFiles/EpisodeImport/Specifications/HasAudioTrackSpecification.cs`. A new `HasEnglishSubtitleSpecification : IImportDecisionEngineSpecification` rejects with a new `ImportRejectionReason.MissingEnglishSubtitles` when there's no `eng` subtitle stream and no sidecar `.en.srt/.ass` in the download folder. Sidecar language parsing already exists in `LanguageParser.ParseSubtitleLanguage`. For anime you'd likely also check the stream `Title` for "English" and treat `und` as unknown.
- **Rejected import → blocklist + re-search: already supported.**
  - `Download/CompletedDownloadService.Import` sends a single rejected result to `Download/RejectedImportService.Process`. That method calls **`trackedDownload.Fail()`** when the rejection reason matches the indexer's `FailDownloads` setting. Today the values are `Executables`, `PotentiallyDangerous` and `UserDefinedExtensions` (`Indexers/FailDownloads.cs`).
  - A failed download goes through `FailedDownloadService` → `DownloadFailedEvent`. `Blocklisting/BlocklistService` (`IHandle<DownloadFailedEvent>`) blocklists the release, and `Download/RedownloadFailedDownloadService` (`IHandle<DownloadFailedEvent>`, gated by `AutoRedownloadFailed`) re-searches.
  - So "missing English subs → blocklist + re-search" needs **one enum value in `FailDownloads`**, one `ImportRejectionReason`, one `else if` in `RejectedImportService`, and the new import spec. Note that `RejectedImportService` only fires for `importResults.Count == 1`, so season packs with several files need extra handling.

## 7. Import pipeline, extras and a post-import hook

- **Automatic import:** `Download/CompletedDownloadService` → `MediaFiles/DownloadedEpisodesImportService` → `MediaFiles/EpisodeImport/ImportDecisionMaker.GetImportDecisions(...)`.
  - The decision maker builds `LocalEpisode` objects. Aggregation (`Aggregation/Aggregators/AggregateEpisodes`, `AggregateLanguage`, `AggregateQuality`, `AggregateReleaseGroup`, `AggregateSubtitleInfo`, plus `Augmenters/` including `AugmentLanguageFromMediaInfo`) reads mediainfo and runs every `IImportDecisionEngineSpecification` in `EpisodeImport/Specifications/` (`UpgradeSpecification`, `AbsoluteEpisodeNumberSpecification`, `UnverifiedSceneNumberingSpecification`, `HasAudioTrackSpecification`, `MatchesFolderSpecification`, `MatchesGrabSpecification`, …).
  - Next, `EpisodeImport/ImportApprovedEpisodes.Import` moves or copies the file (`EpisodeFileMovingService`), calls `_extraService.ImportEpisode(...)`, and publishes **`EpisodeImportedEvent`** (or `EpisodeImportFailedEvent`).
- **Manual import:** `MediaFiles/EpisodeImport/Manual/ManualImportService.cs` (API in `Sonarr.Api.V3/ManualImport/`, UI in `frontend/src/InteractiveImport/`).
- **Extras:** `Extras/ExtraService.cs` with `IManageExtraFiles` implementations in `Extras/Subtitles/` (`SubtitleService`, `ExistingSubtitleImporter`, `SubtitleFile`), `Extras/Metadata/` and `Extras/Others/`. Extensions come from config `ExtraFileExtensions`.
- **Post-import hook (e.g. Whisper subtitle generation).**
  - In-process: a new `SubtitleGenerationService : IHandleAsync<EpisodeImportedEvent>` that queues a `GenerateSubtitlesCommand`, with an `IExecute<GenerateSubtitlesCommand>` doing the work. That keeps the work off the import thread and shows it in the task UI. Register the result as a `SubtitleFile` through `ISubtitleFileService` so renames and deletes track it.
  - Out-of-process with zero code: `Notifications/CustomScript/` or `Notifications/Webhook/` "On Import". This is what Bazarr-style tools use.

## 8. Indexer search and Prowlarr

- **Search services:** `IndexerSearch/ReleaseSearchService.cs` (plus `EpisodeSearchService`, `SeasonSearchService`, `SeriesSearchService`).
  - For anime series it builds `AnimeEpisodeSearchCriteria` with `AbsoluteEpisodeNumber = SceneAbsoluteEpisodeNumber ?? AbsoluteEpisodeNumber`, and `AnimeSeasonSearchCriteria` for seasons.
  - Titles come from `Get<TSpec>()` → `_sceneMapping.GetSceneNames(series.TvdbId, seasons, sceneSeasons)` plus `series.Title`, and per-mapping `SceneEpisodeMapping`/`SceneSeasonMapping`. `SearchCriteriaBase.CleanSceneTitles` and `AllSceneTitles` hold the results.
- **Query formats** (`Indexers/Newznab/NewznabRequestGenerator.cs`, which Torznab inherits):
  - Anime episode:
    - ID search with `&q={abs:00}`;
    - optional `&season=&ep=` when the indexer's **`AnimeStandardFormatSearch`** setting is on;
    - per title, `search&q={title}+{abs:00}` and optional `tvsearch&q={title}&season=&ep=`.
  - ID params are `tvdbid`, `imdbid`, `rid`, `tvmazeid` and `tmdbid` (lines ~528–548). There's **no AniDB or AniList ID param**.
  - `Indexers/Nyaa/NyaaRequestGenerator.cs` searches `{title}+{abs:0}` and `{abs:00}`, plus optional `s{SS}e{EE}`.
  - **Missing for "deep search":** queries like `Title S6 - 01`, `Title - 01`, `Title E01`, a 3-digit `001`, romaji/English/synonym titles from AniList, and season-title aliases unless a scene mapping provides them.
- **Where to extend:** add `SceneTitles` from the user alias table (automatic via §3), and add query variants in `NewznabRequestGenerator.GetSearchRequests(AnimeEpisodeSearchCriteria)` and `NyaaRequestGenerator`, behind a new setting so indexers aren't hammered.
- **Prowlarr integration.** Sonarr has **no Prowlarr-specific code**; grepping `*.cs` for "prowlarr" finds nothing.
  - Prowlarr's `src/NzbDrone.Core/Applications/Sonarr/Sonarr.cs` + `SonarrV3Proxy.cs` call Sonarr's `/api/v3/indexer` (plus `/schema` and `/system/status`). They create `Newznab` or `Torznab` indexers with `baseUrl = {ProwlarrUrl}/{id}/` and sync the fields `categories`, `animeCategories`, `animeStandardFormatSearch`, `minimumSeeders`, `seedCriteria.*`, …
  - **An AnimeArr fork must keep `/api/v3/indexer` and the Newznab/Torznab schema field names compatible**, otherwise Prowlarr sync breaks. The fallback is adding AnimeArr as a "Sonarr" app in Prowlarr, which works as long as the API is unchanged.

## 9. Licensing and naming

- **Sonarr:** `LICENSE.md` is GPL-3.0. `COPYRIGHT.md` reads "2010-2017 Mark McDowall, Keivan Beigi, Taloth Saldono and contributors… either version 3 of the License, or (at your option) any later version". There is also `CLA.md` (an individual CLA granting Sonarr a broad licence; it applies to upstream contributions only, not to forks). **Radarr:** `LICENSE` is GPL-3.0.
- **GPL-3.0 obligations for AnimeArr:**
  - Keep the licence and copyright notices, and add your own copyright for your changes.
  - Mark modified files or state prominently that it's modified (GPLv3 §5a).
  - License the whole fork under GPL-3.0, including any merged Radarr code (also GPL-3.0, so compatible).
  - Provide the corresponding source to anyone you distribute binaries or Docker images to. A public GitHub repo at the matching tag satisfies this.
  - GPL-3.0 is *not* AGPL, so running it as a network service carries no source obligation, but distributing images does.
  - Bundled third-party libraries keep their own licences (FFprobe static binaries are LGPL/GPL builds; check `Openur.FFprobeStatic`). *(Unverified detail.)*
  - **Do not use Sonarr's hosted services** (`skyhook.sonarr.tv`, `services.sonarr.tv`) from a fork without permission. They're operated by the Sonarr team and are not covered by the GPL. *(Policy unverified; treat as a requirement.)* XEM (`thexem.info`) is a third-party service.
- **Fork history** *(general knowledge, unverified in repo)*:
  - Radarr was forked from Sonarr (v2 develop) in late 2016 and kept the `NzbDrone.*` project names, as both trees show.
  - Lidarr was forked around 2017 and Readarr around 2019 (from the Lidarr lineage).
  - Prowlarr was created around 2020 on the shared codebase.
  - All of them kept GPL-3.0, renamed the product and assemblies (e.g. `Radarr.Api.V3`, `Radarr.Http`), ran their own metadata servers (`api.radarr.video`, `radarr.servarr.com`) and replaced the logos.
- **Trademark** *(unverified)*: neither README states a trademark policy. Even so, avoid "Sonarr" or "*arr-team" branding and the Sonarr logo (`Logo/`), and say "based on Sonarr". The "-arr" suffix is a community convention; it does not imply affiliation. The name "AnimeArr" may collide with existing community projects, so search GitHub and Docker Hub before committing to it.
- **Upstream policy:** `AGENTS.md` and `CONTRIBUTING.md` set strict AI-contribution rules for PRs *to Sonarr*. This matters only if you upstream fixes such as the multi-season regex.

## 10. Effort estimate

| AnimeArr change | Size | Why |
|---|---|---|
| **User alias table** | **Small–Medium** | Plug-in point exists (`ISceneMappingProvider`, auto-registered; per-provider diffing keeps user rows). Needs a migration, repository, provider, CRUD API and a small UI panel. Parsing, search and season offsets come for free. |
| **Per-series parse/rewrite rules** (fixes `S6 - 01`) | **Small–Medium** | Regex rewrite table applied after `PreSubstitutionRegex` in static `Parser.ParseTitle`, fed from a static cache. Plus a one-line upstream regex fix. Needs regression runs of `NzbDrone.Core.Test` ParserTests. |
| **AniDB/AniList metadata** | **Medium** (enrich, TVDB spine) / **Large** (replace TVDB) | Interface swap is trivial, but `TvdbId` is the key in 232 places across 79 Core files, plus XEM, scene mappings, Newznab `tvdbid`, API and UI. Enriching via a self-hosted SkyHook-compatible proxy (point `SkyHookTvdb` elsewhere) is the pragmatic route. AniDB rate limits mean a caching proxy is required. |
| **Franchise model** (TV + OVA + movies) | **Medium** (movies as typed episodes in one series) / **Large** (merge Radarr) | Merging Radarr duplicates every pipeline: parser, decision, import, files, queue, history, API, UI. Modelling movies and OVAs as `Episode` rows with an `EpisodeType` reuses Sonarr's pipeline and needs only search and parse fallbacks. |
| **English-subs verification** (post-import, blocklist + re-search) | **Small** | `MediaInfo.SubtitleStreams` already read pre-import via FFProbe. Add an `IImportDecisionEngineSpecification`, an `ImportRejectionReason`, a `FailDownloads` option and one branch in `RejectedImportService`; blocklist and redownload already exist. Season packs need extra care. Pre-grab detection is **Medium** and heuristic (new parsed field plus CF spec). |
| **Specials routing** (OVA/ONA/movie → correct slot) | **Medium** | Season 0 logic is spread across `ParsingService` (`ParseSpecialEpisodeTitle`, `GetAnimeEpisodes` special branch), `ReleaseSearchService.SearchSpecial`, `FileNameBuilder` and XEM. Needs an episode-type concept, metadata to supply it (AniDB types), and title-based matching rules. |
| **Deep search** (multiple numbering formats, synonyms) | **Small–Medium** | Additive changes to `NewznabRequestGenerator`/`NyaaRequestGenerator` anime methods plus extra `SceneTitles` from aliases and AniList synonyms. Risk is indexer rate limits; gate it behind a setting and only use it on manual or "missing" searches. |
| **Post-import hook** (subtitle generation) | **Small** | `IHandleAsync<EpisodeImportedEvent>` plus a command; or zero code via Custom Script/Webhook "On Import". |
| **Rebrand / fork hygiene** | **Small–Medium** | Rename assemblies and namespaces optionally (Radarr kept `NzbDrone.*`). Must replace `SonarrCloudRequestBuilder` endpoints (SkyHook, services) with your own or disable them, plus logos, update channel (`NzbDrone.Update`) and analytics. |
