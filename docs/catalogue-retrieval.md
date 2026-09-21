# Catalogue questions and recommendations

`search_knowledge` accepts `mode: "overview"` for recommendations, available
options, variants and comparisons. Older calls without this parameter also use
overview retrieval when their English query contains those intents. Specific
product questions retain the normal detail path.

Overview retrieval combines:

- Named introductions found across the tenant's stored chunks, rather than only
  the top three vector matches. This supports combined product brochures.
- Up to six relevant detail excerpts, preferring different named products before
  repeated passages about one product, from up to sixty vector candidates.
- Explicit coverage limits: neither the name index nor the excerpts establish an
  exhaustive catalogue, product ranking, suitability or unsupported benefits.

The current name extractor recognizes `Introduction "Product Name"` (including
curly quotes). This format is present in the uploaded GSK brochure: the read-only
check found eighty named entries, including twenty term-plan entries. Other
document formats fall back to sampled retrieval; they need additional explicit
title extraction or structured catalogue metadata before coverage can be claimed.
The scan is capped at 5,000 chunks and the displayed list at forty names; truncation
is labelled in tool context. No re-upload or schema migration is required.

A variants question containing a known suffix is widened only when the indexed
titles demonstrate sibling names. Business/variant facts still require supporting
excerpts. The model is instructed to explain a relevant choice, ask one missing
suitability question when needed, and avoid a brochure offer as its first answer.

Run `node scripts/recommendation-eval.mjs "GSK insurance"` to inspect extracted
names with read-only database access. Adding `--live` additionally sends tenant
configuration and retrieved excerpts to the configured LLM and queries to the
embedding service; it exposes only the KB tool, never messaging or calling tools.

Local automated checks cover catalogue breadth, category separation, variants,
sampling limits, tenant isolation, cold retrieval, and cache separation. Listening
quality and generated recommendations require a separately authorized live replay
or a test call; passing retrieval tests does not establish natural speech quality.
