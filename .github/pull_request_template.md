## What and why

<!-- What does this change, and what problem does it solve? Link the issue if there is one (e.g. "Fixes #12"). -->

## How it was tested

<!-- npm test, plus what you clicked through by hand. Screenshots help for UI changes (phone and desktop). -->

## Checklist

- [ ] `npm test` and `npm run typecheck` pass
- [ ] A test covers the new or changed behaviour (pipeline, parser and ranking changes especially)
- [ ] `scripts/secret-scan.sh` passes: no keys, tokens, private addresses or personal paths
- [ ] Anything that deletes or replaces files still goes through confirmations, the recycling bin and dry run
- [ ] New UI text is in `web/src/i18n*.ts`, in plain, short sentences
- [ ] I agree that this contribution is licensed under GPL-3.0
