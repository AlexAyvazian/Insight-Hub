export type IngestionRejectedStatus = "rejected" | "quarantined";

export interface RejectionReasonCountRow {
  qualityStatus: string;
  qualityReason: string | null;
  count: number;
}

export interface RejectionSampleRow {
  provider: string;
  title: string | null;
  agency: string | null;
  qualityStatus: string;
  qualityReason: string | null;
  completenessScore: string | number;
  sourceConfidence: string | number;
}

export interface IngestionRejectionReasonSummary {
  status: IngestionRejectedStatus;
  code: string;
  label: string;
  detail: string;
  count: number;
}

export interface IngestionRejectionSample {
  provider: string;
  title: string | null;
  agency: string | null;
  status: IngestionRejectedStatus;
  reasonCode: string;
  reasonLabel: string;
  reason: string;
  completenessScore: number;
  sourceConfidence: number;
}

export interface IngestionRejectionDiagnostics {
  total: number;
  reasons: IngestionRejectionReasonSummary[];
  samples: IngestionRejectionSample[];
}

const REASON_LABELS: Record<string, string> = {
  blocked_domain: "Blocked non-procurement domain",
  hard_reject: "Hard-reject wording",
  conditional_false_positive: "False-positive context",
  missing_procurement_signal: "No procurement signal",
  missing_occumed_service_evidence: "No Occu-Med service evidence",
  insufficient_evidence_combination: "Insufficient evidence combination",
  manual_query_mismatch: "Did not match the manual query",
  query_deferred: "Deferred for review: query terms absent or snippet too thin",
  invalid_title: "Invalid title",
  missing_agency: "Missing agency",
  invalid_posted_date: "Invalid posted date",
  unknown_posted_date: "Posted date unavailable",
  legacy_relevance_filter: "Legacy relevance rejection",
  unknown: "Unclassified rejection",
};

function numeric(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseStoredQualityReason(reason: string | null | undefined): {
  code: string;
  label: string;
  detail: string;
} {
  const normalized = reason?.trim() || "";
  if (!normalized) {
    return {
      code: "unknown",
      label: REASON_LABELS.unknown,
      detail: "No rejection reason was stored.",
    };
  }
  const separator = normalized.indexOf("|");
  if (separator < 1) {
    return {
      code: "legacy_relevance_filter",
      label: REASON_LABELS.legacy_relevance_filter,
      detail: normalized,
    };
  }
  const code = normalized.slice(0, separator).trim() || "unknown";
  const detail = normalized.slice(separator + 1).trim() || normalized;
  return {
    code,
    label: REASON_LABELS[code] ?? code.replaceAll("_", " "),
    detail,
  };
}

function rejectedStatus(value: string): IngestionRejectedStatus {
  return value === "quarantined" ? "quarantined" : "rejected";
}

function rejectionSample(row: RejectionSampleRow): IngestionRejectionSample {
  const status = rejectedStatus(row.qualityStatus);
  const parsed = parseStoredQualityReason(row.qualityReason);
  return {
    provider: row.provider,
    title: row.title,
    agency: row.agency,
    status,
    reasonCode: parsed.code,
    reasonLabel: parsed.label,
    reason: parsed.detail,
    completenessScore: numeric(row.completenessScore),
    sourceConfidence: numeric(row.sourceConfidence),
  };
}

export function buildIngestionRejectionDiagnostics(
  reasonRows: RejectionReasonCountRow[],
  sampleRows: RejectionSampleRow[],
  sampleLimit = 12,
): IngestionRejectionDiagnostics {
  const grouped = new Map<string, IngestionRejectionReasonSummary>();
  for (const row of reasonRows) {
    const status = rejectedStatus(row.qualityStatus);
    const parsed = parseStoredQualityReason(row.qualityReason);
    const key = `${status}:${parsed.code}`;
    const prior = grouped.get(key);
    grouped.set(key, {
      status,
      code: parsed.code,
      label: parsed.label,
      detail: prior?.detail ?? parsed.detail,
      count: (prior?.count ?? 0) + Math.max(0, Number(row.count) || 0),
    });
  }

  const reasons = Array.from(grouped.values()).sort(
    (left, right) =>
      right.count - left.count || left.label.localeCompare(right.label),
  );

  const sampleBuckets = new Map<string, RejectionSampleRow[]>();
  for (const row of sampleRows) {
    const status = rejectedStatus(row.qualityStatus);
    const parsed = parseStoredQualityReason(row.qualityReason);
    const key = `${status}:${parsed.code}`;
    const bucket = sampleBuckets.get(key) ?? [];
    if (bucket.length < 3) bucket.push(row);
    sampleBuckets.set(key, bucket);
  }

  const samples: IngestionRejectionSample[] = [];
  const boundedLimit = Math.max(0, Math.floor(sampleLimit));
  for (let round = 0; round < 3 && samples.length < boundedLimit; round += 1) {
    for (const reason of reasons) {
      if (samples.length >= boundedLimit) break;
      const key = `${reason.status}:${reason.code}`;
      const row = sampleBuckets.get(key)?.[round];
      if (row) samples.push(rejectionSample(row));
    }
  }

  return {
    total: reasons.reduce((sum, reason) => sum + reason.count, 0),
    reasons,
    samples,
  };
}
