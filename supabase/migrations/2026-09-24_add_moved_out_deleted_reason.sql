-- Adds 'moved-out' to the assets.deleted_reason CHECK constraint.
--
-- A file the sync still finds in Drive, but that was moved out of the synced
-- folders, is trashed as 'moved-out' and purged after 14 days like a deleted
-- file — moving a file out of the library is a curation decision. (Before,
-- such files were misclassified by their old path.) 'out-of-scope' stays for
-- the different case of a whole top-level folder removed from Sync Folders in
-- Settings: a config change, kept indefinitely so it can be undone for free.
--
-- Apply manually in the Supabase SQL Editor BEFORE deploying the sync that
-- writes this reason. Safe to re-run.

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
    check (deleted_reason in ('orphaned', 'ignored', 'out-of-scope', 'moved-out'));
