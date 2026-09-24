-- Adds assets.thumb_color — the thumbnail's dominant colour (#rrggbb), painted
-- as the grid card's background while the thumbnail image loads, instead of
-- a flat grey block.
--
-- Written by the sync and the in-app ingest whenever they generate a
-- thumbnail, and by the custom-thumbnail route. Existing rows are filled by
-- `npx tsx scripts/backfill-thumb-colors.ts`.
--
-- Apply manually in the Supabase SQL Editor BEFORE deploying the code that
-- reads it (/api/assets selects this column). Safe to re-run.

alter table public.assets
    add column if not exists thumb_color text default null;
