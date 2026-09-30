---
status: proposed
date: 2026-09-29
---

# Hybrid search: Postgres full-text and pgvector with reciprocal rank fusion

## Context

[#1](https://github.com/CuriouslyCory/hive-mind/issues/1) needs search over plans, plan log entries, ADRs, and Session intents and summaries, with p50 under 250 ms and p95 under 600 ms from CLI invocation to printed results, and without a separate search service. Open question 6 asks which embedding provider to use: OpenAI `text-embedding-3-small` through Vercel AI Gateway, or another provider or model such as Voyage. The M0 plan ([#2](https://github.com/CuriouslyCory/hive-mind/issues/2)) assigns search to M5. M0 builds none of it, so this ADR is proposed.

## Decision

Proposed, owned by M5:

- A `search_chunk` table holds markdown chunks split on headings (about 300–500 tokens), a generated `tsvector` with a GIN index, and an embedding column with an HNSW index.
- One SQL statement combines `websearch_to_tsquery` rank and pgvector cosine distance with reciprocal rank fusion, filtered by Project and optionally by type or status.
- Indexing runs after writes with Next.js `after()`. A chunk is re-embedded only when its content hash changes.
- Query embeddings are cached. If embedding the query takes longer than 200 ms, search returns lexical-only results and says so.
- The embedding provider is left open (#1's open question 6).

## Consequences

- The CI Postgres image (`pgvector/pgvector:pg18`) already ships pgvector, not enabled. M5 adds the `CREATE EXTENSION vector` migration and doesn't change CI (ADR-0008).
- That migration runs in the Vercel build against production like any other (ADR-0004), so it must be additive.
- The embedding column's dimension depends on the model; #1's `vector(1536)` assumes `text-embedding-3-small`. Changing models later means re-embedding every chunk.
- M5 must decide:
  - the embedding provider and model, which answers #1's open question 6;
  - the vector dimension;
  - the eval fixtures and the recall@5 and latency thresholds CI enforces.
- M5 accepts this ADR, amends it, or supersedes it.
