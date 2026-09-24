-- sync_logs becomes the activity log for both ingestion paths.
--
-- source:  'cron'   — the scheduled GitHub Actions sync (scripts/sync.ts)
--          'ingest' — the in-app targeted ingest after a Namer batch
-- details: structured problems and context for the run, e.g.
--          { "problems": [{ "step": "embeddings", "count": 3, "message": "..." }],
--            "run_url": "https://github.com/.../actions/runs/123",   -- cron
--            "user": "someone@example.com", "errors": [...], "skipped": [...] }  -- ingest
--
-- Existing rows become 'cron'. Settings' "latest sync" reads source = 'cron';
-- the Recent activity list reads both.
--
-- Apply manually in the Supabase SQL Editor BEFORE deploying the code that
-- writes these columns. Safe to re-run.

alter table public.sync_logs
    add column if not exists source text not null default 'cron',
    add column if not exists details jsonb default null;

create index if not exists idx_sync_logs_source_finished
    on public.sync_logs (source, finished_at desc);
