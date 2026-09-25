# Runbook — when something goes wrong

Start at **Settings → Recent Activity**. Every scheduled sync and every in-app
ingest (after a Namer batch) records a row there: OK, Partial or Failed, with
the reason. Click a row for details; scheduled syncs link to their full GitHub
Actions log.

The header shows **⚠ Sync failed** or **⚠ Sync overdue** when the latest
scheduled sync failed, or none has succeeded in 13 hours.

## The scheduled sync failed

1. Open the row in Recent Activity → **GitHub log ↗**.
2. Common causes:
   - **Google auth** (WIF) — the log fails at "Authenticate to Google Cloud".
     Check the `GCP_*` repository variables and the service account's access.
   - **Supabase** — errors mentioning PostgREST / relation / column. A
     missing column usually means a migration wasn't applied; see
     `supabase/migrations/README.md`.
   - **Timed out / cancelled** — recorded with the last step it reached. A
     large thumbnail or embedding backlog is time-boxed and should finish on
     later runs; if it keeps timing out, run manually with `skip_thumbnails`.
3. Re-run: Actions → Daily Sync → Run workflow. Runs never overlap, so this is
   safe while another is queued.

## A sync says "Partial"

Something failed without stopping the run; the details list each problem by
step (thumbnails, embeddings, upsert, orphans, shortcuts, purge). Most retry on
their own next run: thumbnails that weren't generated, embeddings that didn't
complete. Persistent ones point at the cause (e.g. a Gemini quota).

**"Skipped trashing N assets … mass-orphan safety limit"** — a sync would have
trashed an unusually large number of assets. Usually a synced top-level folder
was renamed or moved: rename it back, or update Sync Folders in Settings →
Advanced. Only if the files really were deleted, run the workflow manually
with `allow_mass_orphan` checked.

## Assets are missing, or wrongly in the Trash

- Trashed assets stay in Settings → Trash for 14 days and can be restored.
  Files deleted in Drive, moved out of the synced folders, or moved into a
  `[relay-ignore]` folder are purged after that. Only assets whose whole
  top-level folder was removed from Sync Folders in Settings are kept
  indefinitely (and come back if the folder is re-added).
- Relays follow the same idea: a relay disappears from Relay within 2 days of
  its shortcut being deleted or its project folder being moved out of the
  synced folders. New relays can only target folders inside them.
- A folder tagged `[relay-ignore]` in its Drive description is excluded with
  everything under it.
- To see what a sync *would* do without changing anything: run the workflow
  with `dry_run` — the planned changes are attached to the run as
  `sync-plan-<sha>`.

## A Namer batch or its ingest failed

- The Namer queue shows each file's reason; **Retry failed** re-runs only
  what failed and never renames or moves a file twice. **Retry revert**
  finishes a partial revert.
- The ingest into the library appears in Recent Activity as a "Namer ingest"
  row with per-file errors and skips (e.g. "Not in sync scope"). Anything it
  missed is picked up by the next scheduled sync.

## Search results look wrong or thin

- New and changed assets are embedded by the scheduled sync; a Gemini quota
  problem shows up as a Partial run with an "embeddings" problem.
- To rebuild everything: `npx tsx scripts/embed.ts --force` (slow; costs
  Gemini quota).

## Before changing the sync

Run a dry run on the current code and on your change, and diff the two plan
files. Refactors should produce identical plans.
