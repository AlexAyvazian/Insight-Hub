import type { DataSourceProvider, FetchOptions, NormalizedOpportunity, ProviderFetchResult, ProviderStatus } from "./types";
import { verifySamPublicRecords } from "./samGovPageVerification";
import { resolveCredential, type ResolvedCredential } from "../config/providerConfig";
import { FreeTierCredentialPool } from "./freeTierCredentialPool";
import { rfpDb as db, rfpPool } from "@workspace/db";
import { saveSamIntelligenceNotices } from "../intelligence/samNoticeCache";
import { opportunitiesTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import {
  buildSamGovAutonomousTitleQueries,
  buildSamGovTitleQueries,
  isBidReadySamOpportunity,
  type SamOpportunity,
} from "./samGovQuality";
import { profileDirectPhrases } from "../search/occumedSearchProfile";
import {
  buildSamGovClassificationQueries,
  type SamGovClassificationQuery,
} from "./samGovTaxonomy";

export { buildSamGovAutonomousTitleQueries, buildSamGovTitleQueries, isBidReadySamOpportunity } from "./samGovQuality";
export { SAM_GOV_DISCOVERY_TAXONOMY, buildSamGovClassificationQueries } from "./samGovTaxonomy";

const SAM_GOV_DEFAULT_BASE = "https://api.sam.gov/opportunities/v2/search";
// Same request count: also request presolicitations (p), sources sought (r), and award notices (a).
// Non-bid types go ONLY to the intelligence sidecar; the RFP results remain bid-ready o/k.
const SAM_GOV_BID_NOTICE_TYPES = ["o", "k", "p", "r", "a"] as const;
const SAM_GOV_MAX_RESULTS_PER_TITLE = 250;
const SAM_GOV_MAX_RESULTS_PER_CLASSIFICATION = 75;
const SAM_GOV_AUTONOMOUS_QUERY_COUNT = 2;
// SAM accepts one NAICS/PSC code per request, so rotate through the taxonomy
// instead of firing the full catalogue on every Fetch Intelligence run.
const SAM_GOV_CLASSIFICATION_QUERIES_PER_RUN = Math.max(
  1,
  Math.min(12, Number(process.env.SAM_GOV_CLASSIFICATION_QUERIES_PER_RUN ?? 6) || 6),
);
// Keep SAM requests serialized so one quota response updates the credential
// pool before another classification query can reuse the same exhausted key.
const SAM_GOV_CLASSIFICATION_CONCURRENCY = 1;
const SAM_GOV_HYDRATION_LIMIT = 16;
const SAM_GOV_HYDRATION_CONCURRENCY = 2;
let autonomousQueryCursor = 0;
let classificationQueryCursor = 0;

const samGovCredentials = new FreeTierCredentialPool(
  "sam-gov-multi-account",
  [
    { dbKey: "samApiKey", envKey: "SAM_GOV_API_KEY" },
    { envKey: "SAM_GOV_API_KEY_2" },
  ],
  { rotateOnSuccess: false },
);

export function formatSamGovApiError(
  status: number,
  body: string,
  credential: Pick<ResolvedCredential, "source" | "key">,
): string {
  const snippet = body.replace(/\s+/g, " ").trim().slice(0, 200);
  const sourceLabel = credential.source === "environment"
    ? `${credential.key} environment variable`
    : `${credential.key} database setting`;
  if (status === 401 && /(API_KEY_INVALID|900901|Invalid Credentials)/i.test(body)) {
    return `SAM_API_KEY_NOT_CONFIGURED_OR_INVALID: SAM.gov API error 401. The rejected key was loaded from the ${sourceLabel}. Falling back to official public SAM.gov opportunity pages until a valid API key is configured.`;
  }
  return `SAM.gov API error ${status}: ${snippet}`;
}

function samGovCooldownUntil(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { nextAccessTime?: unknown };
    if (typeof parsed.nextAccessTime !== "string") return null;
    const timestamp = Date.parse(parsed.nextAccessTime);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  } catch {
    const match = body.match(/"nextAccessTime"\s*:\s*"([^"]+)"/i);
    if (!match?.[1]) return null;
    const timestamp = Date.parse(match[1]);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  }
}

function samGovQuotaError(resetTime?: string | null): Error {
  const reset = resetTime && Number.isFinite(Date.parse(resetTime))
    ? new Date(Date.parse(resetTime)).toISOString()
    : null;
  return new Error(
    reset
      ? `SAM.gov API error 429: quota/throttle reached. SAM_GOV_COOLDOWN_UNTIL=${reset} API access resets at ${reset}.`
      : "SAM.gov API error 429: quota/throttle reached.",
  );
}

export function isOfficialSamOpportunityUrl(value?: string): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return (host === "sam.gov" || host.endsWith(".sam.gov")) && /^\/opp\/[^/]+\/view\/?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

export class SamGovProvider implements DataSourceProvider {
  readonly name = "samGov" as const;

  private async getBaseUrl(): Promise<string> {
    return (await resolveCredential("samBaseUrl", "SAM_GOV_BASE_URL")) || SAM_GOV_DEFAULT_BASE;
  }

  async isConfigured(): Promise<boolean> {
    return samGovCredentials.isConfigured();
  }

  private static fmtDate(date: Date): string {
    return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}/${date.getFullYear()}`;
  }

  private async runQuery(
    apiKey: string,
    credentialSlot: string,
    baseUrl: string,
    extra: Record<string, string>,
    fromDate: Date,
    today: Date,
    limit: number,
    signal?: AbortSignal,
  ): Promise<NormalizedOpportunity[]> {
    const params = new URLSearchParams({
      api_key: apiKey,
      postedFrom: SamGovProvider.fmtDate(fromDate),
      postedTo: SamGovProvider.fmtDate(today),
      limit: String(limit),
      offset: "0",
      ...extra,
    });
    SAM_GOV_BID_NOTICE_TYPES.forEach((type) => params.append("ptype", type));
    const response = await fetch(`${baseUrl}?${params}`, { signal });
    samGovCredentials.recordRateLimitHeaders(credentialSlot, response.headers);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (
        response.status === 429 ||
        /"code"\s*:\s*"900804"|message throttled out|exceeded your quota/i.test(text)
      ) {
        throw samGovQuotaError(samGovCooldownUntil(text));
      }
      throw new Error(
        formatSamGovApiError(response.status, text, {
          source: "environment",
          key: credentialSlot,
        }),
      );
    }
    const json = (await response.json()) as {
      opportunitiesData?: SamOpportunity[];
      totalRecords?: number;
      code?: string;
      message?: string;
      nextAccessTime?: string;
    };
    if (
      json.code === "900804" ||
      json.message?.toLowerCase().includes("throttled") ||
      json.message?.toLowerCase().includes("quota")
    ) {
      throw samGovQuotaError(json.nextAccessTime ?? null);
    }
    const notices = json.opportunitiesData ?? [];
    if (notices.some(item => /presolicitation|sources? sought|award/i.test(item.type ?? item.baseType ?? ""))) {
      await saveSamIntelligenceNotices(
        async (statement, args = []) => (await rfpPool.query(statement, args)).rows,
        notices,
      ).catch(() => {
        console.warn(JSON.stringify({ event: "sam_intelligence_cache_unavailable" }));
      });
    }
    return notices
      .filter((opportunity) => isBidReadySamOpportunity(opportunity, today))
      .map((opportunity) => this.normalize(opportunity));
  }

  private async hydrateDescriptions(
    records: NormalizedOpportunity[],
    signal?: AbortSignal,
  ): Promise<{ records: NormalizedOpportunity[]; hydratedCount: number }> {
    const candidates = records
      .filter((record) => typeof record.rawData?.samDescriptionUrl === "string" && !!record.sourceUrl)
      .slice(0, SAM_GOV_HYDRATION_LIMIT);
    if (candidates.length === 0) return { records, hydratedCount: 0 };
    const { jinaProvider } = await import("./jina");
    const hydrated = new Map<string, string>();
    for (let index = 0; index < candidates.length; index += SAM_GOV_HYDRATION_CONCURRENCY) {
      const batch = candidates.slice(index, index + SAM_GOV_HYDRATION_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (record) => ({
          id: record.externalId,
          text: record.sourceUrl ? await jinaProvider.extractUrl(record.sourceUrl, 6_000, signal) : null,
        })),
      );
      for (const result of results) {
        if (result.status === "fulfilled" && result.value.text && result.value.text.trim().length >= 120) {
          hydrated.set(result.value.id, result.value.text.trim());
        }
      }
    }
    return {
      hydratedCount: hydrated.size,
      records: records.map((record) => {
        const description = hydrated.get(record.externalId);
        return description
          ? {
              ...record,
              description,
              rawData: {
                ...(record.rawData ?? {}),
                descriptionHydratedBy: "jina-reader",
                descriptionHydratedFrom: record.sourceUrl,
              },
            }
          : record;
      }),
    };
  }

  private titleQueriesForRun(keywords?: string): string[] {
    const explicit = buildSamGovTitleQueries(keywords);
    if (explicit.length > 0) return explicit.slice(0, 2);
    const queries = buildSamGovAutonomousTitleQueries(autonomousQueryCursor, SAM_GOV_AUTONOMOUS_QUERY_COUNT);
    // The title portfolio comes from the profile and can change size on refresh; the query builder wraps the cursor.
    autonomousQueryCursor = (autonomousQueryCursor + SAM_GOV_AUTONOMOUS_QUERY_COUNT) % 1_000_000;
    return queries;
  }

  private async recoverOfficialSamPages(
    options: FetchOptions,
    titleQueries: string[],
  ): Promise<NormalizedOpportunity[]> {
    const quotedFocus = titleQueries
      .filter(Boolean)
      .map((title) => `"${title.replace(/"/g, "")}"`)
      .join(" OR ");
    const profileFocus = profileDirectPhrases()
      .slice(0, 6)
      .map((phrase) => `"${phrase.replace(/"/g, "")}"`)
      .join(" OR ");
    const samSearch = [
      "site:sam.gov/opp/ inurl:/view",
      quotedFocus ? `(${quotedFocus})` : profileFocus ? `(${profileFocus})` : "",
      '(solicitation OR "combined synopsis/solicitation")',
    ].filter(Boolean).join(" ");

    try {
      const { webIntelligenceFetch } = await import("../search/webIntelligence");
      const result = await webIntelligenceFetch({
        keywords: options.keywords,
        discoveryQueries: [samSearch],
        candidateUrlFilter: isOfficialSamOpportunityUrl,
        dateRange: options.dateRange,
        useYou: true,
        useBrowserbase: true,
        useKeenable: true,
        useParallel: true,
        useExa: true,
        useFirecrawl: true,
        useLangsearch: true,
        useLinkup: true,
        useSocrata: false,
        useWebsearch: true,
        useRssAggregator: false,
        useSelfHostedSearch: false,
        useSelfHostedCrawler: false,
        discoveryPoolId: "sam-gov-zero-result-recovery",
        signal: options.signal,
      });
      const candidates = result.opportunities
        .filter((record) => isOfficialSamOpportunityUrl(record.sourceUrl))
        .map((record) => ({
          ...record,
          source: "samGov" as const,
          rawData: {
            ...(record.rawData ?? {}),
            providerName: "samGovPublicSearch",
            evidenceType: "discovery",
            samGovKeylessFallback: true,
            samGovFallbackReason: "structured-zero-results",
          },
        }));
      // Search hits carry no trustworthy dates or agency; keep only notices
      // whose posted date and status are confirmed on the SAM.gov page itself.
      const { verified: records } = await verifySamPublicRecords(candidates, {
        dateRangeDays: Math.max(1, Math.min(364, options.dateRange ?? 30)),
        signal: options.signal,
      });
      if (records.length > 0) {
        console.warn(JSON.stringify({ event: "sam_gov_zero_result_recovered", titleQueries, recovered: records.length }));
      }
      return records;
    } catch (error) {
      console.warn(JSON.stringify({
        event: "sam_gov_zero_result_recovery_failed",
        titleQueries,
        error: error instanceof Error ? error.message : String(error),
      }));
      return [];
    }
  }

  private static addUnique(
    target: NormalizedOpportunity[],
    seen: Set<string>,
    matches: NormalizedOpportunity[],
  ): void {
    for (const opportunity of matches) {
      if (!opportunity.externalId || seen.has(opportunity.externalId)) continue;
      seen.add(opportunity.externalId);
      target.push(opportunity);
    }
  }

  /**
   * Codes the Occu-Med team keeps in the reference profile are searched first,
   * ahead of the built-in taxonomy, so a profile edit changes what is queried.
   */
  private async withProfileCodes(
    queries: SamGovClassificationQuery[],
  ): Promise<SamGovClassificationQuery[]> {
    try {
      const { getOccuMedSearchProfile } = await import("../search/occumedSearchProfile");
      const profile = await getOccuMedSearchProfile();
      if (!profile.loaded) return queries;
      const known = new Set(queries.map((query) => `${query.parameter}:${query.code}`));
      const extra: SamGovClassificationQuery[] = [
        ...profile.naics.map((code) => ({ parameter: "ncode" as const, code, title: "Occu-Med profile NAICS", tier: "registered" as const, effect: "include" as const })),
        ...profile.psc.map((code) => ({ parameter: "ccode" as const, code, title: "Occu-Med profile PSC", tier: "registered" as const, effect: "include" as const })),
      ].filter((query) => !known.has(`${query.parameter}:${query.code}`));
      return [...extra, ...queries];
    } catch {
      return queries;
    }
  }

  private classificationQueriesForRun(
    queries: SamGovClassificationQuery[],
  ): SamGovClassificationQuery[] {
    if (queries.length <= SAM_GOV_CLASSIFICATION_QUERIES_PER_RUN) return queries;
    const selected: SamGovClassificationQuery[] = [];
    for (let offset = 0; offset < SAM_GOV_CLASSIFICATION_QUERIES_PER_RUN; offset += 1) {
      selected.push(queries[(classificationQueryCursor + offset) % queries.length]!);
    }
    classificationQueryCursor =
      (classificationQueryCursor + SAM_GOV_CLASSIFICATION_QUERIES_PER_RUN) % queries.length;
    return selected;
  }

  private async runClassificationQueries(
    queries: SamGovClassificationQuery[],
    baseUrl: string,
    fromDate: Date,
    today: Date,
    signal?: AbortSignal,
  ): Promise<{
    records: NormalizedOpportunity[];
    errors: string[];
    attempted: number;
  }> {
    const records: NormalizedOpportunity[] = [];
    const seen = new Set<string>();
    const errors: string[] = [];
    let attempted = 0;

    for (let index = 0; index < queries.length; index += SAM_GOV_CLASSIFICATION_CONCURRENCY) {
      const batch = queries.slice(index, index + SAM_GOV_CLASSIFICATION_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((query) =>
          samGovCredentials.run((apiKey, slot) =>
            this.runQuery(
              apiKey,
              slot,
              baseUrl,
              { [query.parameter]: query.code },
              fromDate,
              today,
              SAM_GOV_MAX_RESULTS_PER_CLASSIFICATION,
              signal,
            ),
          ),
        ),
      );
      attempted += batch.length;

      let providerCapacityExhausted = true;
      for (let offset = 0; offset < results.length; offset += 1) {
        const result = results[offset]!;
        const query = batch[offset]!;
        if (result.status === "fulfilled") {
          providerCapacityExhausted = false;
          SamGovProvider.addUnique(records, seen, result.value);
          continue;
        }
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        errors.push(`SAM.gov ${query.parameter}=${query.code} (${query.title}) failed: ${message}`);
        if (!/credential pool exhausted|quota|rate.?limit|throttl/i.test(message)) {
          providerCapacityExhausted = false;
        }
      }

      // Once every request in a batch reports exhausted provider capacity, stop
      // rather than repeatedly hammering credentials already placed in cooldown.
      if (providerCapacityExhausted) break;
    }

    return { records, errors, attempted };
  }

  async fetch(options: FetchOptions): Promise<ProviderFetchResult> {
    if (!(await samGovCredentials.isConfigured())) {
      throw new Error("SAM_API_KEY_NOT_CONFIGURED");
    }
    const baseUrl = await this.getBaseUrl();
    const dateRange = Math.max(1, Math.min(364, options.dateRange ?? 30));
    const today = new Date();
    const fromDate = new Date(today);
    fromDate.setDate(today.getDate() - dateRange);
    const limit = Math.max(1, Math.min(options.limit ?? 100, SAM_GOV_MAX_RESULTS_PER_TITLE));
    const normalized: NormalizedOpportunity[] = [];
    const seen = new Set<string>();
    const titleQueries = this.titleQueriesForRun(options.keywords);
    const allClassificationQueries = await this.withProfileCodes(buildSamGovClassificationQueries());
    const classificationQueries = this.classificationQueriesForRun(allClassificationQueries);
    const titleErrors: string[] = [];
    let samCapacityExhausted = false;

    for (const title of titleQueries) {
      try {
        const matches = await samGovCredentials.run((apiKey, slot) =>
          this.runQuery(
            apiKey,
            slot,
            baseUrl,
            { title },
            fromDate,
            today,
            limit,
            options.signal,
          ),
        );
        SamGovProvider.addUnique(normalized, seen, matches);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        titleErrors.push(`SAM.gov title="${title}" failed: ${message}`);
        if (/credential pool exhausted|credential pool cooling down|quota|rate.?limit|throttl/i.test(message)) {
          samCapacityExhausted = true;
          break;
        }
      }
    }

    const classified = samCapacityExhausted
      ? { records: [], errors: [], attempted: 0 }
      : await this.runClassificationQueries(
      classificationQueries,
      baseUrl,
      fromDate,
      today,
      options.signal,
    );
    SamGovProvider.addUnique(normalized, seen, classified.records);

    const diagnostics = {
      queryCount: titleQueries.length + classified.attempted,
      queries: titleQueries,
      targetedQueries: true,
      classificationQueryCount: allClassificationQueries.length,
      classificationQueriesScheduled: classificationQueries.length,
      classificationQueriesAttempted: classified.attempted,
      registeredProfileIsWhitelist: false,
      expandedNaicsCodes: allClassificationQueries
        .filter((query) => query.parameter === "ncode")
        .map((query) => query.code),
      expandedPscCodes: allClassificationQueries
        .filter((query) => query.parameter === "ccode")
        .map((query) => query.code),
      scheduledClassificationCodes: classificationQueries.map(
        (query) => `${query.parameter}:${query.code}`,
      ),
    };

    if (normalized.length === 0) {
      const recovered = await this.recoverOfficialSamPages(options, titleQueries);
      return {
        records: recovered,
        total: recovered.length,
        errors: [
          ...titleErrors,
          ...classified.errors,
          ...(recovered.length > 0
            ? [`SAM.gov structured title/classification queries returned no bid-ready records; recovered ${recovered.length} official SAM.gov opportunity pages through renewable web discovery.`]
            : []),
        ],
        diagnostics: {
          ...diagnostics,
          structuredMatches: 0,
          recoveryUsed: true,
          recovered: recovered.length,
          hydrationProvider: "jina-reader",
          hydratedCount: 0,
        },
      };
    }

    const hydrated = await this.hydrateDescriptions(normalized, options.signal);
    return {
      records: hydrated.records,
      total: hydrated.records.length,
      errors: [...titleErrors, ...classified.errors],
      diagnostics: {
        ...diagnostics,
        structuredMatches: normalized.length,
        recoveryUsed: false,
        recovered: 0,
        hydrationProvider: "jina-reader",
        hydratedCount: hydrated.hydratedCount,
      },
    };
  }

  async getStatus(): Promise<ProviderStatus> {
    const configured = await this.isConfigured();
    let recordCount: number | undefined;
    if (configured) {
      try {
        const rows = await db
          .select({ count: sql<number>`count(*)` })
          .from(opportunitiesTable)
          .where(eq(opportunitiesTable.source, "sam_gov"));
        recordCount = Number(rows[0]?.count ?? 0);
      } catch {}
    }
    return { name: this.name, configured, healthy: configured, recordCount };
  }

  private normalize(opportunity: SamOpportunity): NormalizedOpportunity {
    const parts = (opportunity.fullParentPathName ?? "").split(".");
    const city = opportunity.placeOfPerformance?.city?.name ?? "";
    const state = opportunity.placeOfPerformance?.state?.code ?? "";
    const place = [city, state].filter(Boolean).join(", ") || undefined;
    const awardAmount = opportunity.award?.amount
      ? parseFloat(String(opportunity.award.amount))
      : undefined;
    const originalDescription = opportunity.description?.trim() ?? "";
    const descriptionIsUrl = /^https?:\/\//i.test(originalDescription);
    const metadata: string[] = [];
    if (opportunity.solicitationNumber) metadata.push(`Solicitation: ${opportunity.solicitationNumber}`);
    if (opportunity.typeOfSetAsideDescription) metadata.push(`Set-aside: ${opportunity.typeOfSetAsideDescription}`);
    if (opportunity.naicsCode) metadata.push(`NAICS: ${opportunity.naicsCode}`);
    if (opportunity.classificationCode) metadata.push(`PSC: ${opportunity.classificationCode}`);
    if (opportunity.officeAddress?.city) metadata.push(`Location: ${opportunity.officeAddress.city}, ${opportunity.officeAddress.state ?? ""}`);

    return {
      externalId: opportunity.noticeId ?? opportunity.solicitationNumber ?? "",
      title: opportunity.title ?? "Untitled",
      agency: parts[0]?.trim() ?? "Unknown Agency",
      subAgency: parts[1]?.trim(),
      type: opportunity.type ?? opportunity.baseType ?? "Solicitation",
      status: opportunity.active === "Yes" ? "active" : "archived",
      naicsCode: opportunity.naicsCode,
      postedDate: opportunity.postedDate ? new Date(opportunity.postedDate) : new Date(0),
      responseDeadline: opportunity.responseDeadLine ? new Date(opportunity.responseDeadLine) : undefined,
      setAside: opportunity.typeOfSetAsideDescription ?? opportunity.typeOfSetAside,
      placeOfPerformance: place,
      description: originalDescription && !descriptionIsUrl ? originalDescription : (metadata.length > 0 ? metadata.join(" · ") : undefined),
      solicitationNumber: opportunity.solicitationNumber,
      sourceUrl: opportunity.noticeId ? `https://sam.gov/opp/${opportunity.noticeId}/view` : opportunity.uiLink,
      awardAmount,
      awardee: opportunity.award?.awardee?.name,
      source: this.name,
      rawData: {
        ...(opportunity as Record<string, unknown>),
        providerPlatform: "sam.gov",
        providerNativeId: opportunity.noticeId,
        evidenceType: "direct-structured",
        ...(descriptionIsUrl ? { samDescriptionUrl: originalDescription } : {}),
        ...(!opportunity.postedDate || Number.isNaN(new Date(opportunity.postedDate).getTime()) ? { dateUnknown: true } : {}),
      },
    };
  }
}

export const samGovProvider = new SamGovProvider();
