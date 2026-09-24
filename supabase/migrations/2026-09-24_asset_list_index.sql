-- Indexes matching how the assets table is actually queried.
--
-- Add: /api/assets reads every active asset ordered by
--   (folder_path, name, id) in 1000-row pages. Without a matching index each
--   page sorts the whole table; this partial index serves the filter and the
--   order directly.
-- Drop: idx_assets_drive_id duplicates the index behind the UNIQUE
--   constraint on drive_file_id (pure write overhead), and idx_assets_active
--   is a low-selectivity boolean index the planner rarely uses — active-row
--   queries use the new partial index, trash queries use
--   idx_assets_deleted_at.
--
-- Apply manually in the Supabase SQL Editor. Safe to re-run. Order is
-- deliberate: the new index exists before the old ones are dropped.

create index if not exists idx_assets_active_folder_name
    on public.assets (folder_path, name, id)
    where is_active;

drop index if exists public.idx_assets_drive_id;
drop index if exists public.idx_assets_active;
