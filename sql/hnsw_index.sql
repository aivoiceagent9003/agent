-- sql/hnsw_index.sql
-- Vector index for knowledge_base retrieval.
--
-- We use HNSW (not IVFFlat) deliberately. In a multi-tenant RAG every query is
-- `... WHERE tenant_id = X ORDER BY embedding <=> q LIMIT k`. IVFFlat probes only
-- a few clusters and then filters by tenant, which silently tanks recall (a
-- tenant's chunks are scattered across clusters). HNSW does filtered graph
-- traversal with good recall, needs no centroid retraining as clients/chunks
-- grow, and scales smoothly to hundreds of tenants.
--
-- Requires pgvector >= 0.5.0. Check with:
--   select extversion from pg_extension where extname = 'vector';

drop index if exists kb_embedding_idx;

create index if not exists kb_embedding_idx
  on public.knowledge_base
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- Optional: raise per-query recall (default ef_search = 40). Higher = better
-- recall, slightly slower. Best set inside the match_knowledge function:
--   set local hnsw.ef_search = 60;
