-- Adds 'out-of-scope' to the assets.deleted_reason CHECK constraint.
--
-- Assets whose top-level folder is removed from the sync_folders allowlist
-- are soft-deleted with this reason and are EXEMPT from the 14-day purge:
-- the files still exist in Drive, so hard-deleting the rows would destroy
-- embeddings and thumbnails that would all need regenerating if the folder
-- is ever re-scoped. Re-adding the folder restores them on the next sync.
--
-- Apply manually in the Supabase SQL Editor.

-- Drop the existing check by whatever name it carries (inline column checks
-- are auto-named, so don't assume assets_deleted_reason_check).
do $$
declare
    cname text;
begin
    select conname into cname
    from pg_constraint
    where conrelid = 'public.assets'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%deleted_reason%';
    if cname is not null then
        execute format('alter table public.assets drop constraint %I', cname);
    end if;
end $$;

alter table public.assets
    add constraint assets_deleted_reason_check
    check (deleted_reason in ('orphaned', 'ignored', 'out-of-scope'));
