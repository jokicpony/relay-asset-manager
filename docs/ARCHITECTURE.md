# Architecture — how Relay fits together

This page is the map: what the pieces are, how data moves between them, and
the rules that keep it working. It's written for people and coding agents
alike — skim the diagrams and bold sentences for the idea, follow the file
pointers for detail. It doesn't list every route, column or setting; the code
and `supabase/schema.sql` are the reference for that.

Related: [SETUP.md](SETUP.md) (building an instance) ·
[OPERATIONS.md](OPERATIONS.md) (running one) · [`CLAUDE.md`](../CLAUDE.md)
(conventions and gotchas).

---

## The one-sentence version

**Google Drive is the source of truth; Relay is an index on top of it.** Files
never move into Relay. A scheduled sync copies *metadata* (name, folder, size,
rights labels) from one Google Shared Drive into Postgres, makes a small WebP
thumbnail of each file, and computes a search embedding. The web app reads that
index for fast browsing and search, and every action that changes something
(rename, relay, download, video playback) goes back to Drive through a Google
service account.

## The pieces

```
                         ┌──────────────────────────────┐
                         │  Google Shared Drive         │  ← the real files
                         │  (+ Drive Labels for rights) │
                         └──────────────┬───────────────┘
                 reads/writes via the   │   service account
                 service account (WIF)  │   (WIF, no keys)
        ┌───────────────────────────────┼─────────────────────────────┐
        │                               │                             │
┌───────▼─────────────┐       ┌─────────▼──────────┐       ┌──────────▼─────────┐
│ GitHub Actions      │       │ Vercel             │       │ Gemini API         │
│ "Daily Sync"        │       │ Next.js app + API  │──────▶│ embeddings,        │
│ scripts/sync.ts     │──────▶│ routes             │       │ Namer image        │
│ every 6h + manual   │ Gemini│ (src/app)          │       │ analysis           │
└───────┬─────────────┘       └───┬───────────▲────┘       └────────────────────┘
        │ service-role key        │ service   │ user session (anon key, read-only)
        │ (all writes)            │ role      │
┌───────▼─────────────────────────▼───────────┴──────────────────────────────┐
│ Supabase                                                                   │
│  Postgres: assets · shortcuts · sync_logs · app_settings  (+ pgvector)    │
│  Storage:  thumbnails bucket (public, {driveFileId}.webp)                 │
│  Auth:     Google sign-in                                                 │
└────────────────────────────────────────────────────────────────────────────┘
                                   ▲
                                   │  browser (React, IndexedDB cache)
                                 users
```

| Piece | What it does | Where |
|---|---|---|
| **Shared Drive** | Holds every photo/video. Folder structure *is* the library structure. | Google Workspace |
| **Daily Sync** | Full crawl of the drive → database. The only thing that discovers deletions. | `.github/workflows/daily-sync.yml` → `scripts/sync.ts` |
| **Web app** | Browse, search, Namer, relays, downloads, settings. | `src/app/page.tsx` (UI), `src/app/api/*` (server) |
| **Sync engine** | Shared building blocks used by the cron *and* the app, so both write identical rows. | `src/lib/sync/*` |
| **Supabase** | Database, thumbnail storage, sign-in. | `supabase/schema.sql` |
| **Gemini** | Turns each asset (thumbnail + text) into a 768-number vector for "search by meaning"; also suggests metadata in the Namer. | `src/lib/sync/embedder.ts`, `src/app/api/namer/analyze` |

## Who is allowed to do what

Three identities touch the data. Knowing which one a piece of code uses
explains most permission errors.

1. **The user's session** (Supabase anon key + login cookie). Can *read*
   `assets`, `shortcuts`, `sync_logs`, `app_settings`. **Cannot write
   anything** — row-level security blocks it, and Supabase reports a blocked
   update as success with zero rows, not as an error.
2. **The service role** (Supabase service-role key, server only). Every write
   — sync, ingest, relays, trash, settings — goes through an API route or
   script using `getAdminClient()` (`src/lib/supabase/admin.ts`).
3. **The Google service account.** All Drive access in production is the
   service account, reached without any stored key via Workload Identity
   Federation: Vercel (or GitHub Actions) proves its identity to Google with a
   short-lived OIDC token and gets a Drive token back
   (`src/lib/google/auth.ts`). Users' own Google tokens are only a local-dev
   fallback.

The service-role key, Google client secret and Gemini key exist only in
server-side environment variables; nothing secret reaches the browser.

Because the service account can see more than the library, **every route that
takes a Drive ID from the browser re-checks it server-side**: the ID must be
well-formed, the file/folder must be inside the configured shared drive
(`isInSharedDrive`, `src/lib/google/drive-scope.ts`), and for library actions
it must be an active asset or a folder inside the synced folders. Never trust a
folder *path* sent by the browser — derive it from the Drive folder ID.

**Who can sign in at all** is decided by the Google OAuth consent screen
(Internal, External + test users, or published — see SETUP.md step 3.2).
`src/proxy.ts` → `src/lib/supabase/middleware.ts` then requires a session for
every page and API route, and applies the optional email/domain allowlist
(`AUTH_ALLOWED_EMAILS` / `AUTH_ALLOWED_DOMAINS`) when it's set.

## What's in the database

| Table | One row per… | Written by |
|---|---|---|
| `assets` | file in the library (incl. trashed ones) — metadata, rights, thumbnail URL, placeholder colour, embedding, trash state | sync, ingest, trash/thumbnail routes |
| `shortcuts` | Drive shortcut ("relay") pointing at an asset from a project folder | relay route, sync |
| `sync_logs` | sync run or in-app ingest — counts, status, problems | sync, ingest, `record-sync-failure.ts` |
| `app_settings` | setting (key → JSON). Config *and* a few caches. | Settings UI (via `/api/settings/config`, `/api/namer/settings`), sync |

`app_settings` keys worth knowing:

- **Config** (edited in Settings; read through `getConfig()` in
  `src/lib/config.ts`, which falls back to env vars only when a key is
  missing): `shared_drive_id`, `sync_folders` (top-level folder *names* that
  make up the library), `drive_label_id`, `rights_label_config` (label field
  IDs → rights columns), `namer_label_ids`, `hidden_folders`,
  `semantic_similarity_threshold`, `namer_auto_ingest_delay_ms`.
- **Namer** setup: `namer_schemas`, `namer_dropdowns`, `namer_ai_config`,
  `namer_help_guide`.
- **Written by the system, not people:** `folder_drive_ids` (folder path →
  Drive folder ID, refreshed every sync; powers "Open in Drive" and scope
  checks), `sync_progress` (live progress of a running sync),
  `pending_ingests` (Namer ingests waiting to run).

Schema changes always go in two places (`supabase/schema.sql` *and* a new file
in `supabase/migrations/`) and are applied by hand in the Supabase SQL Editor
**before** deploying code that needs them. `npm test` proves the two agree.

---

## Flow 1 — The scheduled sync (the heart of it)

GitHub Actions runs `scripts/sync.ts` every 6 hours (and on demand: "Sync now"
in Settings calls `/api/sync/trigger`, which dispatches the same workflow). Two
runs never overlap. Each run, in order:

1. **Load config** from `app_settings` and get a Drive token (WIF).
2. **Snapshot** each asset's embedding inputs, to detect changes later.
3. **Fetch the whole folder tree** in a few list calls and build every folder's
   path. Folders whose Drive *description* contains `[relay-ignore]` are
   excluded along with everything under them.
4. **Crawl** every image/video in the shared drive. A file is *in the library*
   if its path starts with one of the `sync_folders` names and it isn't under
   an ignored folder. Files the crawl sees but skips are remembered (so step 7
   knows they moved rather than vanished). The path → folder-ID map is saved
   to `folder_drive_ids`.
5. **Thumbnails** for files that don't have one: Drive thumbnail → ≤800px WebP
   → `thumbnails/{driveFileId}.webp`, plus a dominant colour for the grid
   placeholder. Time-boxed (15 min default); leftovers wait for the next run.
6. **Upsert** every crawled file into `assets`, keyed by `drive_file_id`.
   Custom video-frame thumbnails set by users are preserved.
7. **Trash what's gone** (soft delete, `deleted_at` + `deleted_reason`):

   | Reason | Meaning | After 14 days |
   |---|---|---|
   | `orphaned` | not in Drive any more | purged |
   | `moved-out` | still in Drive, moved out of the synced folders | purged |
   | `ignored` | now under a `[relay-ignore]` folder | purged |
   | `out-of-scope` | its whole top-level folder was removed from Sync Folders in Settings | **kept**; restored if re-added |

   Assets that reappear are restored. **Safety limit:** if a run would trash
   more than max(100, 10% of active) assets for one of the three purged
   reasons, it skips that trashing and records why — almost always a renamed
   top-level folder (scope is matched by *name*). The user-facing version of
   these rules is the README's "Which folders are in Relay".
8. **Relays:** find every Drive shortcut inside the library that points at an
   asset and record it in `shortcuts`. A shortcut the sync stops seeing is
   marked `missing_since` and dropped after 2 days.
9. **Purge** trashed assets past 14 days (rows, thumbnails).
10. **Embeddings:** assets whose name/folder/description changed get their
    embedding cleared; then everything with no embedding (new, changed,
    previously failed) is embedded with Gemini. Skipped without a
    `GEMINI_API_KEY`.
11. **Log** one `sync_logs` row: `success`, `partial` (something failed but the
    run finished — each problem recorded by step) or `failed`. A run killed by
    a timeout is recorded by the workflow's last step.

The run never stops for a recoverable problem: it calls `problem(step, msg)`,
carries on, and marks the run `partial`. Most such problems fix themselves on
the next run (missing thumbnails and embeddings are simply retried).

`--dry-run --dry-run-out=plan.json` does every read and no writes, and emits
the plan. **Any change to sync behaviour should be checked by diffing the
plan before and after** (the workflow's `dry_run` option uploads it as an
artifact).

## Flow 2 — The Namer and the in-app ingest

The Namer (the "Asset Namer" tab) is how new files get properly named,
labelled and filed. All of it happens in the browser tab, one file at a time,
through `/api/namer/*` routes:

```
pick source folder ─▶ build names from a schema ─▶ for each file:
    rename + move to destination  (/api/namer/files/update)
    apply Drive Labels            (/api/namer/labels/apply)
    optional Gemini analysis      (/api/namer/analyze → hidden appProperties)
    set Drive description         (/api/namer/files/description)
─▶ schedule an ingest of the batch (useDeferredIngest)
```

- Naming rules matter downstream: `parseFilename` (`src/lib/filename-utils.ts`)
  reads date, creator and description back out of the name, and that feeds
  search. Name building (`src/lib/namer/naming.ts`, `name-token.ts`) is
  written to round-trip through it.
- A batch can partially fail; the queue shows per-file reasons with **Retry
  failed**, **Cancel** and **Revert**. The batch queue lives in the tab
  (`src/lib/namer/batch-utils.ts`).
- **Deferred ingest:** so the new files show up without waiting up to 6 hours,
  the batch is ingested after a delay (`namer_auto_ingest_delay_ms`, default
  5 min — time to undo). The intent is kept in `localStorage` *and*
  `app_settings.pending_ingests`, so if the tab closes, the next person to open
  Relay fires it. `/api/sync/ingest` then re-checks each file (still in the
  shared drive? still in scope? not ignored?), upserts it with the same row
  builder as the sync, makes its thumbnail, and logs a `sync_logs` row with
  `source = 'ingest'`. **The ingest does not embed** — it clears stale
  embeddings and the next scheduled sync embeds them.

## Flow 3 — Relays (shortcuts)

A "relay" is a Google Drive shortcut that puts an asset into a project folder
without copying it. `/api/drive/shortcut` creates the shortcut in Drive and a
`shortcuts` row; `/api/drive/shortcut/delete` undoes it.

- **Relays live inside the library.** The destination must be a folder inside
  the synced folders and not `[relay-ignore]`d — deliberately, to keep the
  drive from sprawling. The sync drops rows for shortcuts that were deleted or
  moved out (after the 2-day grace).
- The server resolves the asset and the folder path itself from Drive IDs; the
  browser's `assetId` and path strings are never trusted.
- In the UI, an asset with relays appears in each project folder too: the
  `/api/assets` response carries `[assetId, folderPath]` pairs, and the client
  creates `::sc::` clone entries (`expandAssetList`). The folder sidebar is
  built from both real asset folders and these relay folders.

## Flow 4 — Browsing, search, viewing, downloading

- **Asset list.** On load, the page paints the last list from IndexedDB
  (`src/lib/asset-cache.ts`) immediately, then fetches `/api/assets` (all
  active assets, no embeddings, HTTP-cached 60s) and replaces it. Filtering,
  sorting and keyword search all happen in the browser (`src/app/page.tsx` —
  app state is plain React hooks, no store library); this is comfortable at
  several thousand assets. After the app itself changes something it calls
  `refreshAssets()` to bypass the HTTP cache.
- **Hidden folders** (`hidden_folders`, the eye icon on top-level sidebar
  folders) are purely a view filter: those assets are synced and embedded as
  normal and show when you open that folder, but are left out of the "All
  Folders" view (browsing and search alike). Contrast `[relay-ignore]`, which
  keeps files out of the library entirely.
- **Semantic search.** `/api/search` embeds the query text with the *same*
  Gemini model as the documents and calls the `match_assets` SQL function
  (pgvector cosine similarity, HNSW index). It returns IDs + scores; the
  browser ranks its in-memory list with them. Without Gemini, or if the call
  fails, keyword search carries on alone.
- **Thumbnails** are public Storage URLs. **Video playback** and **downloads**
  stream through the app from Drive (`/api/drive/stream`, `/api/drive/download`)
  using the service account, re-checking that the file is an active asset on
  every request. Multi-file downloads are zipped on the fly (client-zip),
  capped at 1,000 files / 1.5 GiB per zip; single files ≥ 1 GiB hand off to
  Google's own download link, which uses the person's own Drive access.
- **Rights badges** come from the Drive Label fields mapped in
  `rights_label_config` (`src/lib/sync/rights-labels.ts`, `badge-utils.ts`).

---

## Rules that keep it working

These are the invariants that past bugs taught. Break one and something fails
quietly, usually days later.

1. **One implementation per concern, shared by the cron and the app.** Scope
   (`sync/scope.ts`), Drive→row mapping (`sync/drive-file.ts`,
   `sync/asset-row.ts`), thumbnails (`sync/thumbnails.ts`), embeddings
   (`sync/embedder.ts`, `embedding-text.ts`), filename parsing
   (`filename-utils.ts`). If two paths disagree, the next sync "corrects" every
   row the other wrote — e.g. a forked filename parser triggers a full
   re-embed. `src/lib/sync/*` must not use the `@/` import alias: the scripts
   import it by relative path.
2. **Documents and queries use the same embedding model.** Changing
   `EMBED_MODEL` means `npx tsx scripts/embed.ts --force` for the whole library.
3. **Writes are service-role; check that updates hit rows.** Chain
   `.select('id')` after `.update()` when it matters.
4. **Bulk upserts: every row in one request must have the same keys**
   (`groupRowsByColumns`), or omitted columns are set to NULL.
5. **Drive IDs, not path strings,** identify folders. Paths are display values.
6. **Settings can't be empty.** An empty `sync_folders` means "sync the entire
   drive"; an empty `shared_drive_id` switches off the shared-drive checks. The
   settings route rejects both, and `getConfig()` throws rather than fall back
   to env vars when the database is unreachable.
7. **Curation over retention.** Things that leave the library leave Relay
   (with the 14-day trash and the mass-trash limit as the safety net). Only an
   explicit Settings change keeps data around.
8. **Failures are recorded, not alerted.** Anything that goes wrong without
   stopping a run goes into `sync_logs` and shows in Settings → Recent
   Activity and the header badge. GitHub emails on a failed workflow; Relay
   itself has no Slack/email alerting by design.

## Where to look when changing…

| You want to change… | Start in |
|---|---|
| What counts as "in the library" | `src/lib/sync/scope.ts`, `scripts/sync.ts` (`detectOrphans`) |
| Columns stored per asset | `src/lib/sync/asset-row.ts`, `drive-file.ts`, `schema.sql` + migration, `/api/assets` select list, `src/types/index.ts`, bump `asset-cache` `KEY` |
| Search quality | `src/lib/embedding-text.ts` (what's embedded), `semantic_similarity_threshold`, `match_assets` |
| Naming conventions | `src/lib/filename-utils.ts` (parser) + `src/lib/namer/*` (builder) — keep them round-tripping; `tests/` covers both |
| Rights badges | `src/lib/sync/rights-labels.ts`, `src/lib/badge-utils.ts`, `ComplianceBadge.tsx` |
| Sync schedule / timeouts | `.github/workflows/daily-sync.yml` (keep the job < 60 min: the Drive token lasts an hour) |
| Who can sign in | Google OAuth consent screen (outside the code); `AUTH_ALLOWED_*` env vars |
| Download limits | `src/lib/download/shared.ts` |
