-- Replace the ivfflat embedding index with HNSW, and let match_assets
-- actually return the result count the app asks for.
--
-- Why: the ivfflat index (lists = 100) was created by schema.sql on an empty
-- table. ivfflat computes its list centroids at build time, so with no data
-- they are meaningless, and at query time pgvector scans only `probes`
-- (default 1) of the 100 lists. Semantic search was therefore looking at a
-- small, arbitrary slice of the library and missing good matches.
--
-- HNSW needs no training data, keeps recall as rows are added, and doesn't
-- need rebuilding as the library grows. hnsw.ef_search (default 40) caps how
-- many candidates a query can return, below the app's limit of 100 — so
-- match_assets raises it to 200 for its own queries.
--
-- Safe to re-run. Building the index on ~7k rows takes seconds; semantic
-- search keeps working during the build (it just falls back to a scan).
--
-- Apply manually in the Supabase SQL Editor.

drop index if exists public.idx_assets_embedding;

create index if not exists idx_assets_embedding_hnsw on public.assets
    using hnsw (embedding vector_cosine_ops);

create or replace function match_assets(
  query_embedding vector(768),
  match_count int default 20,
  similarity_threshold float default 0.0
)
returns table (id uuid, similarity float)
language sql stable
set hnsw.ef_search = 200
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
