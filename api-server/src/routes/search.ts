/**
 * POST /api/search
 *
 * Instant hybrid search over already-stored opportunity records: PostgreSQL full-text search plus the existing
 * opportunity vector index, fused with Reciprocal Rank Fusion, with only the fused top-N semantically reranked
 * (see lib/search/localSearch.ts and hybridFusion.ts). No crawlers, scrapers, or extraction LLMs are called; when
 * the vector store or reranker is unavailable the search degrades to lexical order and says so in `diagnostics`.
 *
 * Optional body fields: `rrfK` (RRF constant, default 60) and `rerankTopN` (default 20, 0 disables rerank).
 *
 * Contrast with:
 *   - POST /opportunities/fetch — ingestion/crawler path that hits live
 *     external sources (Serper, Exa, Firecrawl, Jina, Olostep,
 *     Cloudflare Worker, Gemini, Groq, OpenRouter, etc.)
 *   - unifiedFetch / webIntelligenceFetch — full crawler/scraper pipelines
 *
 * This is the fast path for searching data that has already been ingested.
 */

import { Router } from "express";
import { searchOpportunities } from "../lib/search/localSearch";

const router = Router();

function boundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

router.post("/search", async (req, res) => {
  try {
    const { query, limit, filters, rrfK, rerankTopN } = req.body as {
      query?: string;
      limit?: number;
      filters?: {
        source?: string;
        agency?: string;
        state?: string;
        dateRange?: number;
        activeOnly?: boolean;
      };
      rrfK?: number;
      rerankTopN?: number;
    };

    if (!query || typeof query !== "string" || query.trim().length === 0) {
      return res.status(400).json({ error: "query is required and must be a non-empty string" });
    }

    const result = await searchOpportunities(
      query.trim(),
      typeof limit === "number" && limit > 0 ? Math.min(limit, 100) : 50,
      filters ?? {},
      { rrfK: boundedInteger(rrfK, 1, 1_000), rerankTopN: boundedInteger(rerankTopN, 0, 100) },
    );

    return res.json(result);
  } catch (err: any) {
    req.log.error(err);
    return res.status(500).json({ error: "Search failed", details: err.message });
  }
});

export default router;
