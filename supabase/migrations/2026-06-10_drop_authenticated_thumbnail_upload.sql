-- Migration: drop the authenticated-client upload policy on the thumbnails bucket
-- Date: 2026-06-10
--
-- Context: all thumbnail uploads go through server routes and the sync pipeline
-- using the service role key (which bypasses RLS). The "Authenticated users can
-- upload thumbnails" INSERT policy is therefore unused — but it lets any
-- signed-in browser session write arbitrary objects into the public bucket
-- with the anon key. Dropping it closes that gap; public SELECT is preserved
-- (thumbnail URLs are public by design).
--
-- Apply in the Supabase SQL Editor (Dashboard -> SQL Editor).

drop policy if exists "Authenticated users can upload thumbnails" on storage.objects;
