const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/** Every way a calendar date is commonly written in a solicitation, for one ISO date (YYYY-MM-DD). */
function dateSpellings(iso: string): string[] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return [];
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return [];
  const name = MONTHS[month - 1];
  const short = name.slice(0, 3);
  return [
    iso,
    `${month}/${day}/${year}`,
    `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${year}`,
    `${month}/${day}/${String(year).slice(2)}`,
    `${name} ${day}, ${year}`,
    `${name} ${day} ${year}`,
    `${short} ${day}, ${year}`,
    `${short}. ${day}, ${year}`,
    `${day} ${name} ${year}`,
  ];
}

function normalizeForSearch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

/** True only when the source text actually writes this ISO date, so a model cannot invent a deadline. */
export function sourceStatesDate(sourceText: string, iso: unknown): boolean {
  if (typeof iso !== "string") return false;
  const haystack = normalizeForSearch(sourceText);
  return dateSpellings(iso.trim()).some((spelling) => haystack.includes(spelling));
}

/** True only when the source text contains this buyer name (ignoring case and spacing). */
export function sourceStatesBuyer(sourceText: string, buyer: unknown): boolean {
  if (typeof buyer !== "string") return false;
  const wanted = normalizeForSearch(buyer.trim());
  return wanted.length >= 4 && normalizeForSearch(sourceText).includes(wanted);
}

/** True only when the source text contains the digits of this dollar value (e.g. "$250,000" or "250000"). */
export function sourceStatesValue(sourceText: string, value: unknown): boolean {
  if (typeof value !== "string") return false;
  const digits = value.replace(/[^0-9.]/g, "");
  if (digits.replace(".", "").length < 4 && !/[km]\b/i.test(value)) return false;
  const haystack = sourceText.replace(/,/g, "");
  return haystack.includes(digits) || sourceText.toLowerCase().includes(value.trim().toLowerCase());
}

function cleanList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim() !== "")
    .map((item) => item.trim().slice(0, maxLength))
    .slice(0, maxItems);
}

/**
 * A model reply is only usable as a brief when it actually says something. The provider pool takes the first reply
 * this accepts, so a bare "{}" or a one-word summary must be rejected here to let the next provider answer.
 */
export function isUsableAiBrief(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const brief = value as Record<string, unknown>;
  const summary = typeof brief.summary === "string" ? brief.summary.trim() : "";
  const fit = typeof brief.occumedFit === "string" ? brief.occumedFit.trim() : "";
  return summary.length >= 40 && fit.length >= 12;
}

interface RecoveredFacts {
  keyDates: { posted: string | null; due: string | null };
  buyer: string | null;
  estimatedValue: string | null;
  /** Lowercase fragments of "missing info" entries that the source text resolved. */
  resolvedMissing: string[];
  fields: string[];
}

function recoverMissingFacts(ai: any, base: any, sourceText?: string | null): RecoveredFacts {
  const keyDates = { posted: base?.keyDates?.posted ?? null, due: base?.keyDates?.due ?? null };
  let buyer: string | null = base?.buyer ?? null;
  let estimatedValue: string | null = base?.estimatedValue ?? null;
  const resolvedMissing: string[] = [];
  const fields: string[] = [];
  const source = typeof sourceText === "string" ? sourceText : "";
  if (source.length >= 200) {
    if (!keyDates.due && sourceStatesDate(source, ai?.keyDates?.due)) {
      keyDates.due = ai.keyDates.due.trim();
      resolvedMissing.push("deadline");
      fields.push("due");
    }
    if (!keyDates.posted && sourceStatesDate(source, ai?.keyDates?.posted)) {
      keyDates.posted = ai.keyDates.posted.trim();
      fields.push("posted");
    }
    if (!buyer && sourceStatesBuyer(source, ai?.buyer)) {
      buyer = ai.buyer.trim();
      resolvedMissing.push("buyer");
      fields.push("buyer");
    }
    if (!estimatedValue && sourceStatesValue(source, ai?.estimatedValue)) {
      estimatedValue = ai.estimatedValue.trim();
      resolvedMissing.push("estimated value");
      fields.push("estimatedValue");
    }
  }
  return { keyDates, buyer, estimatedValue, resolvedMissing, fields };
}

/**
 * Merges model output into the deterministic brief. Verified card facts always win. Where the saved card has no
 * value for a fact, the model's value is adopted only if the fetched source text itself states it, and the matching
 * "missing" item is cleared. Without source text (the 4th argument) behavior is unchanged.
 */
export function mergeSummaryWithVerifiedFacts(ai: any, base: any, provider: string, sourceText?: string | null) {
  const recovered = recoverMissingFacts(ai, base, sourceText);
  const aiFit = typeof ai?.occumedFit === "string" ? ai.occumedFit.trim() : "";
  const vagueFit = /\b(may|might|possible|potential|unclear|unknown)\b|general occupational health/i.test(aiFit);
  return {
    ...base,
    summary: typeof ai?.summary === "string" && ai.summary.trim() ? ai.summary.trim() : base.summary,
    occumedFit: aiFit && !vagueFit ? aiFit : base.occumedFit,
    serviceLines: Array.isArray(ai?.serviceLines) && ai.serviceLines.length ? ai.serviceLines.filter((x: any) => typeof x === "string").slice(0, 5) : base.serviceLines,
    keyDates: recovered.keyDates,
    buyer: recovered.buyer,
    estimatedValue: recovered.estimatedValue,
    solicitationType: base.solicitationType,
    classification: base.classification,
    sourceUrl: base.sourceUrl,
    bidNotes: [`Decision status: ${base.fitVerdict}. Confidence: ${base.confidence}.`, ...(Array.isArray(ai?.bidNotes) ? ai.bidNotes : Array.isArray(base.bidNotes) ? base.bidNotes : [])].filter((x: any) => typeof x === "string").slice(0, 5),
    missingInfo: (Array.isArray(ai?.missingInfo) ? ai.missingInfo.filter((x: any) => typeof x === "string").slice(0, 6) : Array.isArray(base.missingInfo) ? base.missingInfo : [])
      .filter((item: string) => !recovered.resolvedMissing.some((resolved: string) => item.toLowerCase().includes(resolved))),
    verifiedFromSource: recovered.fields,
    testsRequested: cleanList(ai?.testsRequested, 8, 120),
    scope: typeof ai?.scope === "string" && ai.scope.trim() ? ai.scope.trim().slice(0, 700) : null,
    provider,
    fitVerdict: base.fitVerdict,
    confidence: base.confidence,
    evidenceFingerprint: base.evidenceFingerprint,
  };
}
