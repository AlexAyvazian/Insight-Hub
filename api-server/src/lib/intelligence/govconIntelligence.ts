import { agencyPriority } from "../search/agencyPriority";
import { embedTexts } from "../search/embeddings";
import { getOccuMedSemanticProfile } from "../search/semanticRerank";
import { classifyResult } from "../search/relevance";
import { decideRelevanceWithCodes, type RelevanceVerdict } from "../search/relevanceDecision";

export type GovConIntelligenceMode = "forecast" | "recompete";

export interface GovConRankableRecord {
  id: string;
  title: string;
  agency: string;
  subAgency?: string | null;
  description?: string | null;
  naics?: string | null;
  setAside?: string | null;
  incumbentName?: string | null;
  isRecompete?: boolean;
}

export interface GovConRelevance {
  score: number;
  /** Canonical Neon decision: accept -> strong, review -> possible, reject -> low. */
  verdict: RelevanceVerdict;
  classification: "strong" | "possible" | "low";
  semanticSimilarity: number | null;
  provider: "gemini" | "deterministic";
  reasons: string[];
}

function normalizedText(record: GovConRankableRecord): string {
  return [
    record.title,
    record.agency,
    record.subAgency,
    record.description,
    record.naics,
    record.setAside,
    record.incumbentName,
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12_000);
}

/**
 * GovCon forecast/recompete records are judged by the same Neon-backed classifier and the same canonical
 * thresholds as every other notice. There is no GovCon vocabulary or weighting here: the per-term `govcon_weight`
 * values are kept in Neon term metadata only, and the NAICS preferences are the Neon discovery-code facts.
 */
function deterministicScore(record: GovConRankableRecord, mode: GovConIntelligenceMode): {
  score: number;
  verdict: RelevanceVerdict;
  reasons: string[];
} {
  const result = classifyResult({
    title: record.title,
    snippet: [record.description, record.naics, record.setAside].filter(Boolean).join(" "),
    allowHistorical: true,
    // Forecasts / Recompete keep legacy containment matching until measured separately (Opportunities uses "token").
    matchMode: "substring",
  });
  const decision = decideRelevanceWithCodes(result, [{ system: "NAICS 2022", code: record.naics }]);
  const reasons = result.rejected
    ? [result.rejectReason ?? decision.reason]
    : result.reasons.slice(0, 4);
  if (result.rejected && decision.verdict === "review") {
    // Say what actually happened: nothing in the title/description named an Occu-Med service, and the record is only
    // here because of its classification code or a partial signal. "Insufficient evidence" read like a rejection.
    reasons.length = 0;
    reasons.push(
      decision.discovery
        ? `Kept for review on classification code ${decision.discovery.system} ${decision.discovery.code} alone: no Occu-Med service wording in the title or description`
        : "Borderline: partial Occu-Med signals, not enough to accept",
    );
  } else if (decision.discovery) {
    reasons.push(`Occu-Med classification code ${decision.discovery.system} ${decision.discovery.code}`);
  }
  if (mode === "recompete" && (record.incumbentName || record.isRecompete)) {
    reasons.push("Published recompete or incumbent signal");
  }
  return {
    score: result.score,
    verdict: decision.verdict,
    reasons: Array.from(new Set(reasons)).slice(0, 5),
  };
}

function cosine(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function classify(verdict: RelevanceVerdict): GovConRelevance["classification"] {
  return verdict === "accept" ? "strong" : verdict === "review" ? "possible" : "low";
}

/** Incumbent contract end date in ms; records without one sort after every dated record. */
function expiryMs(record: unknown): number {
  const expires = (record as { incumbentAward?: { expires?: string | null } | null }).incumbentAward?.expires;
  const parsed = expires ? Date.parse(expires) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

export async function rankGovConRecords<T extends GovConRankableRecord>(
  records: T[],
  mode: GovConIntelligenceMode,
  focus?: string,
): Promise<Array<T & { relevance: GovConRelevance }>> {
  if (records.length === 0) return [];

  const deterministic = records.map((record) => deterministicScore(record, mode));
  let similarities: number[] | null = null;

  // GovCon already returns structured forecast and incumbent data. Preserve
  // trial AI allowances by using local deterministic ranking by default. A
  // deployment may explicitly opt into Gemini semantic reranking when desired.
  const semanticRankingEnabled =
    process.env.GOVCON_SEMANTIC_RANKING_ENABLED === "true";

  if (semanticRankingEnabled && process.env.GEMINI_API_KEY?.trim()) {
    try {
      const documentResult = await embedTexts(records.map(normalizedText), "document", "gemini");
      if (
        documentResult?.provider === "gemini" &&
        documentResult.vectors.length === records.length
      ) {
        const profileText = [
          await getOccuMedSemanticProfile(focus),
          mode === "recompete"
            ? "Prioritize expiring or incumbent federal contracts that Occu-Med could credibly compete for."
            : "Prioritize future procurements that Occu-Med could credibly perform.",
        ]
          .filter(Boolean)
          .join(" ");
        const queryResult = await embedTexts([profileText], "query", "gemini");
        const queryVector = queryResult?.vectors[0];
        if (queryResult?.provider === "gemini" && queryVector) {
          similarities = documentResult.vectors.map((vector) =>
            Math.max(0, Math.min(1, cosine(queryVector, vector))),
          );
        }
      }
    } catch {
      similarities = null;
    }
  }

  return records
    .map((record, index): T & { relevance: GovConRelevance } => {
      const base = deterministic[index] ?? { score: 0, verdict: "reject" as RelevanceVerdict, reasons: [] };
      const semanticSimilarity = similarities?.[index] ?? null;
      // The verdict is the canonical Neon decision. Optional semantic similarity only orders records within it.
      const score = Math.round(base.score);
      const reasons = [...base.reasons];
      if (semanticSimilarity !== null) {
        reasons.unshift(`Gemini semantic match ${Math.round(semanticSimilarity * 100)}%`);
      }
      const provider: GovConRelevance["provider"] =
        semanticSimilarity === null ? "deterministic" : "gemini";
      return {
        ...record,
        relevance: {
          score,
          verdict: base.verdict,
          classification: classify(base.verdict),
          semanticSimilarity,
          provider,
          reasons: Array.from(new Set(reasons)).slice(0, 6),
        },
      };
    })
    .sort((left, right) => {
      const rank = (r: GovConRelevance) => (r.verdict === "accept" ? 2 : r.verdict === "review" ? 1 : 0);
      return (
        rank(right.relevance) - rank(left.relevance) ||
        right.relevance.score - left.relevance.score ||
        // Recompetes: the contract that ends soonest is the one to act on first.
        (mode === "recompete" ? expiryMs(left) - expiryMs(right) : 0) ||
        // Search priority only (Neon): preferred agencies first among equally relevant records.
        agencyPriority(String((right as { agency?: unknown }).agency ?? "")) - agencyPriority(String((left as { agency?: unknown }).agency ?? "")) ||
        (right.relevance.semanticSimilarity ?? 0) - (left.relevance.semanticSimilarity ?? 0)
      );
    });
}
