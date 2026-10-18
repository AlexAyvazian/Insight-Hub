import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_RRF_K,
  RetrievalMethodError,
  reciprocalRankFusion,
  runHybridRetrieval,
  selectiveRerank,
  type MethodHit,
} from "../hybridFusion";

const hits = (...ids: string[]): MethodHit[] => ids.map((id, index) => ({ id, score: 1 - index / 100 }));

describe("Hybrid search: reciprocal rank fusion", () => {
  it("scores 1/(k + rank) per method and keeps results found by only one method", () => {
    const fused = reciprocalRankFusion([
      { method: "lexical", hits: hits("a", "b", "c") },
      { method: "vector", hits: hits("b", "d") },
    ]);

    assert.deepEqual(fused.map((row) => row.id), ["b", "a", "d", "c"]);
    const b = fused[0]!;
    assert.equal(b.rrfScore, 1 / (DEFAULT_RRF_K + 2) + 1 / (DEFAULT_RRF_K + 1));
    assert.deepEqual(b.ranks, { lexical: 2, vector: 1 });
    assert.deepEqual(b.methods, ["lexical", "vector"]);
    // Lexical-only and vector-only documents stay in the fused list with their single-method rank.
    assert.deepEqual(fused.find((row) => row.id === "c")?.ranks, { lexical: 3 });
    assert.deepEqual(fused.find((row) => row.id === "d")?.ranks, { vector: 2 });
    assert.deepEqual(fused.map((row) => row.fusedRank), [1, 2, 3, 4]);
  });

  it("breaks exact ties deterministically by best rank, then id, regardless of input order", () => {
    // x and y tie on RRF (each rank 1 in one method, rank 2 in the other); p and q tie as single-method rank 3.
    const forward = reciprocalRankFusion([
      { method: "lexical", hits: hits("y", "x", "q") },
      { method: "vector", hits: hits("x", "y", "p") },
    ]);
    const reversed = reciprocalRankFusion([
      { method: "vector", hits: hits("x", "y", "p") },
      { method: "lexical", hits: hits("y", "x", "q") },
    ]);
    assert.deepEqual(forward.map((row) => row.id), ["x", "y", "p", "q"]);
    assert.deepEqual(reversed.map((row) => row.id), forward.map((row) => row.id));
  });

  it("honours a configurable k and ignores duplicate ids inside one list", () => {
    const fused = reciprocalRankFusion([{ method: "lexical", hits: hits("a", "a", "b") }], 10);
    assert.deepEqual(fused.map((row) => [row.id, row.ranks.lexical]), [["a", 1], ["b", 2]]);
    assert.equal(fused[1]!.rrfScore, 1 / 12);
  });
});

describe("Hybrid search: retrieval fallback and diagnostics", () => {
  it("falls back to lexical-only and records the failure when the vector index is unavailable", async () => {
    const result = await runHybridRetrieval({
      lexical: async () => ({ hits: hits("a", "b") }),
      vector: async () => {
        throw new RetrievalMethodError("vector_index_unavailable", "No vector store is configured");
      },
    });
    assert.equal(result.mode, "lexical_only");
    assert.deepEqual(result.fused.map((row) => row.id), ["a", "b"]);
    assert.equal(result.methods.vector.status, "failed");
    assert.equal(result.methods.lexical.candidates, 2);
    assert.deepEqual(result.failures, [
      { method: "vector", code: "vector_index_unavailable", message: "No vector store is configured" },
    ]);
  });

  it("falls back to vector-only when the lexical leg throws", async () => {
    const result = await runHybridRetrieval({
      lexical: async () => {
        throw new Error("relation \"opportunities\" does not exist");
      },
      vector: async () => ({ hits: hits("v1", "v2"), detail: { store: "qdrant" } }),
    });
    assert.equal(result.mode, "vector_only");
    assert.deepEqual(result.fused.map((row) => row.id), ["v1", "v2"]);
    assert.equal(result.failures[0]?.code, "lexical_failed");
    assert.deepEqual(result.methods.vector.detail, { store: "qdrant" });
  });

  it("reports a disabled leg without a failure and keeps every per-method list inspectable", async () => {
    const result = await runHybridRetrieval({ lexical: async () => ({ hits: hits("a", "b") }), vector: null });
    assert.equal(result.mode, "lexical_only");
    assert.equal(result.methods.vector.status, "disabled");
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.lists.lexical.map((hit) => [hit.id, hit.rank]), [["a", 1], ["b", 2]]);
  });

  it("times out a slow leg and reports mode failed when nothing succeeded", async () => {
    const result = await runHybridRetrieval(
      {
        lexical: async () => {
          throw new Error("db down");
        },
        vector: () => new Promise(() => undefined),
      },
      { timeoutMs: { vector: 20 } },
    );
    assert.equal(result.mode, "failed");
    assert.deepEqual(result.failures.map((failure) => failure.code).sort(), ["lexical_failed", "vector_timeout"]);
    assert.equal(result.fused.length, 0);
  });
});

describe("Hybrid search: selective rerank", () => {
  const fusedItems = () =>
    reciprocalRankFusion([
      { method: "lexical", hits: hits("a", "b", "c", "d", "e", "f") },
      { method: "vector", hits: hits("f", "e") },
    ]);

  it("sends only the fused top-N to the reranker and leaves the tail in fused order", async () => {
    const items = reciprocalRankFusion([{ method: "lexical", hits: hits("a", "b", "c", "d", "e", "f") }]);
    let seen: string[] = [];
    const result = await selectiveRerank(items, 3, async (head) => {
      seen = head.map((item) => item.id);
      return new Map([[head[2]!.id, 1]]);
    });

    assert.equal(seen.length, 3);
    assert.deepEqual(seen, items.slice(0, 3).map((item) => item.id));
    assert.equal(result.diagnostics.considered, 3);
    assert.equal(result.diagnostics.reranked, 1);
    assert.equal(result.diagnostics.applied, true);
    assert.equal(result.items[0]!.id, seen[2], "a strong similarity lifts a head item");
    assert.deepEqual(
      result.items.slice(3).map((item) => item.id),
      items.slice(3).map((item) => item.id),
      "the tail is untouched",
    );
    assert.ok(result.items.slice(3).every((item) => item.rerankSimilarity === null));
    assert.equal(result.items.length, items.length, "rerank never drops a result");
  });

  it("keeps fused order when the reranker fails or is not configured", async () => {
    const items = fusedItems();
    const failed = await selectiveRerank(items, 4, async () => {
      throw new Error("rerank provider busy");
    });
    assert.deepEqual(failed.items.map((item) => item.id), items.map((item) => item.id));
    assert.equal(failed.failure?.code, "rerank_failed");
    assert.equal(failed.diagnostics.applied, false);

    const disabled = await selectiveRerank(items, 4, null);
    assert.deepEqual(disabled.items.map((item) => item.id), items.map((item) => item.id));
    assert.equal(disabled.diagnostics.enabled, false);
  });

  it("produces the same order on repeated runs (reproducible ranking)", async () => {
    const scorer = async (head: Array<{ id: string }>) => new Map(head.map((item) => [item.id, 0.5]));
    const first = await selectiveRerank(fusedItems(), 5, scorer);
    const second = await selectiveRerank(fusedItems(), 5, scorer);
    assert.deepEqual(first.items.map((item) => item.id), second.items.map((item) => item.id));
    // Equal similarity everywhere changes nothing: fused order is the tie-break.
    assert.deepEqual(first.items.map((item) => item.id), fusedItems().map((item) => item.id));
  });
});
