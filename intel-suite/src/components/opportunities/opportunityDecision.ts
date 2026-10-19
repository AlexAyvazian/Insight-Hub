/**
 * Pure view helpers for the authoritative opportunity decision (api-server lib/releaseC/decisionRecord.ts
 * AuthoritativeDecisionView, exposed as `decision` on the opportunity list and detail routes) and the Release C
 * evidence routes (GET /api/opportunities/:id/versions and /documents).
 *
 * Every field is optional here: older records carry no stored decision (`decision` absent, or `source: "none"`),
 * so the display state falls back to the read-time quality classification and relevance verdict.
 */

export type OpportunityDisplayState =
  | "qualified"
  | "needs_review"
  | "provisional"
  | "out_of_scope"
  | "closed";

export const DISPLAY_STATE_ORDER: OpportunityDisplayState[] = [
  "qualified",
  "needs_review",
  "provisional",
  "out_of_scope",
  "closed",
];

export const DISPLAY_STATE_LABELS: Record<OpportunityDisplayState, string> = {
  qualified: "Qualified",
  needs_review: "Needs Review",
  provisional: "Provisional",
  out_of_scope: "Out of Scope",
  closed: "Closed",
};

export const DISPLAY_STATE_STYLES: Record<OpportunityDisplayState, string> = {
  qualified: "bg-emerald-500/10 text-emerald-300 border-emerald-500/25",
  needs_review: "bg-amber-500/10 text-amber-300 border-amber-500/25",
  provisional: "bg-cyan-500/10 text-cyan-300 border-cyan-500/25",
  out_of_scope: "bg-red-500/10 text-red-300 border-red-500/25",
  closed: "bg-white/5 text-white/50 border-white/10",
};

export interface DecisionCitationView {
  section: string | null;
  quote: string;
  sectionId?: string | null;
}

export interface OpportunityDecisionView {
  source?: "stored" | "none";
  state?: string | null;
  decisionVersion?: number | null;
  evaluatorVersion?: string | null;
  profileVersion?: string | null;
  decidedAt?: string | null;
  method?: string | null;
  holdCode?: string | null;
  score?: number | null;
  reason?: string | null;
  primaryScope?: unknown;
  citations?: DecisionCitationView[] | null;
  current?: boolean;
  stale?: boolean;
  staleReason?: string | null;
  authoritative?: boolean;
  readTimeConflict?: string | null;
  reviewers?: string[] | null;
  families?: string[] | null;
}

const KNOWN_STATES = new Set<string>(DISPLAY_STATE_ORDER);

function toTime(value: unknown): number | null {
  if (value == null || value === "") return null;
  const time = new Date(value as string).getTime();
  return Number.isFinite(time) ? time : null;
}

/** The stored decision, or null when the record has none (older rows, or `source: "none"`). */
export function storedDecision(opp: any): OpportunityDecisionView | null {
  const decision = opp?.decision as OpportunityDecisionView | undefined;
  if (!decision || typeof decision !== "object") return null;
  if (decision.source === "none") return null;
  if (!decision.state || !KNOWN_STATES.has(decision.state)) return null;
  return decision;
}

/** Closed regardless of the decision: past the response deadline, cancelled, archived or awarded. */
export function isOpportunityClosed(opp: any, now = Date.now()): boolean {
  const deadline = toTime(opp?.responseDeadline);
  if (deadline != null && deadline < now) return true;
  const status = String(opp?.status ?? "").toLowerCase();
  if (["archived", "cancelled", "canceled", "closed", "inactive"].includes(status)) return true;
  const classification = String(opp?.quality?.classification ?? "");
  return ["closed", "archived", "award"].includes(classification);
}

/** One display state for an opportunity: the stored decision first, the read-time classification otherwise. */
export function opportunityDisplayState(opp: any, now = Date.now()): OpportunityDisplayState {
  if (isOpportunityClosed(opp, now)) return "closed";
  const decision = storedDecision(opp);
  if (decision) return decision.state as OpportunityDisplayState;
  const classification = String(opp?.quality?.classification ?? "");
  const verdict = opp?.relevance?.verdict;
  if (verdict === "reject") return "out_of_scope";
  if (classification === "discovery-only" || classification === "forecast") return "provisional";
  if (classification === "verified-open" && verdict === "accept") return "qualified";
  return "needs_review";
}

export function displayStateCounts(opps: any[], now = Date.now()): Record<OpportunityDisplayState, number> {
  const counts = Object.fromEntries(DISPLAY_STATE_ORDER.map((state) => [state, 0])) as Record<OpportunityDisplayState, number>;
  for (const opp of opps) counts[opportunityDisplayState(opp, now)] += 1;
  return counts;
}

export function humanizeCode(value: string | null | undefined): string {
  if (!value) return "";
  return value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().replace(/^./, (c) => c.toUpperCase());
}

const PROVIDER_LABELS: Record<string, string> = {
  samGov: "SAM.gov",
  sam_gov: "SAM.gov",
  tango: "Tango",
  internationalPublicPortals: "Canada + Europe",
  aiDiscovery: "Search discovery",
  csv_import: "CSV import",
  manual: "Manual",
};

export function providerLabel(provider: string | null | undefined): string {
  if (!provider) return "Manual";
  return PROVIDER_LABELS[provider] ?? humanizeCode(provider);
}

export interface PrimaryScopeView {
  evidenced: boolean;
  terms: string[];
  kind: string | null;
  hold: string | null;
  source: string | null;
}

/** The decision's primary purchased scope (search/primaryPurchasedScope.ts PrimaryScopeCitation), when present. */
export function primaryScopeView(value: unknown): PrimaryScopeView | null {
  if (!value || typeof value !== "object") return null;
  const scope = value as Record<string, unknown>;
  const terms = Array.isArray(scope.terms) ? scope.terms.map(String).filter(Boolean) : [];
  return {
    evidenced: scope.evidenced === true,
    terms,
    kind: typeof scope.kind === "string" ? scope.kind : null,
    hold: typeof scope.hold === "string" ? scope.hold : null,
    source: typeof scope.source === "string" ? scope.source : null,
  };
}

/**
 * Page reference parsed from a citation section label. The evaluator cites sections as
 * "[<document title>, p.4-5, <heading>]" (releaseC/passages.ts citationFor); "notice" means the listing text.
 */
export function citationPages(section: string | null | undefined): string | null {
  if (!section) return null;
  const match = section.match(/\bpp?\.\s*(\d+(?:\s*[-–]\s*\d+)?)/i);
  return match ? match[1].replace(/\s+/g, "") : null;
}

/** The document part of a citation label, without brackets or the page reference. */
export function citationDocument(section: string | null | undefined): string {
  if (!section) return "Notice";
  const inner = section.replace(/^\s*\[|\]\s*$/g, "").trim();
  if (/^(notice|description|notice description|title|listing)$/i.test(inner)) return "Notice";
  return inner.split(/,\s*pp?\.\s*\d/i)[0].trim() || "Document";
}

export interface FreshnessView {
  lastObserved: string | null;
  decidedAt: string | null;
  stale: boolean;
  staleReason: string | null;
}

export function freshnessView(opp: any): FreshnessView {
  const decision = storedDecision(opp);
  return {
    lastObserved: opp?.lastSeenAt ?? opp?.updatedAt ?? null,
    decidedAt: decision?.decidedAt ?? null,
    stale: Boolean(decision?.stale),
    staleReason: decision?.staleReason ?? null,
  };
}

// --- Evidence routes ------------------------------------------------------------------------------------------

export interface OpportunityVersionView {
  id: string;
  provider?: string | null;
  releaseTag: "tender" | "amendment" | "cancellation" | "update" | string;
  changedFields?: string[];
  solicitationNumber?: string | null;
  sourceUrl?: string | null;
  sourceModified?: string | null;
  observedAt: string;
  deadline?: string | null;
  title?: string | null;
}

export interface OpportunityVersionsResponse {
  versions?: OpportunityVersionView[];
  amendments?: number;
  cancelled?: boolean;
}

export interface OpportunityDocumentView {
  id: string;
  title?: string | null;
  url?: string | null;
  role?: string | null;
  pages?: number | null;
  pagesRead?: number | null;
  sections?: number;
  pageRange?: [number, number] | null;
  state: string;
  lastCheckedAt?: string | null;
}

export interface OpportunityDocumentsResponse {
  documents?: OpportunityDocumentView[];
  summary?: {
    listed?: number;
    read?: number;
    unread?: number;
    withdrawn?: number;
    byState?: Record<string, number>;
    complete?: boolean;
  };
}

export const DOCUMENT_STATE_LABELS: Record<string, string> = {
  read: "Read",
  partial: "Partially read",
  pending: "Not read yet",
  deferred: "Deferred",
  needs_ocr: "Needs OCR",
  quota_wait: "Waiting on quota",
  failed: "Extraction failed",
  inaccessible: "Inaccessible",
  too_large: "Too large",
  unsupported: "Unsupported format",
  withdrawn: "Withdrawn",
};

export function documentStateTone(state: string): string {
  if (state === "read") return "text-emerald-300";
  if (state === "withdrawn") return "text-white/40 line-through";
  if (state === "partial" || state === "pending" || state === "deferred" || state === "quota_wait") return "text-amber-300";
  return "text-red-300";
}

/** A one-line description of the document inventory, never claiming completeness while anything is unread. */
export function documentInventoryLine(response: OpportunityDocumentsResponse | null | undefined): string {
  const summary = response?.summary;
  const listed = Number(summary?.listed ?? response?.documents?.length ?? 0);
  if (listed === 0) return "No attachments listed for this notice.";
  const read = Number(summary?.read ?? 0);
  const unread = Number(summary?.unread ?? listed - read);
  const withdrawn = Number(summary?.withdrawn ?? 0);
  const parts = [`${read} of ${listed} document${listed === 1 ? "" : "s"} read`];
  if (unread > 0) parts.push(`${unread} unread — assessment may be incomplete`);
  if (withdrawn > 0) parts.push(`${withdrawn} withdrawn`);
  return parts.join(" · ");
}

export const RELEASE_TAG_LABELS: Record<string, string> = {
  tender: "Original notice",
  amendment: "Amendment",
  cancellation: "Cancellation",
  update: "Update",
};

// --- Release C status ------------------------------------------------------------------------------------------

export interface PurposeBudgetView {
  purpose: string;
  calls?: number;
  limit?: number | null;
  remaining?: number | null;
}

export interface AccountUsageView {
  pool?: string;
  slot?: string;
  provider?: string;
  exhausted?: boolean;
  needs_confirmation?: boolean;
  cooldown_until?: string | null;
  quota_limit?: number | null;
  quota_remaining?: number | null;
}

export interface ProviderStatusSummary {
  accounts: number;
  exhausted: number;
  coolingDown: number;
  needsConfirmation: number;
  budgets: Array<{ purpose: string; label: string; calls: number; limit: number | null; remaining: number | null; exhausted: boolean }>;
  tone: "ok" | "warn" | "bad";
}

const PURPOSE_LABELS: Record<string, string> = {
  search: "Search",
  page_extraction: "Page extraction",
  ocr: "OCR",
  ai_evaluation: "AI evaluation",
};

/** Summarizes /api/release-c/status (accountUsage, orchestration.purposeBudgets); null when it carries neither. */
export function providerStatusSummary(status: any, now = Date.now()): ProviderStatusSummary | null {
  if (!status || typeof status !== "object") return null;
  const accounts: AccountUsageView[] = Array.isArray(status.accountUsage) ? status.accountUsage : [];
  const rawBudgets: PurposeBudgetView[] = Array.isArray(status.orchestration?.purposeBudgets)
    ? status.orchestration.purposeBudgets
    : [];
  if (accounts.length === 0 && rawBudgets.length === 0) return null;
  const exhausted = accounts.filter((a) => a.exhausted === true).length;
  const coolingDown = accounts.filter((a) => {
    const until = toTime(a.cooldown_until);
    return until != null && until > now;
  }).length;
  const needsConfirmation = accounts.filter((a) => a.needs_confirmation === true).length;
  const budgets = rawBudgets
    .filter((b) => b && typeof b.purpose === "string")
    .map((b) => {
      const limit = b.limit == null ? null : Number(b.limit);
      const remaining = b.remaining == null ? null : Number(b.remaining);
      return {
        purpose: b.purpose,
        label: PURPOSE_LABELS[b.purpose] ?? humanizeCode(b.purpose),
        calls: Number(b.calls ?? 0),
        limit,
        remaining,
        exhausted: limit != null && remaining != null && remaining <= 0,
      };
    });
  const anyBudgetOut = budgets.some((b) => b.exhausted);
  const allAccountsOut = accounts.length > 0 && exhausted >= accounts.length;
  const tone: ProviderStatusSummary["tone"] = allAccountsOut || anyBudgetOut
    ? "bad"
    : exhausted > 0 || coolingDown > 0 || needsConfirmation > 0
      ? "warn"
      : "ok";
  return { accounts: accounts.length, exhausted, coolingDown, needsConfirmation, budgets, tone };
}
