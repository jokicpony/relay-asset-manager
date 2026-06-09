-- Migration: lock down write access on assets + app_settings
-- Date: 2026-06-08
--
-- Context: assets and app_settings previously granted INSERT/UPDATE to any
-- authenticated user. A signed-in browser session (anon key + user JWT) could
-- therefore write directly to those tables, bypassing the server-side key
-- allowlist in /api/settings/config and tampering with the library or with
-- operational config (shared_drive_id, sync_folders, rights_label_config, ...).
--
-- All legitimate writes already go through server routes and the sync pipeline
-- using the service role key, which bypasses RLS. These client write policies
-- are therefore unnecessary and are dropped here. SELECT policies are preserved
-- (the /api/assets route reads via the user's authenticated client).
--
-- Apply in the Supabase SQL Editor (Dashboard -> SQL Editor).

drop policy if exists "Authenticated users can insert assets" on public.assets;
drop policy if exists "Authenticated users can update assets" on public.assets;

drop policy if exists "Authenticated users can update settings" on app_settings;
drop policy if exists "Authenticated users can insert settings" on app_settings;

-- shortcuts: writes move to service-role only (routes updated to match).
-- The CLAUDE.md gotcha already documented this as the intended posture.
drop policy if exists "Users can create shortcuts" on public.shortcuts;
drop policy if exists "Users can delete shortcuts" on public.shortcuts;
