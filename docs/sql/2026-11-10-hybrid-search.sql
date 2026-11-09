-- Hybrid search for Open Brain: keyword ranking fused with vector ranking.
-- Fork-local (ICU Media Design deployment), 2026-11-10. Run once in the Supabase SQL editor.
--
-- Why: vector-only search misses questions that hinge on exact names and dates
-- ("ICUMD", "Ben's Trees", "2026-07-02"), because meaning-based similarity does not reward a
-- shared rare word. On 32 test questions it put the right source in the top 3 for 24;
-- fusing in keyword ranking raised that to 27 in an offline evaluation. See
-- docs/maintenance-playbook.md, "Hybrid search".
--
-- Safe to re-run. It only ADDS: one generated column, one index, one function. The
-- thoughts table's existing columns and match_thoughts are untouched, so anything still
-- calling match_thoughts keeps working, and the MCP function falls back to it on error.

-- 1. A keyword index over content. Generated, so every insert or update keeps it current
--    without the sync or capture_thought knowing it exists.
alter table public.thoughts
  add column if not exists fts tsvector
  generated always as (to_tsvector('english', coalesce(content, ''))) stored;

create index if not exists thoughts_fts_idx on public.thoughts using gin (fts);

-- 2. Reciprocal rank fusion of the two rankings. A row's score is the sum of
--    1 / (rrf_k + rank) over each list it appears in, so a row near the top of either list
--    scores well, and one near the top of both scores best. rrf_k = 60 is the standard value
--    from the original RRF paper; it was not tuned on the test questions.
--
--    The keyword query ORs the question's words. plainto_tsquery ANDs them, which would
--    demand every word ("why", "deploy", "target"...) appear in one document.
--
--    `similarity` is still the cosine similarity, so callers can show it as before. A row
--    that only the keyword list found keeps its (lower) similarity, and is returned anyway:
--    that is the case this function exists for.
create or replace function public.hybrid_match_thoughts(
  query_text text,
  query_embedding vector(1536),
  match_count int default 10,
  filter jsonb default '{}'::jsonb,
  rrf_k int default 60
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  similarity float,
  created_at timestamptz
)
language sql
stable
as $$
  with keyword_query as (
    select nullif(replace(plainto_tsquery('english', query_text)::text, '&', '|'), '')::tsquery as q
  ),
  semantic as (
    select t.id, row_number() over (order by t.embedding <=> query_embedding) as rank
    from public.thoughts t
    where t.embedding is not null
      and (filter = '{}'::jsonb or t.metadata @> filter)
    order by t.embedding <=> query_embedding
    limit 50
  ),
  keyword as (
    select t.id, row_number() over (order by ts_rank_cd(t.fts, kq.q, 1) desc) as rank
    from public.thoughts t, keyword_query kq
    where kq.q is not null
      and t.fts @@ kq.q
      and (filter = '{}'::jsonb or t.metadata @> filter)
    order by ts_rank_cd(t.fts, kq.q, 1) desc
    limit 50
  ),
  fused as (
    select coalesce(s.id, k.id) as id,
           coalesce(1.0 / (rrf_k + s.rank), 0) + coalesce(1.0 / (rrf_k + k.rank), 0) as score
    from semantic s
    full outer join keyword k on k.id = s.id
  )
  select t.id, t.content, t.metadata,
         1 - (t.embedding <=> query_embedding) as similarity,
         t.created_at
  from fused f
  join public.thoughts t on t.id = f.id
  order by f.score desc
  limit match_count;
$$;
