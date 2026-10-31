# Contributing

Thanks for wanting to help! AnimeArr is a TypeScript app: a Fastify server (`server/`, Node 24, built-in `node:sqlite`)
and a React web UI (`web/src`).

```bash
npm install
npm run dev        # web build + server with live reload on http://localhost:8484 (config in ./.devconfig)
npm test           # node:test suites in test/
npm run typecheck
```

- **Branches:** `main` holds released versions only; new work goes to `nightly`. Open pull requests against
  `nightly` (fixes for a released version can target `main`). Both branches are protected: changes arrive through pull
  requests whose tests pass.
- **Small, focused pull requests**, with a test when you change behaviour (the pipeline, parser and ranking all have
  tests with mocks; nothing should need a real Sonarr or download client).
- **Never commit keys, tokens or personal paths.** `scripts/secret-scan.sh` runs as a pre-commit check; please run it.
- **Safety first:** anything that deletes or replaces files goes through confirmations, the recycling bin and dry run.
  Keep it that way.
- UI text is in `web/src/i18n.ts` (plain, short sentences; no jargon where a normal word works).
- By contributing you agree that your contribution is licensed under GPL-3.0.

Bigger ideas: please open an issue first so we can talk it through. The plan lives in BACKLOG.md and PARITY.md.
