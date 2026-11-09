-- Hybrid search for Open Brain: keyword ranking fused with vector ranking.
-- Fork-local (ICU Media Design deployment), 2026-11-10. Run once in the Supabase SQL editor.
--
-- Why: vector-only search misses questions that hinge on exact names and dates
-- ("ICUMD", "Ben's Trees", "2026-07-02"), because meaning-based similarity does not reward a
-- shared rare word. On 32 test questions it put the right source in the top 3 for 24;
-- fusing in BM25 keyword ranking raised that to 32 in an offline evaluation. See
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

-- 2. Reciprocal rank fusion of two rankings. A row's score is the sum of 1 / (rrf_k + rank)
--    over each list it appears in, so a row near the top of either list scores well, and one
--    near the top of both scores best. rrf_k = 60 is the standard value from the original RRF
--    paper; it was not tuned on the test questions.
--
--    The keyword ranking weights each word by its rarity (BM25's inverse document frequency)
--    times its ts_rank frequency score in the document, normalised for document length.
--    Postgres's plain ts_rank_cd has no rarity weighting: every word counts the same, so "icu"
--    (in nearly every document, via "ICU Media Design") weighed as much as "relay". The first
--    version of this function used it and scored 18 of 32 golden questions, worse than
--    vector-only search (29).
--
--    Performance history, because it bit twice: a textbook BM25 that unnested every candidate
--    document's tsvector took 24.5 s inside the function (the planner inlined the per-word
--    weights and recomputed them per row) and 3.4 s on a long question even once fixed, against
--    an 8 s statement timeout. This version touches only (word, document) pairs found through
--    the GIN index, and the small CTEs are MATERIALIZED so each is computed once.
--
--    The keyword list matches ANY of the question's words (OR). An AND match would demand every
--    word ("why", "deploy", "target"...) appear in one document. Stopwords are already dropped
--    by the 'english' configuration.
--
--    `similarity` is still the cosine similarity, so callers can show it as before. A row that
--    only the keyword list found keeps its (lower) similarity, and is returned anyway: that is
--    the case this function exists for.
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
language plpgsql
stable
as $fn$
begin
  -- EXECUTE ... USING plans the query fresh with the actual values on every call. As a plain SQL
  -- function the body was planned with placeholders and ran 1.1 s where the same query run
  -- standalone took 0.2 s. $1 query_text, $2 query_embedding, $3 match_count, $4 filter, $5 rrf_k.
  return query execute $q$
    with semantic as (
      select t.id, row_number() over (order by t.embedding <=> $2) as rank
      from public.thoughts t
      where t.embedding is not null
        and ($4 = '{}'::jsonb or t.metadata @> $4)
      order by t.embedding <=> $2
      limit 50
    ),
    terms as materialized (
      select distinct u.lexeme from unnest(to_tsvector('english', $1)) as u
    ),
    -- One row per (word, document containing it), found through the GIN index one word at a
    -- time, with that word's frequency score in that document.
    term_docs as materialized (
      select te.lexeme, t.id, ts_rank(t.fts, quote_literal(te.lexeme)::tsquery, 1) as tf
      from terms te
      join public.thoughts t on t.fts @@ quote_literal(te.lexeme)::tsquery
      where $4 = '{}'::jsonb or t.metadata @> $4
    ),
    idf as materialized (
      select d.lexeme, ln(1 + (s.n - count(*) + 0.5) / (count(*) + 0.5)) as idf
      from term_docs d
      cross join (select count(*)::float as n from public.thoughts) s
      group by d.lexeme, s.n
    ),
    bm25 as (
      select d.id, sum(i.idf * d.tf) as score
      from term_docs d
      join idf i on i.lexeme = d.lexeme
      group by d.id
    ),
    keyword as (
      select b.id, row_number() over (order by b.score desc) as rank
      from bm25 b
      order by b.score desc
      limit 50
    ),
    fused as (
      select coalesce(s.id, k.id) as id,
             coalesce(1.0 / ($5 + s.rank), 0) + coalesce(1.0 / ($5 + k.rank), 0) as score
      from semantic s
      full outer join keyword k on k.id = s.id
    )
    select t.id, t.content, t.metadata,
           1 - (t.embedding <=> $2) as similarity,
           t.created_at
    from fused f
    join public.thoughts t on t.id = f.id
    order by f.score desc
    limit $3
  $q$
  using query_text, query_embedding, match_count, filter, rrf_k;
end;
$fn$;
