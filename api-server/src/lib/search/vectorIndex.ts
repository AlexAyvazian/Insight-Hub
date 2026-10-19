import { createHash } from "crypto";
import type { NormalizedOpportunity } from "../providers/types";
import { qdrantProvider } from "../providers/qdrant";
import { pineconeProvider } from "../providers/pinecone";
import { embedTexts, type EmbeddingProviderName } from "./embeddings";
import { RetrievalMethodError, type MethodRetrieval } from "./hybridFusion";

export interface VectorIndexStats {
  attempted: number;
  indexed: number;
  provider: string | null;
  vectorStore: "qdrant" | "pinecone" | null;
  errors: string[];
}

export interface VectorIndexDocument {
  id: string;
  text: string;
  payload: Record<string, unknown>;
}

export interface VectorIndexOptions {
  qdrantCollection?: string;
  pineconeNamespace?: string;
  batchSize?: number;
}

const DEFAULT_BATCH_SIZE = 24;

export function opportunityVectorText(opp: NormalizedOpportunity): string {
  return [
    opp.title,
    opp.agency,
    opp.subAgency,
    opp.type,
    opp.naicsCode,
    opp.naicsDescription,
    opp.setAside,
    opp.placeOfPerformance,
    opp.description,
    opp.solicitationNumber,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 4_000);
}

function compactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      compact[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      compact[key] = value;
      continue;
    }
    compact[key] = JSON.stringify(value).slice(0, 2_000);
  }
  return compact;
}

export async function indexVectorDocuments(
  documents: VectorIndexDocument[],
  options: VectorIndexOptions = {},
): Promise<VectorIndexStats> {
  const stats: VectorIndexStats = {
    attempted: documents.length,
    indexed: 0,
    provider: null,
    vectorStore: null,
    errors: [],
  };
  if (documents.length === 0) return stats;

  const batchSize = Math.max(1, Math.min(50, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE)));
  let preferredProvider: EmbeddingProviderName | undefined;
  let selectedStore: "qdrant" | "pinecone" | null = null;

  for (let start = 0; start < documents.length; start += batchSize) {
    const batch = documents.slice(start, start + batchSize);
    const embeddingResult = await embedTexts(
      batch.map((document) => document.text.slice(0, 16_000)),
      "document",
      preferredProvider,
    );
    if (!embeddingResult || embeddingResult.vectors.length !== batch.length) {
      stats.errors.push(`Embedding batch ${Math.floor(start / batchSize) + 1} failed`);
      continue;
    }

    preferredProvider = embeddingResult.provider;
    stats.provider ??= embeddingResult.provider;
    if (embeddingResult.errors?.length) stats.errors.push(...embeddingResult.errors);

    const points = batch.map((document, index) => ({
      id: stableUuid(document.id),
      vector: embeddingResult.vectors[index] ?? [],
      payload: compactPayload(document.payload),
    })).filter((point) => point.vector.length > 0);
    if (points.length === 0) {
      stats.errors.push(`Embedding batch ${Math.floor(start / batchSize) + 1} returned no usable vectors`);
      continue;
    }

    let indexed = false;
    if ((selectedStore === null || selectedStore === "qdrant") && (await qdrantProvider.isConfigured())) {
      const ok = await qdrantProvider.upsert(points, options.qdrantCollection);
      if (ok) {
        selectedStore = "qdrant";
        indexed = true;
      } else {
        stats.errors.push(`Qdrant upsert failed for batch ${Math.floor(start / batchSize) + 1}`);
      }
    }

    if (!indexed && (selectedStore === null || selectedStore === "pinecone") && (await pineconeProvider.isConfigured())) {
      const ok = await pineconeProvider.upsert(points, options.pineconeNamespace);
      if (ok) {
        selectedStore = "pinecone";
        indexed = true;
      } else {
        stats.errors.push(`Pinecone upsert failed for batch ${Math.floor(start / batchSize) + 1}`);
      }
    }

    if (indexed) stats.indexed += points.length;
  }

  stats.vectorStore = selectedStore;
  if (!selectedStore) stats.errors.push("No working vector store was available; indexing was skipped");
  return stats;
}

export async function indexOpportunities(opportunities: NormalizedOpportunity[]): Promise<VectorIndexStats> {
  return indexVectorDocuments(
    opportunities.map((opp) => ({
      id: opp.externalId || `${opp.source}:${opp.title}:${opp.agency}`,
      text: opportunityVectorText(opp),
      payload: {
        documentType: "opportunity",
        externalId: opp.externalId,
        title: opp.title,
        agency: opp.agency,
        source: opp.source,
        sourceUrl: opp.sourceUrl,
        solicitationNumber: opp.solicitationNumber,
        naicsCode: opp.naicsCode,
        status: opp.status,
      },
    })),
  );
}

/**
 * Query the existing opportunity vector index (Qdrant, then Pinecone — the same order indexing uses) for the hybrid
 * search vector leg. Hits resolve to stored opportunity ids through the `opportunityId` payload written by
 * opportunityVectorSync.ts; hits without one are counted, not guessed. Throws RetrievalMethodError so the caller can
 * fall back to lexical-only and record why.
 */
/**
 * While the vector store or query embedding is failing, searches skip the vector leg for a cooldown instead of
 * waiting several seconds per request for the same failure (HYBRID_VECTOR_COOLDOWN_MS, default 5 minutes).
 */
let vectorUnavailableUntil = 0;
let lastVectorFailure: RetrievalMethodError | null = null;

function vectorCooldownMs(): number {
  const raw = Number(process.env.HYBRID_VECTOR_COOLDOWN_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5 * 60_000;
}

export function clearVectorCooldownForTests(): void {
  vectorUnavailableUntil = 0;
  lastVectorFailure = null;
}

export async function searchVectorIndex(
  query: string,
  limit: number,
  options: VectorIndexOptions = {},
): Promise<MethodRetrieval> {
  if (Date.now() < vectorUnavailableUntil && lastVectorFailure) {
    throw new RetrievalMethodError("vector_index_cooling_down", `Skipped after a recent failure: ${lastVectorFailure.message}`, {
      failedCode: lastVectorFailure.code,
      retryAt: new Date(vectorUnavailableUntil).toISOString(),
    });
  }
  try {
    return await searchVectorStore(query, limit, options);
  } catch (error) {
    if (error instanceof RetrievalMethodError) {
      lastVectorFailure = error;
      vectorUnavailableUntil = Date.now() + vectorCooldownMs();
    }
    throw error;
  }
}

async function searchVectorStore(query: string, limit: number, options: VectorIndexOptions): Promise<MethodRetrieval> {
  const qdrant = await qdrantProvider.isConfigured();
  const pinecone = !qdrant && (await pineconeProvider.isConfigured());
  if (!qdrant && !pinecone) {
    throw new RetrievalMethodError("vector_index_unavailable", "No vector store (Qdrant or Pinecone) is configured");
  }

  const embedding = await embedTexts([query], "query");
  const vector = embedding?.vectors[0];
  if (!embedding || !vector) {
    throw new RetrievalMethodError("query_embedding_unavailable", "No embedding provider returned a query vector");
  }

  const store = qdrant ? "qdrant" : "pinecone";
  const hits = qdrant
    ? await qdrantProvider.search(vector, limit, options.qdrantCollection)
    : await pineconeProvider.search(vector, limit, options.pineconeNamespace);
  if (!hits) {
    throw new RetrievalMethodError("vector_index_unavailable", `${store} search failed or returned no response`, {
      store,
      embeddingProvider: embedding.provider,
    });
  }

  const resolved: MethodRetrieval["hits"] = [];
  let unresolved = 0;
  for (const hit of hits) {
    const opportunityId = hit.payload?.opportunityId;
    if (typeof opportunityId === "string" && opportunityId) resolved.push({ id: opportunityId, score: hit.score });
    else unresolved++;
  }
  return {
    hits: resolved,
    detail: { store, embeddingProvider: embedding.provider, rawHits: hits.length, unresolvedHits: unresolved },
  };
}

function stableUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
