-- ============================================================
-- Relay Asset Manager — Complete Database Schema
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor)
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. Extensions
-- ────────────────────────────────────────────────────────────

-- pgvector for semantic search embeddings
create extension if not exists vector with schema extensions;


-- ────────────────────────────────────────────────────────────
-- 2. Assets table — the master library
-- ────────────────────────────────────────────────────────────

create table public.assets (
    id              uuid primary key default gen_random_uuid(),
    drive_file_id   text unique not null,
    name            text not null,
    description     text,
    mime_type       text not null,
    asset_type      text not null check (asset_type in ('photo', 'video')),
    folder_path     text not null,
    thumbnail_url   text,
    preview_url     text,                                         -- video stream URL
    width           int not null default 0,
    height          int not null default 0,
    duration        float,                                        -- video only, seconds

    -- Rights / Compliance (from Drive Labels)
    organic_rights            text check (organic_rights in ('unlimited', 'limited', 'expired')),
    organic_rights_expiration timestamptz,
    paid_rights               text check (paid_rights in ('unlimited', 'limited', 'expired')),
    paid_rights_expiration    timestamptz,

    -- Metadata — Drive Label overrides
    creator               text,                                   -- photographer, videographer, etc.
    project_description   text,                                   -- project/product description string

    -- Metadata — parsed from filename convention (YYYYMMDD_Creator_Desc_###.ext)
    parsed_creator           text,
    parsed_shoot_date        date,
    parsed_shoot_description text,

    -- Tags
    tags            text[] default '{}',

    -- Gemini embedding (nullable — videos may lack descriptions)
    embedding       vector(768),

    -- Soft delete (14-day trash queue)
    deleted_at      timestamptz default null,
    deleted_reason  text check (deleted_reason in ('orphaned', 'ignored')),

    -- Drive timestamps (preserved from Google Drive, separate from Supabase auto-timestamps)
    drive_created_at  timestamptz,
    drive_modified_at timestamptz,
    file_size         bigint,

    -- System
    created_at      timestamptz default now(),
    updated_at      timestamptz default now(),
    is_active       boolean default true
);


-- ────────────────────────────────────────────────────────────
-- 3. Assets indexes
-- ────────────────────────────────────────────────────────────

create index idx_assets_embedding on public.assets
    using ivfflat (embedding vector_cosine_ops) with (lists = 100);

create index idx_assets_shoot_date on public.assets (parsed_shoot_date);
create index idx_assets_creator    on public.assets (parsed_creator);
create index idx_assets_folder     on public.assets (folder_path);
create index idx_assets_active     on public.assets (is_active);
create index idx_assets_drive_id   on public.assets (drive_file_id);

-- Partial index: only index rows in the trash queue
create index idx_assets_deleted_at on public.assets (deleted_at)
    where deleted_at is not null;


-- ────────────────────────────────────────────────────────────
-- 4. Shortcuts table — one asset can live in many project folders
-- ────────────────────────────────────────────────────────────

create table public.shortcuts (
    id                      uuid primary key default gen_random_uuid(),
    shortcut_drive_id       text unique not null,                 -- Drive ID of the shortcut file
    target_asset_id         uuid not null references public.assets(id) on delete cascade,
    project_folder_path     text not null,                        -- e.g. /Special Projects/Q1 Campaign
    project_folder_drive_id text not null,                        -- Drive ID of the containing folder
    created_at              timestamptz default now()
);

create index idx_shortcuts_target on public.shortcuts (target_asset_id);
create index idx_shortcuts_folder on public.shortcuts (project_folder_drive_id);


-- ────────────────────────────────────────────────────────────
-- 5. Sync logs — one row per sync run for the settings dashboard
-- ────────────────────────────────────────────────────────────

create table public.sync_logs (
    id                   uuid primary key default gen_random_uuid(),
    started_at           timestamptz not null,
    finished_at          timestamptz not null,
    duration_secs        float not null,

    -- Asset counts
    assets_found         int not null default 0,
    assets_upserted      int not null default 0,
    upsert_errors        int not null default 0,
    thumbnails_uploaded  int default 0,
    thumbnail_errors     int default 0,
    soft_deleted         int not null default 0,
    restored             int not null default 0,
    purged               int not null default 0,
    re_embedded          int not null default 0,
    skipped_by_folder    int not null default 0,
    skipped_by_ignore    int not null default 0,

    -- Shortcut tracking
    shortcuts_resolved   int not null default 0,
    shortcuts_failed     int not null default 0,
    shortcuts_orphaned   int not null default 0,

    -- Folder info
    ignored_folders      jsonb default '[]',                      -- [{name, path}]
    master_folders       jsonb default '[]',                      -- ["Photo Library", ...]

    -- Status
    status               text not null default 'success'
                         check (status in ('success', 'partial', 'failed')),
    error_message        text,

    created_at           timestamptz default now()
);

create index idx_sync_logs_finished on public.sync_logs (finished_at desc);


-- ────────────────────────────────────────────────────────────
-- 6. App settings — key-value config editable from the UI
-- ────────────────────────────────────────────────────────────

create table if not exists app_settings (
    key         text primary key,
    value       jsonb not null,
    updated_at  timestamptz default now(),
    updated_by  text                                              -- email of who last changed it
);


-- ────────────────────────────────────────────────────────────
-- 7. Row-Level Security
-- ────────────────────────────────────────────────────────────

-- Assets
alter table public.assets enable row level security;

create policy "Users can view assets"
    on public.assets for select to authenticated using (true);

create policy "Authenticated users can insert assets"
    on public.assets for insert to authenticated with check (true);

create policy "Authenticated users can update assets"
    on public.assets for update to authenticated
    using (true) with check (true);

-- Shortcuts
alter table public.shortcuts enable row level security;

create policy "Users can view shortcuts"
    on public.shortcuts for select to authenticated using (true);

create policy "Users can create shortcuts"
    on public.shortcuts for insert to authenticated with check (true);

create policy "Users can delete shortcuts"
    on public.shortcuts for delete to authenticated using (true);

-- Sync logs
alter table public.sync_logs enable row level security;

create policy "Authenticated users can read sync_logs"
    on public.sync_logs for select using (auth.role() = 'authenticated');

-- App settings
alter table app_settings enable row level security;

create policy "Authenticated users can read settings"
    on app_settings for select using (auth.role() = 'authenticated');

create policy "Authenticated users can update settings"
    on app_settings for update using (auth.role() = 'authenticated');

create policy "Authenticated users can insert settings"
    on app_settings for insert with check (auth.role() = 'authenticated');

-- Service role (used by sync pipeline) bypasses RLS automatically.


-- ────────────────────────────────────────────────────────────
-- 8. Functions & Triggers
-- ────────────────────────────────────────────────────────────

-- Auto-update updated_at on row changes
create or replace function public.handle_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

create trigger on_assets_updated
    before update on public.assets
    for each row
    execute function public.handle_updated_at();

-- Semantic search: match assets by cosine similarity
create or replace function match_assets(
  query_embedding vector(768),
  match_count int default 20,
  similarity_threshold float default 0.0
)
returns table (id uuid, similarity float)
language sql stable
as $$
  select
    assets.id,
    1 - (assets.embedding <=> query_embedding) as similarity
  from assets
  where assets.embedding is not null
    and assets.is_active = true
    and 1 - (assets.embedding <=> query_embedding) > similarity_threshold
  order by assets.embedding <=> query_embedding
  limit match_count;
$$;


-- ────────────────────────────────────────────────────────────
-- 9. Storage bucket for thumbnails
-- ────────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public)
values ('thumbnails', 'thumbnails', true)
on conflict (id) do nothing;

create policy "Public thumbnail access"
    on storage.objects for select to public
    using (bucket_id = 'thumbnails');

create policy "Authenticated users can upload thumbnails"
    on storage.objects for insert to authenticated
    with check (bucket_id = 'thumbnails');
