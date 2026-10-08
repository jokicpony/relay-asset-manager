# Contributing to Relay Asset Manager

Thanks for your interest. Bug reports, fixes and focused improvements are all
welcome.

## Getting set up

You'll need your own instance to test against — at least a Supabase project
with the schema applied and Google sign-in configured
([docs/SETUP.md](docs/SETUP.md) steps 2 and 3.1–3.3). Then follow "Local development" in the [README](README.md).
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the pieces connect,
and [CLAUDE.md](CLAUDE.md) lists the conventions and the gotchas that have
cost time before — worth a skim whoever (or whatever) is writing the code.

## Before you open a PR

CI runs these on every push and PR; please run them locally first:

```bash
npm run lint
npm test
npx tsc --noEmit
```

(`npm run build` needs real environment variables, so CI doesn't run it.)

Depending on what you touched:

- **Database:** add an idempotent file to `supabase/migrations/` *and* make the
  same change in `supabase/schema.sql`, with a row in
  [`supabase/migrations/README.md`](supabase/migrations/README.md). `npm test`
  fails if a fresh install and an upgrade don't match.
- **Sync behaviour:** run `scripts/sync.ts --dry-run --dry-run-out=before.json`
  on `main` and the same on your branch, and diff the two plans. Every
  difference should be intended; refactors should produce identical plans.
- **Anything the sync and the app both do** (scope, filename parsing,
  thumbnails, embeddings): change the shared module in `src/lib/sync/` or
  `src/lib/filename-utils.ts`, never a copy.
- **Behaviour described in the docs:** update the README, `docs/` or
  `CLAUDE.md` in the same PR.

## Pull requests

- Branch from `main`; keep each PR to one concern.
- Describe what changed and why, how you tested it, and include screenshots for
  UI changes and any migration an upgrader must apply.
- Commit subjects start with `feat:`, `fix:`, `ui:`, `refactor:`, `docs:` or
  `chore:`, under 72 characters.

## Reporting issues

Open an issue with what you expected, what happened, and steps to reproduce.
For sync problems, the Settings → Recent Activity entry (and the GitHub
Actions log it links to) usually says what went wrong — include it, with any
IDs or keys removed. Security problems go to [SECURITY.md](SECURITY.md), not
an issue.
