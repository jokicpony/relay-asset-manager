-- Adds shortcuts.missing_since — a grace period before orphaned shortcut
-- rows are hard-deleted.
--
-- Previously the sync hard-deleted any shortcut row not seen in the current
-- Drive listing, so a transient listing anomaly (partial page, API hiccup)
-- wiped the table: relay badges and virtual project folders vanished, and
-- the shortcut-delete route's tracked-shortcut authorization stopped
-- recognizing legitimate shortcuts until the next sync rebuilt the rows.
--
-- Now the sync marks undiscovered rows with missing_since, clears the mark
-- when they reappear, and deletes only rows missing for 2+ days (see
-- SHORTCUT_GRACE_DAYS in src/lib/sync/constants.ts). Marked rows are still
-- served to the app, so a genuine Drive-side deletion can linger up to the
-- grace period before its badge disappears.
--
-- Apply manually in the Supabase SQL Editor.

alter table public.shortcuts
    add column if not exists missing_since timestamptz default null;
