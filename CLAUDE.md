# Relay Asset Manager — Project Conventions

## Tech Stack

- **Framework**: Next.js 16 (App Router) with React 19
- **Language**: TypeScript (strict mode)
- **Styling**: Tailwind CSS 4 + custom CSS variables (`--ram-*` prefix in `src/app/globals.css`)
- **Database**: Supabase (Postgres + pgvector for semantic search)
- **Storage**: Supabase Storage (thumbnail cache)
- **Auth**: Supabase Auth with Google OAuth
- **Drive Access**: Google Drive API v3 (3-tier auth: WIF, ADC, or user OAuth)
- **AI**: Gemini API (embeddings for search, Flash for asset analysis)

## Directory Structure

```
src/
  app/           — Next.js pages + API routes
  components/    — React UI components (namer/ subdirectory for Asset Namer module)
  hooks/         — Custom React hooks
  lib/           — Shared utilities and business logic
    google/      — Drive auth (WIF + OAuth + ADC)
    supabase/    — Client, server, middleware helpers
    sync/        — Shared sync engine: scope, drive-retry, drive-file, thumbnails,
                   embedder, asset-row (used by scripts/sync.ts, scripts/embed.ts,
                   /api/sync/ingest and search — don't re-implement in callers)
    namer/       — Namer types and utilities
  types/         — TypeScript interfaces
supabase/
  schema.sql     — Complete database schema (run in SQL Editor)
scripts/
  sync.ts        — CLI sync pipeline (also invoked by GitHub Actions)
  embed.ts       — Batch embedding generation
```

## Key Patterns

- **DB-backed configuration**: Most operational settings live in the `app_settings` table (key-value with JSONB values), editable from the Settings UI. Environment variables serve as fallback defaults. See `src/lib/config.ts`.
- **Google auth tiers**: Production uses Workload Identity Federation via `@vercel/oidc`. Local testing uses ADC (`USE_SERVICE_ACCOUNT=true`). Local dev falls back to the user's OAuth token from the Supabase session. See `src/lib/google/auth.ts`.
- **CSS variables**: All theme colors use the `--ram-` prefix. Defined in `src/app/globals.css` `:root`. Components reference these via inline styles or Tailwind arbitrary values.
- **No external state management**: App state is managed with React hooks (useState, useCallback, useRef, useEffect) in `src/app/page.tsx`. No Redux/Zustand.

## Commands

```bash
npm run dev        # Start dev server
npm run build      # Production build
npm run lint       # ESLint check
npm test           # Unit tests (node:test + tsx) for pure logic in tests/
npx tsx scripts/sync.ts              # Run sync pipeline
npx tsx scripts/sync.ts --skip-thumbnails  # Sync without thumbnail processing
npx tsx scripts/sync.ts --allow-mass-orphan # Let a run trash >max(100, 10%) missing assets
npx tsx scripts/sync.ts --dry-run --dry-run-out=plan.json  # Read everything, write nothing, emit the plan
npx tsx scripts/embed.ts             # Generate embeddings for assets missing them
npx tsx scripts/embed.ts --force     # Regenerate all embeddings
```

## Commit Style

Use prefixes: `feat:`, `fix:`, `ui:`, `refactor:`, `docs:`, `chore:`. Keep subject lines under 72 characters.

## Gotchas

Things that aren't obvious from the code but cost time when forgotten.

### Data flow

- **The folder sidebar tree mixes two sources.** Paths come from `assets.folder_path` (real ingested files) AND virtual entries synthesized from `shortcuts.project_folder_path` in `/api/assets`. A phantom top-level folder usually means a bad path in `shortcuts`, not a sync bug.
- **Drive folder paths must be derived from `project_folder_drive_id`, never trusted from client-supplied strings.** The folder ID is the gold-standard identifier; path strings are display/cache values that can drift.
- **`[relay-ignore]` in a folder's Drive description** skips that folder and all descendants during sync (the targeted ingest honors it too).
- **Relays live inside the library.** The relay route only accepts destination folders inside the synced folders and outside `[relay-ignore]`; the sync keeps a shortcut row only while its shortcut is still there (deleting or moving a project folder out removes its relays after the 2-day grace period). Deliberate, to prevent sprawl — as of 2026-09 every relay was inside the synced folders anyway.
- **Four trash reasons, two purge behaviors.** `orphaned` (file gone from Drive), `ignored` (`[relay-ignore]` folder) and `moved-out` (file moved out of the synced folders — a curation decision) hard-purge after 14 days. `out-of-scope` (its top-level folder was removed from `sync_folders` in Settings) is exempt from the purge — a config change, so rows/embeddings/thumbnails are kept and auto-restore on the next sync if the folder is re-scoped.
- **The sync refuses to mass-trash.** If one run would trash more than max(100, 10% of active) assets as `orphaned`, `moved-out` or `ignored` (all purge after 14 days), it skips that soft-delete and logs a `partial` run with an explanation in Settings. Files the crawl *saw* but skipped (moved out of scope, or into a `[relay-ignore]` folder) are classified by where they are now — only files absent from Drive are `orphaned`. The usual cause is a renamed top-level folder: scope is matched by folder *name*, so a rename makes every file under it look deleted. Rename it back (or update `sync_folders`); only use `--allow-mass-orphan` (or the "Allow mass orphan" checkbox on a manual GitHub Actions run) for a real bulk deletion.
- **Thumbnails are time-boxed per sync** (`SYNC_THUMBNAIL_BUDGET_MIN`, default 15) so a big backlog can't starve the upsert/orphan/embed steps; leftovers are picked up next run. Every stored thumbnail goes through `encodeThumbnail` (`src/lib/sync/thumbnail-encode.ts`) — real WebP, ≤800px — in both the cron and the in-app ingest.
- **Verify sync changes with a dry run before they write.** Actions → Daily Sync → Run workflow with `dry_run` checked uploads the planned changes as an artifact (`sync-plan-<sha>`). Run it on the old and new code and diff the two JSON files — the 2026-09-24 engine consolidation shipped only after the plans matched exactly. Dry runs can't exercise thumbnail/embedding/trash paths when the data has nothing to do there; those rely on `tests/`.
- **`sync_logs` is the activity log for both ingestion paths.** `source` is `cron` (scheduled sync) or `ingest` (in-app, per Namer batch); `details` holds structured problems, the GitHub run URL, and for ingests the user and per-file errors/skips. Anything that goes wrong without stopping a run should go through `problem()` in `scripts/sync.ts` so the run is marked `partial` and the reason is recorded. Killed/timed-out runs are recorded by the workflow's last step (`scripts/record-sync-failure.ts`). Settings' "latest sync" filters `source = 'cron'`; Settings → Recent activity and the header indicator read `/api/sync/activity`.
- **One embedding model, one place.** `src/lib/sync/embedder.ts` defines the Gemini model and dimensions for documents *and* search queries. If they ever differ, semantic search silently compares incompatible vectors. Changing the model means re-embedding everything (`scripts/embed.ts --force`).
- **`parseFilename` is shared** — `src/lib/filename-utils.ts` is the single parser used by the app, the namer ingest, and `scripts/sync.ts`. Don't fork it: divergent parsed values trigger mass re-embeds on the next sync (embedding text includes the parsed description).

### Caching

- **`/api/assets` returns `Cache-Control: private, max-age=60, stale-while-revalidate=300`.** In-app mutation flows (relay, trash, namer ingest, sync-complete) call `refreshAssets()` in `page.tsx`, which fetches with `cache: 'reload'`. Changes made *outside* your session (another user's relay, the cron sync) can still appear up to 60s stale until reload.
- **The asset list is also cached in IndexedDB** (`src/lib/asset-cache.ts`) and painted immediately on load, then replaced by the network response. Asset-list fetches are sequence-guarded in `page.tsx` — only the newest response is applied and cached. If you change the `AssetListPayload` shape, bump the cache `KEY`.
- **Shortcut clones are built client-side.** `/api/assets` returns `{ assets, shortcuts: [assetId, folderPath][] }`; `expandAssetList` creates the `::sc::` clone entries.

### Supabase RLS

- **`assets`, `shortcuts`, and `app_settings` are read-only for the user's anon-key client; all writes are service-role-only.** Authenticated clients get SELECT (the `/api/assets` route reads via the user session); every INSERT/UPDATE/DELETE goes through a server route or the sync pipeline using the service-role client from `getAdminClient()` (`src/lib/supabase/admin.ts`) — use it rather than hand-rolling `createClient`; it throws when the key is missing instead of falling back to the anon key, whose writes silently no-op under RLS. Mutating these tables from the browser will be denied by RLS. (Migrations: `supabase/migrations/2026-06-08_lockdown_write_rls.sql`, `2026-06-10_drop_authenticated_thumbnail_upload.sql` — both applied manually in the SQL Editor.)
- **Bulk upserts NULL any column a row omits if another row in the batch includes it.** postgrest-js sends the union of keys as `columns`. "Omit the column to preserve it" only works when every row in the request has the same keys — use `groupRowsByColumns` (`src/lib/sync/asset-row.ts`). This silently wiped custom thumbnail URLs on alternate syncs until 2026-09-24.
- **Schema changes go in two places.** A new idempotent file in `supabase/migrations/` (plus a row in its README) *and* the same change in `supabase/schema.sql`. `tests/schema.test.ts` (PGlite + pgvector) fails if a fresh install and an upgrade from the first release's schema (`tests/fixtures/`) differ, or if a migration isn't re-runnable. Migrations are applied by hand in the SQL Editor — required ones *before* the code that needs them deploys.
- **Supabase silently no-ops RLS-filtered updates** — no error returned, just zero rows affected. Always chain `.select('id')` after `.update()` if you need to verify rows actually changed.

### Configuration

- **`?? []` fallback in `src/lib/config.ts` is a trap.** Nullish coalescing only fires on `null`/`undefined`, so a setting saved as `[]` short-circuits the env-var fallback. An empty `sync_folders` list disables filtering entirely (allows every Drive folder). `PUT /api/settings/config` now rejects `[]` for `sync_folders` and an empty `shared_drive_id`, but a direct DB write can still set them.
- **`getConfig()` fails closed.** It throws on a Supabase error rather than falling back to env vars — an env-only config can have an empty `sharedDriveId`, which turns off the shared-drive scope checks.

### Auth tiers

- **`getDriveAccessToken()` picks one of three paths** — production uses WIF (Vercel OIDC → service account); local with `USE_SERVICE_ACCOUNT=true` uses ADC; otherwise it falls back to the user's Supabase OAuth token.
- **Local ADC defaults to your personal Google account, not the service account.** To impersonate the SA locally so scripts can see all folders the SA can: `gcloud auth application-default login --impersonate-service-account=<sa-email>`. Without this, scripts hit 404s on private folders.
