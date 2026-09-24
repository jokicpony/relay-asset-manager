# Database migrations

**Fresh install?** You don't need these. Run `supabase/schema.sql` once in
the Supabase SQL Editor — it creates the complete, current schema and is
safe to re-run.

**Upgrading an existing install?** Run the files below that you haven't
applied yet, in order, in the SQL Editor. Every migration is idempotent: if
you're not sure which ones you've run, run them all — re-running one is a
no-op.

Apply migrations **before** deploying the code they belong to. Where it
matters, the table says so: the new code reads or writes the new columns and
fails without them.

| Migration | What it does | Before deploying code that… |
|---|---|---|
| `2026-06-08_lockdown_write_rls.sql` | Removes browser (anon-key) write access to `assets`, `shortcuts`, `app_settings`; all writes go through the server | — (tightens security; safe anytime) |
| `2026-06-10_drop_authenticated_thumbnail_upload.sql` | Removes browser upload access to the `thumbnails` bucket | — |
| `2026-07-02_add_out_of_scope_deleted_reason.sql` | Adds the `out-of-scope` trash reason | records out-of-scope trash (the sync) |
| `2026-07-02_add_shortcuts_missing_since.sql` | Adds `shortcuts.missing_since` (grace period before deleting shortcuts) | runs the shortcut grace period (the sync) |
| `2026-09-24_hnsw_embedding_index.sql` | Replaces the ivfflat embedding index with HNSW; lets search return 100 results | — (improves search; safe anytime) |
| `2026-09-24_add_thumb_color.sql` | Adds `assets.thumb_color` (placeholder colour); then run `npx tsx scripts/backfill-thumb-colors.ts --apply` | **required** — `/api/assets` selects it |
| `2026-09-24_sync_logs_source_details.sql` | Adds `sync_logs.source` / `details` (activity log for sync + ingest) | **required** — the sync, ingest and Settings use it |
| `2026-09-24_asset_list_index.sql` | Index for the asset list's sort order; drops two redundant indexes | — (performance; safe anytime) |

## Adding a migration

1. Add `YYYY-MM-DD_what_it_does.sql` here, idempotent (`if not exists`,
   `drop … if exists`, `create or replace`).
2. Make the same change in `supabase/schema.sql`, so fresh installs get it.
3. Add a row to the table above.
4. `npm test` — `tests/schema.test.ts` fails if a fresh install from
   `schema.sql` and an upgrade through these migrations (starting from the
   first release's schema, `tests/fixtures/schema-at-first-release.sql`)
   don't produce the same database, or if any migration isn't safe to
   re-run.
