import React, { useEffect, useRef, useState } from "react";
import { format } from "date-fns";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search,
  Filter,
  DownloadCloud,
  Upload,
  ExternalLink,
  Trash2,
  Loader2,
  FileSpreadsheet,
  AlertCircle,
  Clock,
  Sparkles,
} from "lucide-react";
import {
  additionalTestingTypes,
  groupByTestingType,
} from "./opportunityGroups";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ProviderQuotaTelemetry } from "@/components/ProviderQuotaTelemetry";
import {
  OpportunityStateBadge,
  OpportunityStateFilter,
} from "@/components/opportunities/OpportunityDecisionState";
import { OpportunityEvidencePanel } from "@/components/opportunities/OpportunityEvidencePanel";
import { ProviderStatusIndicator } from "@/components/opportunities/ProviderStatusIndicator";
import {
  displayStateCounts,
  opportunityDisplayState,
  type OpportunityDisplayState,
} from "@/components/opportunities/opportunityDecision";
import { useToast } from "@/hooks/use-toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  isOpportunityRunActive,
  isOpportunityRunStale,
  opportunityApiErrorMessage,
  opportunityRunMetrics,
  opportunityRunProgress,
  type OpportunityRunStatus,
} from "./opportunityRunView";

import {
  useListOpportunities,
  useGetSettings,
  useImportOpportunitiesFromCsv,
  useDeleteOpportunity,
  getListOpportunitiesQueryKey,
  useListProviders,
} from "@workspace/api-client-react";

export type OpportunityQualityViewMode =
  | "actionable"
  | "needs-verification"
  | "closed"
  | "all";

export const QUALITY_VIEW_TABS: Array<
  [OpportunityQualityViewMode, string]
> = [
  ["actionable", "Bid-ready & Verified"],
  ["needs-verification", "Early Leads / Verify"],
  ["closed", "Closed / Non-biddable"],
  ["all", "Audit: All Records"],
];

export function qualityViewStatusFilter(
  currentView: OpportunityQualityViewMode,
  requestedStatus: "all" | "active" | "archived",
) {
  return currentView === "all" ? requestedStatus : "all";
}

export function QualityViewTabs({
  value,
  onChange,
}: {
  value: OpportunityQualityViewMode;
  onChange: (value: OpportunityQualityViewMode) => void;
}) {
  return (
    <div className="flex items-center gap-2 px-1 overflow-x-auto">
      {QUALITY_VIEW_TABS.map(([tabValue, label]) => (
        <button
          key={tabValue}
          onClick={() => onChange(tabValue)}
          className={
            "px-3 py-1.5 rounded-full border text-xs transition-all " +
            (value === tabValue
              ? "bg-primary/20 border-primary/40 text-primary font-semibold"
              : "bg-white/5 border-white/10 text-white/65 hover:text-white")
          }
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function opportunityBriefAction(opp: any): {
  enabled: boolean;
  label: string;
} {
  if (opp.quality?.summaryEligible) {
    return { enabled: true, label: "Open RFP brief" };
  }
  return { enabled: true, label: "Open preliminary brief" };
}

type FeedbackGrade = "excellent" | "good" | "poor" | "spam";

interface GradeConfig {
  grade: FeedbackGrade;
  label: string;
  short: string;
}

const GRADE_CONFIGS: GradeConfig[] = [
  { grade: "excellent", label: "Excellent fit", short: "Excellent" },
  { grade: "good", label: "Good fit", short: "Good" },
  { grade: "poor", label: "Poor fit", short: "Poor" },
  { grade: "spam", label: "Not relevant", short: "N/A" },
];

type FetchProviderOption = {
  key: string;
  label: string;
  desc: string;
  stub: boolean;
};

const FETCH_PROVIDER_GROUPS: {
  id: string;
  label: string;
  options: FetchProviderOption[];
}[] = [
  {
    id: "federal_apis",
    label: "Federal Structured Sources",
    options: [
      {
        key: "sam_gov",
        label: "SAM.gov Official API",
        desc: "Independent official SAM.gov retrieval with targeted service queries, Jina hydration, and renewable official-page recovery.",
        stub: false,
      },
      {
        key: "tango",
        label: "Tango Federal Opportunities",
        desc: "Independent structured federal discovery source; results stay discovery evidence until separately judged.",
        stub: false,
      },
    ],
  },
  {
    id: "international_procurement",
    label: "International Procurement",
    options: [
      {
        key: "internationalPublicPortals",
        label: "Canada + Europe Procurement",
        desc: "CanadaBuys official tender discovery plus the EU's keyless TED Search API, anchored to CPV 85147000 Company health services.",
        stub: false,
      },
    ],
  },
  {
    id: "browser_discovery",
    label: "Browser/Search Discovery",
    options: [
      {
        key: "aiDiscovery",
        label: "State, Local & Private Search",
        desc: "Quota-aware renewable search across You.com, Browserbase, Keenable, Parallel, Exa, Firecrawl, LangSearch, Linkup and fallbacks.",
        stub: false,
      },
    ],
  },
];

type IngestionRun = {
  id: string;
  status: OpportunityRunStatus;
  currentProvider?: string | null;
  providersCompleted: number;
  providersTotal: number;
  fetched: number;
  staged: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  created: number;
  updated: number;
  archived: number;
  updatedAt?: string | null;
  heartbeatAt?: string | null;
  startedAt?: string | null;
  statusMessage?: string | null;
  providersFailed?: number;
  providersTimedOut?: number;
  providersSkipped?: number;
  providerErrors?: Array<{ provider: string; error: string }>;
  sources?: Array<{ provider: string; created: number }>;
};

export default function OpportunitiesDashboard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "archived">(
    "all",
  );
  const [qualityView, setQualityView] =
    useState<OpportunityQualityViewMode>("actionable");
  const [type, setType] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [dateFilter, setDateFilter] = useState("90");
  const [page, setPage] = useState(1);
  const [testingTypeFilter, setTestingTypeFilter] = useState<string | null>(null);
  const [decisionStateFilter, setDecisionStateFilter] =
    useState<OpportunityDisplayState | null>(null);
  const PAGE_SIZE = 50;

  const [isFetchOpen, setIsFetchOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isEnriching, setIsEnriching] = useState(false);
  const [isStartingFetch, setIsStartingFetch] = useState(false);
  const [isRetryingFetch, setIsRetryingFetch] = useState(false);
  const [isStoppingFetch, setIsStoppingFetch] = useState(false);
  const [currentRun, setCurrentRun] = useState<IngestionRun | null>(null);
  const [lastStartedRunId, setLastStartedRunId] = useState<string | null>(null);
  const activeRunIds = useRef(new Set<string>());
  const notifiedRunIds = useRef(new Set<string>());
  const summaryRequestRef = useRef<{
    opportunityId: string;
    controller: AbortController;
  } | null>(null);

  const [fetchQuery, setFetchQuery] = useState("");
  const [fetchDays, setFetchDays] = useState("30");
  const [fetchProviders, setFetchProviders] = useState<string[]>([
    "sam_gov",
    "tango",
    "internationalPublicPortals",
    "aiDiscovery",
  ]);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [gradingIds, setGradingIds] = useState<Set<string>>(new Set());

  const [selectedOpportunity, setSelectedOpportunity] = useState<any | null>(
    null,
  );
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryData, setSummaryData] = useState<any | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const { data: settings } = useGetSettings();
  const { data: providersData } = useListProviders();

  const {
    data: oppsData,
    error: opportunitiesError,
    isError: hasOpportunitiesError,
    isLoading: isLoadingOpps,
    refetch: refetchOpportunities,
  } = useListOpportunities({
    search: search || undefined,
    status:
      qualityViewStatusFilter(qualityView, status) !== "all"
        ? (qualityViewStatusFilter(qualityView, status) as any)
        : undefined,
    view: qualityView,
    type: type !== "all" ? type : undefined,
    source: sourceFilter !== "all" ? sourceFilter : undefined,
    dateRange: dateFilter !== "all" ? Number(dateFilter) : undefined,
    page,
    limit: PAGE_SIZE,
  });

  const handleGrade = async (
    opportunityId: string,
    grade: FeedbackGrade,
  ) => {
    setGradingIds((prev) => new Set(prev).add(opportunityId));
    try {
      const baseUrl = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
      const resp = await fetch(
        `${baseUrl}/api/opportunities/${opportunityId}/feedback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grade }),
        },
      );
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || "Failed to submit grade");
      }
      if (selectedOpportunity?.id === opportunityId) {
        setSelectedOpportunity((current: any) =>
          current ? { ...current, userGrade: grade } : current,
        );
      }
      if (grade === "poor" || grade === "spam") {
        queryClient.setQueriesData(
          { queryKey: getListOpportunitiesQueryKey() },
          (current: any) => {
            if (!current || !Array.isArray(current.data)) return current;
            const data = current.data.filter((opportunity: any) => opportunity.id !== opportunityId);
            if (data.length === current.data.length) return current;
            return { ...current, data, total: Math.max(0, Number(current.total ?? data.length + 1) - 1) };
          },
        );
      }
      queryClient.invalidateQueries({
        queryKey: getListOpportunitiesQueryKey(),
      });
      toast({
        title: "Grade saved",
        description:
          grade === "spam"
            ? "Marked not relevant. This scope signal will be down-ranked without poisoning the entire source."
            : `Marked as ${grade}. The relevance model is learning from this scope.`,
      });
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "Grade failed",
        description: err.message,
      });
    } finally {
      setGradingIds((prev) => {
        const next = new Set(prev);
        next.delete(opportunityId);
        return next;
      });
    }
  };

  // Suggested discovery queries come from the server's relevance profile (Neon search bundles).
  const [searchPresets, setSearchPresets] = useState<
    Array<{ key: string; label: string; query: string }>
  >([]);
  useEffect(() => {
    const controller = new AbortController();
    const baseUrl = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    fetch(`${baseUrl}/api/relevance-profile/search-presets`, {
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (data && Array.isArray(data.presets)) setSearchPresets(data.presets);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const baseUrl = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
        const response = await fetch(
          `${baseUrl}/api/opportunities/ingestion-runs/current?ts=${Date.now()}`,
          {
            cache: "no-store",
            headers: { "Cache-Control": "no-cache" },
            signal: controller.signal,
          },
        );
        if (response.ok) {
          const data = await response.json();
          const run = (data.run ?? null) as IngestionRun | null;
          if (!cancelled) {
            setCurrentRun(run);
            if (run && isOpportunityRunActive(run.status)) {
              activeRunIds.current.add(run.id);
            }
            if (
              run &&
              !isOpportunityRunActive(run.status) &&
              activeRunIds.current.has(run.id) &&
              !notifiedRunIds.current.has(run.id)
            ) {
              notifiedRunIds.current.add(run.id);
              queryClient.invalidateQueries({
                queryKey: getListOpportunitiesQueryKey(),
              });
              const discoveryCreated = run.sources?.find(
                (source) => source.provider === "aiDiscovery",
              )?.created;
              if (Number(discoveryCreated) > 0) {
                setQualityView("needs-verification");
                setPage(1);
              }
              toast({
                variant: run.status === "failed" ? "destructive" : "default",
                title:
                  run.status === "completed"
                    ? "Fetch complete"
                    : run.status === "failed"
                      ? "Fetch failed"
                      : "Fetch completed with provider errors",
                description: `Fetched ${run.fetched}. Added ${run.created}, updated ${run.updated}, archived ${run.archived}.`,
              });
            }
          }
        }
      } catch {}
      if (!cancelled) {
        timer =
          currentRun && isOpportunityRunActive(currentRun.status)
            ? setTimeout(
                poll,
                currentRun.providersCompleted > 0 ? 5000 : 3000,
              )
            : undefined;
      }
    };
    void poll();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [queryClient, toast, currentRun?.id, currentRun?.status]);

  const importMutation = useImportOpportunitiesFromCsv({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({
          queryKey: getListOpportunitiesQueryKey(),
        });
        setIsImportOpen(false);
        setImportFile(null);
        toast({
          title: "Import Complete",
          description: `Successfully imported ${data.imported} records. Skipped ${data.skipped}.`,
        });
      },
      onError: (err: any) => {
        toast({
          variant: "destructive",
          title: "Import Failed",
          description: err.error || "Failed to import CSV",
        });
      },
    },
  });

  const deleteMutation = useDeleteOpportunity({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getListOpportunitiesQueryKey(),
        });
        toast({ title: "Opportunity deleted" });
      },
    },
  });

  const handleOpenFetch = () => {
    setFetchQuery(settings?.defaultKeywords || "");
    setFetchDays(settings?.defaultDateRange?.toString() || "30");
    setIsFetchOpen(true);
  };

  const handleEnrich = async () => {
    setIsEnriching(true);
    try {
      const baseUrl = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
      const resp = await fetch(`${baseUrl}/api/opportunities/enrich`, {
        method: "POST",
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Enrichment failed");
      queryClient.invalidateQueries({
        queryKey: getListOpportunitiesQueryKey(),
      });
      toast({
        title: "Enrichment Complete",
        description: `Updated ${data.enriched} records. Agencies: ${data.agencyUpdated}, Deadlines: ${data.deadlineUpdated}, Values: ${data.valueUpdated}.${data.errors?.length ? " Some URLs couldn't be extracted." : ""}`,
      });
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "Enrichment Failed",
        description: err.message,
      });
    } finally {
      setIsEnriching(false);
    }
  };

  const toggleFetchProvider = (key: string) => {
    setFetchProviders((prev) =>
      prev.includes(key)
        ? prev.filter((provider) => provider !== key)
        : [...prev, key],
    );
  };

  const handleFetchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (fetchProviders.length === 0) return;
    void (async () => {
      setIsStartingFetch(true);
      try {
        const baseUrl = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
        const response = await fetch(`${baseUrl}/api/opportunities/fetch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            keywords: fetchQuery.trim(),
            dateRange: parseInt(fetchDays, 10),
            providers: fetchProviders,
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || "Failed to start the manual fetch");
        }
        setCurrentRun(data.run);
        setLastStartedRunId(data.runId);
        activeRunIds.current.add(data.runId);
        toast({
          title: "Fetch started",
          description:
            "Progress is saved. SAM.gov, Tango, and Canada + Europe respect your selections; browser discovery spends renewable quota before lower-priority fallbacks.",
        });
      } catch (err: any) {
        toast({
          variant: "destructive",
          title: "Fetch could not start",
          description: err.message,
        });
      } finally {
        setIsStartingFetch(false);
      }
    })();
  };

  const handleStopRun = async () => {
    if (!currentRun || !isOpportunityRunActive(currentRun.status)) return;
    setIsStoppingFetch(true);
    try {
      const baseUrl = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
      const response = await fetch(
        `${baseUrl}/api/opportunities/ingestion-runs/${currentRun.id}/stop`,
        { method: "POST" },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.details || data.error || "Stop request failed");
      }
      setCurrentRun(data.run);
      toast({
        title: "Stop requested",
        description:
          "The active provider is being cancelled and the run will finalize as cancelled.",
      });
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "Stop failed",
        description: err.message,
      });
    } finally {
      setIsStoppingFetch(false);
    }
  };

  const handleRetryFailedProviders = async () => {
    if (!currentRun) return;
    setIsRetryingFetch(true);
    try {
      const baseUrl = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
      const response = await fetch(
        `${baseUrl}/api/opportunities/ingestion-runs/${currentRun.id}/retry`,
        { method: "POST" },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Retry could not start");
      setCurrentRun(data.run);
      setLastStartedRunId(data.runId);
      activeRunIds.current.add(data.runId);
      toast({
        title: "Retry started",
        description: "Only providers that failed in the prior run were queued.",
      });
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "Retry failed",
        description: err.message,
      });
    } finally {
      setIsRetryingFetch(false);
    }
  };

  const handleImportSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!importFile) return;
    importMutation.mutate({ data: { file: importFile } });
  };

  // Service line label comes from the server's relevance view (Neon profile category); the UI never infers it.
  const getServiceFitLabel = (opp: any): string | null => {
    const category = opp.relevance?.category;
    return typeof category === "string" && category.trim() ? category.trim() : null;
  };

  const getSummaryHint = (opp: any): string | null => {
    const why = opp.relevance?.why;
    if (typeof why === "string" && why.trim()) return why.trim();
    const reasons = opp.relevance?.reasons ?? opp.matchReasons ?? [];
    if (reasons.length > 0) return reasons.slice(0, 2).join(" · ");
    return null;
  };

  const handleOpenSummary = async (opp: any) => {
    summaryRequestRef.current?.controller.abort();
    const controller = new AbortController();
    summaryRequestRef.current = { opportunityId: opp.id, controller };

    setSelectedOpportunity(opp);
    setSummaryOpen(true);
    setSummaryLoading(true);
    setSummaryError(null);
    setSummaryData(null);

    try {
      const baseUrl = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
      const resp = await fetch(
        `${baseUrl}/api/opportunities/${opp.id}/summary`,
        { method: "POST", signal: controller.signal },
      );
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.reason || data.error || "Summary failed");
      }
      if (summaryRequestRef.current?.opportunityId === opp.id) {
        setSummaryData(data);
      }
    } catch (err: any) {
      if (!controller.signal.aborted && summaryRequestRef.current?.opportunityId === opp.id) {
        setSummaryError(err.message || "Summary failed");
      }
    } finally {
      if (summaryRequestRef.current?.opportunityId === opp.id) {
        setSummaryLoading(false);
        summaryRequestRef.current = null;
      }
    }
  };

  const extractAgencyHint = (title: string): string | null => {
    const trimmed = title
      .replace(/^\[PDF\]\s*/i, "")
      .replace(/^\[DOC\]\s*/i, "")
      .trim();
    const patterns = [
      /\bCity of ([A-Z][a-zA-Z\s]{2,30}?)(?:\s+(?:RFP|Request|Bid|Contract|for|–|-)|$)/,
      /\bCounty of ([A-Z][a-zA-Z\s]{2,20}?)(?:\s+(?:RFP|Request|Bid|Contract|for|–|-)|$)/,
      /\b([A-Z][a-zA-Z]{2,20} County)\b/,
      /\b([A-Z][a-zA-Z]{2,20} City)\b/,
      /\bState of ([A-Z][a-zA-Z]{3,20})\b/,
      /^([A-Z][a-zA-Z]{3,30}(?:\s+[A-Z][a-zA-Z]{2,20})?)(?:\s+[-–]|\s+RFP|\s+Request)/,
    ];
    for (const pattern of patterns) {
      const match = trimmed.match(pattern)?.[1]?.trim();
      if (
        match &&
        match.length >= 3 &&
        match.length <= 40 &&
        !/^(Request|Bid|Contract|For|The|And|Or|Of)$/i.test(match)
      ) {
        return match;
      }
    }
    return null;
  };

  const getQualityBadge = (opp: any) => {
    const classification =
      opp.quality?.classification ?? "needs-verification";
    const styles: Record<string, string> = {
      "verified-open":
        "bg-emerald-500/10 text-emerald-300 border-emerald-500/25",
      "needs-verification":
        "bg-amber-500/10 text-amber-300 border-amber-500/25",
      "discovery-only":
        "bg-cyan-500/10 text-cyan-300 border-cyan-500/25",
      closed: "bg-white/5 text-white/50 border-white/10",
      archived: "bg-white/5 text-white/50 border-white/10",
      award: "bg-purple-500/10 text-purple-300 border-purple-500/25",
      forecast: "bg-blue-500/10 text-blue-300 border-blue-500/25",
    };
    return (
      <Badge
        className={`${styles[classification] ?? styles["needs-verification"]} text-[10px] border capitalize`}
      >
        {(opp.quality?.label ?? classification).replaceAll("-", " ")}
      </Badge>
    );
  };

  const getSourceTypeLabel = (opp: any) => {
    const sourceType = opp.quality?.sourceType;
    if (sourceType === "official-direct") return "Official/direct";
    if (sourceType === "verified-solicitation-page") {
      return "Verified solicitation page";
    }
    if (sourceType === "search-discovery") return "Search/discovery";
    if (sourceType === "aggregator") return "Aggregator";
    return "Source unverified";
  };

  const canViewAiBrief = (opp: any) => Boolean(opp.quality?.summaryEligible);
  const aiBriefLabel = (opp: any) => opportunityBriefAction(opp).label;

  const getSourceBadge = (
    source: string | null | undefined,
    name: string | null | undefined,
  ) => {
    const rawName = name || source || "manual";
    const providerMeta: Record<
      string,
      { label: string; classes: string }
    > = {
      samGov: {
        label: "SAM.gov",
        classes: "bg-amber-500/10 text-amber-300 border-amber-500/20",
      },
      sam_gov: {
        label: "SAM.gov",
        classes: "bg-amber-500/10 text-amber-300 border-amber-500/20",
      },
      internationalPublicPortals: {
        label: "Canada + Europe",
        classes: "bg-emerald-500/10 text-emerald-300 border-emerald-500/20",
      },
      you: {
        label: "You.com",
        classes: "bg-sky-500/10 text-sky-300 border-sky-500/20",
      },
      browserbase: {
        label: "Browserbase",
        classes: "bg-blue-500/10 text-blue-300 border-blue-500/20",
      },
      keenable: {
        label: "Keenable",
        classes: "bg-violet-500/10 text-violet-300 border-violet-500/20",
      },
      exa: {
        label: "Exa",
        classes: "bg-cyan-500/10 text-cyan-300 border-cyan-500/20",
      },
      parallel: {
        label: "Parallel",
        classes: "bg-indigo-500/10 text-indigo-300 border-indigo-500/20",
      },
      firecrawl: {
        label: "Firecrawl",
        classes: "bg-orange-500/10 text-orange-300 border-orange-500/20",
      },
      langsearch: {
        label: "LangSearch",
        classes: "bg-teal-500/10 text-teal-300 border-teal-500/20",
      },
      linkup: {
        label: "Linkup",
        classes: "bg-fuchsia-500/10 text-fuchsia-300 border-fuchsia-500/20",
      },
      tango: {
        label: "Tango",
        classes: "bg-orange-500/10 text-orange-300 border-orange-500/20",
      },
      csv_import: {
        label: "CSV Import",
        classes: "bg-white/5 text-muted-foreground border-white/10",
      },
      manual: {
        label: "Manual",
        classes: "bg-white/5 text-muted-foreground border-white/10",
      },
    };
    const meta = providerMeta[rawName] ?? {
      label: rawName.charAt(0).toUpperCase() + rawName.slice(1),
      classes: "bg-white/5 text-muted-foreground border-white/10",
    };
    return (
      <Badge variant="outline" className={`font-normal ${meta.classes}`}>
        {meta.label}
      </Badge>
    );
  };

  const getOpportunityUrl = (opp: any) =>
    opp.samUrl || opp.sourceUrl || opp.url || null;
  const getAgency = (opp: any) =>
    opp.agency === "Unknown"
      ? (extractAgencyHint(opp.title) ?? "—")
      : (opp.agency ?? "—");
  const loadedOpportunities = oppsData?.data ?? [];
  // Decision-state chips filter the loaded page (stored decision first, listing classification as fallback).
  const decisionStateCounts = displayStateCounts(loadedOpportunities);
  const activeDecisionState =
    decisionStateFilter && decisionStateCounts[decisionStateFilter] > 0
      ? decisionStateFilter
      : null;
  const opportunities = activeDecisionState
    ? loadedOpportunities.filter(
        (opp: any) => opportunityDisplayState(opp) === activeDecisionState,
      )
    : loadedOpportunities;
  // Group by the server-assigned primary testing type (largest group first, "Uncategorized" last). The UI never
  // infers a type; the chips below filter the loaded page to one type.
  const allTypeGroups = groupByTestingType(opportunities);
  const activeTestingType = allTypeGroups.some((group) => group.type === testingTypeFilter)
    ? testingTypeFilter
    : null;
  const groupedOpportunities = groupByTestingType(opportunities, activeTestingType).map(
    (group) => [group.type, group.items] as const,
  ) as Array<readonly [string, any[]]>;
  const currentRunIsStale = Boolean(
    currentRun &&
      isOpportunityRunActive(currentRun.status) &&
      isOpportunityRunStale(currentRun.heartbeatAt ?? currentRun.updatedAt),
  );
  const showRunProgress = Boolean(
    currentRun &&
      !currentRunIsStale &&
      (isOpportunityRunActive(currentRun.status) ||
        currentRun.id === lastStartedRunId),
  );

  return (
    <div className="portal-readable flex flex-col gap-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold text-white tracking-tight">
            Opportunity Intelligence
          </h1>
          <p className="text-muted-foreground mt-1">
            Current, bid-ready RFPs that match Occu-Med&apos;s actual service
            lines.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            className="bg-background/50 backdrop-blur-md border-white/10 hover:bg-white/5 hover:text-white"
            onClick={() => setIsImportOpen(true)}
          >
            <Upload className="w-4 h-4 mr-2" /> Import CSV
          </Button>
          <Button
            variant="outline"
            className="bg-background/50 backdrop-blur-md border-white/10 hover:bg-white/5 hover:text-white"
            onClick={handleEnrich}
            disabled={isEnriching}
            title="Backfill missing Agency, Due Date, and Value using managed extraction services"
          >
            {isEnriching ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Sparkles className="w-4 h-4 mr-2" />
            )}
            {isEnriching ? "Enriching..." : "Re-enrich"}
          </Button>
          <Button
            className="bg-primary hover:bg-primary/90 text-white shadow-lg shadow-primary/20"
            onClick={handleOpenFetch}
          >
            <DownloadCloud className="w-4 h-4 mr-2" /> Fetch Intelligence
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-3 px-4 py-2 glass-panel rounded-full overflow-x-auto no-scrollbar">
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold whitespace-nowrap">
          Source Filters:
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setSourceFilter("all");
              setPage(1);
            }}
            className={
              "flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] whitespace-nowrap border transition-all " +
              (sourceFilter === "all"
                ? "bg-primary/20 border-primary/40 text-primary font-bold"
                : "bg-white/5 border-white/10 text-white/60 hover:text-white/90 hover:bg-white/10")
            }
          >
            All
          </button>
          {providersData?.providers
            .filter(
              (provider) =>
                provider.ingestionEligible &&
                ![
                  "publicPortalProviders",
                  "eunaBonfire",
                  "bidnet",
                ].includes(provider.name),
            )
            .map((provider) => {
              const isStub = provider.ingestionMode === "stub";
              const dotClass = isStub
                ? "bg-amber-500/40 border border-amber-500/40"
                : provider.status?.configured
                  ? "bg-emerald-500 shadow-[0_0_4px_rgba(16,185,129,0.5)]"
                  : "bg-white/20";
              const providerKey =
                provider.name === "sam_gov" ? "samGov" : provider.name;
              const isSelected = sourceFilter === providerKey;
              return (
                <button
                  key={provider.name}
                  disabled={isStub}
                  onClick={() => {
                    if (!isStub) {
                      setSourceFilter(isSelected ? "all" : providerKey);
                      setPage(1);
                    }
                  }}
                  className={
                    "flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] whitespace-nowrap border transition-all " +
                    (isStub
                      ? "opacity-40 cursor-not-allowed bg-white/5 border-white/10"
                      : isSelected
                        ? "bg-primary/20 border-primary/40 text-primary font-bold cursor-pointer"
                        : "bg-white/5 border-white/10 hover:bg-white/10 cursor-pointer")
                  }
                  title={
                    isStub
                      ? "Pending direct API wiring"
                      : provider.status?.configured
                        ? `Configured — click to filter by ${provider.displayName}`
                        : "Available source — credentials not configured"
                  }
                >
                  <div className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
                  <span
                    className={
                      isStub
                        ? "text-white/40"
                        : isSelected
                          ? ""
                          : "text-white/80"
                    }
                  >
                    {provider.displayName}
                  </span>
                  {isStub && (
                    <Clock className="w-2.5 h-2.5 text-amber-500/50" />
                  )}
                </button>
              );
            })}
        </div>
        {sourceFilter !== "all" && (
          <button
            onClick={() => {
              setSourceFilter("all");
              setPage(1);
            }}
            className="ml-auto text-[10px] text-muted-foreground hover:text-white transition-colors whitespace-nowrap flex items-center gap-1 shrink-0"
          >
            ✕ Clear filter
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <QualityViewTabs
          value={qualityView}
          onChange={(value) => {
            setQualityView(value);
            setStatus("all");
            setDecisionStateFilter(null);
            setPage(1);
          }}
        />
        <ProviderStatusIndicator />
      </div>

      <div className="glass-panel rounded-2xl p-4 flex flex-col md:flex-row gap-4 items-center">
        <div className="relative flex-1 w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search by title, agency, or NAICS..."
            className="pl-9 bg-background/50 border-white/10 focus-visible:ring-primary/50 text-white"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className="flex items-center gap-3 w-full md:w-auto">
          <Select
            value={status}
            disabled={qualityView !== "all"}
            onValueChange={(value: any) => {
              setStatus(value);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-[140px] bg-background/50 border-white/10 text-white">
              <div className="flex items-center gap-2">
                <Filter className="w-3 h-3 text-muted-foreground" />
                <SelectValue placeholder="Status" />
              </div>
            </SelectTrigger>
            <SelectContent className="bg-popover border-white/10">
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={type}
            onValueChange={(value) => {
              setType(value);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-[160px] bg-background/50 border-white/10 text-white">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent className="bg-popover border-white/10">
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="Solicitation">Solicitation</SelectItem>
              <SelectItem value="Presolicitation">Presolicitation</SelectItem>
              <SelectItem value="Award Notice">Award Notice</SelectItem>
              <SelectItem value="Sources Sought">Sources Sought</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={dateFilter}
            onValueChange={(value) => {
              setDateFilter(value);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-[150px] bg-background/50 border-white/10 text-white">
              <div className="flex items-center gap-2">
                <Clock className="w-3 h-3 text-muted-foreground" />
                <SelectValue placeholder="Date" />
              </div>
            </SelectTrigger>
            <SelectContent className="bg-popover border-white/10">
              <SelectItem value="all">Any Date</SelectItem>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
              <SelectItem value="365">Last year</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="glass-panel rounded-2xl border border-white/10 p-4">
        {isLoadingOpps ? (
          <div className="p-16 text-center">
            <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto" />
          </div>
        ) : hasOpportunitiesError ? (
          <div className="p-16 text-center text-muted-foreground flex flex-col items-center justify-center">
            <AlertCircle className="w-12 h-12 mb-4 text-destructive/70" />
            <h3 className="text-lg font-medium text-white mb-2">
              Opportunities could not be loaded
            </h3>
            <p className="max-w-xl text-sm break-words">
              {opportunityApiErrorMessage(opportunitiesError)}
            </p>
            <Button
              type="button"
              variant="outline"
              className="mt-5 border-white/10 bg-white/5"
              onClick={() => void refetchOpportunities()}
            >
              Try Again
            </Button>
          </div>
        ) : loadedOpportunities.length === 0 ? (
          <div className="p-16 text-center text-muted-foreground flex flex-col items-center justify-center">
            <AlertCircle className="w-12 h-12 mb-4 opacity-25" />
            <h3 className="text-lg font-medium text-white mb-2">
              No opportunities found
            </h3>
            <p className="max-w-sm text-sm">
              Try adjusting your filters or run Fetch Intelligence with a
              tighter query.
            </p>
          </div>
        ) : (
          <>
          <OpportunityStateFilter
            value={activeDecisionState}
            counts={decisionStateCounts}
            onChange={setDecisionStateFilter}
          />
          {allTypeGroups.length > 1 && (
            <div
              role="group"
              aria-label="Filter by testing type"
              className="mb-6 flex flex-wrap items-center gap-2"
            >
              <span className="mr-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/50">
                Testing type
              </span>
              <button
                type="button"
                aria-pressed={activeTestingType === null}
                onClick={() => setTestingTypeFilter(null)}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                  activeTestingType === null
                    ? "border-primary/50 bg-primary/20 text-white"
                    : "border-white/10 bg-white/5 text-white/70 hover:border-primary/30 hover:text-white"
                }`}
              >
                All <span className="tabular-nums text-white/60">{opportunities.length}</span>
              </button>
              {allTypeGroups.map((group) => (
                <button
                  key={group.type}
                  type="button"
                  aria-pressed={activeTestingType === group.type}
                  onClick={() =>
                    setTestingTypeFilter(activeTestingType === group.type ? null : group.type)
                  }
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                    activeTestingType === group.type
                      ? "border-primary/50 bg-primary/20 text-white"
                      : "border-white/10 bg-white/5 text-white/70 hover:border-primary/30 hover:text-white"
                  }`}
                >
                  {group.type}{" "}
                  <span className="tabular-nums text-white/60">{group.items.length}</span>
                </button>
              ))}
            </div>
          )}
          <AnimatePresence>
            {groupedOpportunities.map(([category, categoryOpportunities]) => (
              <section key={category} aria-labelledby={`opportunity-category-${category}`} className="mb-8 last:mb-0">
                <div className="mb-4 flex items-center gap-3">
                  <h2 id={`opportunity-category-${category}`} className="text-sm font-bold uppercase tracking-[0.2em] text-primary [text-shadow:0_0_18px_rgba(72,180,255,0.65)]">{category}</h2>
                  <span className="h-px flex-1 bg-gradient-to-r from-primary/35 to-transparent" />
                  <span className="rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-[10px] font-semibold tabular-nums text-primary/80">{categoryOpportunities.length}</span>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {categoryOpportunities.map((opp: any, index: number) => {
                const href = getOpportunityUrl(opp);
                const urgent =
                  opp.responseDeadline &&
                  new Date(opp.responseDeadline).getTime() - Date.now() <
                    14 * 24 * 60 * 60 * 1000;
                const relScore =
                  opp.relevance?.score ??
                  (typeof opp.relevanceScore === "number"
                    ? Math.round(opp.relevanceScore)
                    : null);
                // Tone follows the canonical verdict from the server, not a local score cutoff.
                const relTone =
                  relScore == null
                    ? ""
                    : opp.relevance?.verdict === "accept"
                      ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/25"
                      : opp.relevance?.verdict === "review"
                        ? "bg-sky-500/10 text-sky-300 border-sky-500/25"
                        : opp.relevance?.verdict === "reject"
                          ? "bg-amber-500/10 text-amber-300 border-amber-500/25"
                          : "bg-white/5 text-muted-foreground border-white/10";
                const serviceFit = getServiceFitLabel(opp);
                const hint =
                  getSummaryHint(opp) ??
                  (serviceFit ? `${serviceFit} opportunity.` : "");
                const dateLabel = opp.responseDeadline ? "Due" : "Posted";
                const dateValue = opp.responseDeadline
                  ? format(new Date(opp.responseDeadline), "MMM d, yyyy")
                  : opp.postedDate
                    ? format(new Date(opp.postedDate), "MMM d, yyyy")
                    : "Date not available";
                const isGrading = gradingIds.has(opp.id);

                return (
                  <motion.article
                    key={opp.id}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ delay: Math.min(index * 0.025, 0.25) }}
                    onClick={() => handleOpenSummary(opp)}
                    className="group relative min-h-[210px] rounded-2xl border border-white/10 bg-blue-950/30 hover:bg-blue-950/40 hover:border-primary/30 transition-all duration-200 p-4 flex flex-col gap-3 shadow-lg shadow-black/10 cursor-pointer"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex flex-wrap gap-2 items-center">
                        {getSourceBadge(opp.source, opp.providerName)}
                        <OpportunityStateBadge opp={opp} />
                        {getQualityBadge(opp)}
                        {relScore != null && (
                          <Badge
                            className={`${relTone} font-semibold tabular-nums text-[10px] border`}
                            title="Occu-Med relevance score"
                          >
                            {relScore}% match
                          </Badge>
                        )}
                      </div>
                      <Badge
                        className={
                          opp.quality?.classification === "verified-open"
                            ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/20 text-[10px] border"
                            : "bg-white/5 text-muted-foreground border-white/10 text-[10px] border"
                        }
                      >
                        {opp.quality?.classification === "verified-open"
                          ? "open"
                          : (opp.quality?.classification ?? opp.status)}
                      </Badge>
                    </div>

                    <div className="space-y-2 flex-1 min-w-0">
                      <h3 className="text-sm font-semibold leading-snug text-white line-clamp-3 group-hover:text-primary transition-colors">
                        {opp.title}
                      </h3>
                      <p
                        className="text-[11px] text-primary/80 leading-snug line-clamp-3"
                        title={hint}
                      >
                        {opp.relevance?.decisionMethod && (
                          <span className="mr-1.5 rounded border border-primary/30 px-1 py-px text-[9px] uppercase tracking-wide text-primary/70">
                            {opp.relevance.decisionMethod === "rule"
                              ? "Rule match"
                              : opp.relevance.decisionMethod === "ai-panel"
                                ? "AI panel"
                                : "AI judge"}
                          </span>
                        )}
                        {hint}
                      </p>
                      <div className="text-[11px] text-white/70">
                        <span className="text-muted-foreground">Agency:</span>{" "}
                        {getAgency(opp)}
                      </div>
                      <div
                        className={`text-[11px] ${urgent ? "text-amber-300 font-medium" : "text-white/70"}`}
                      >
                        <span className="text-muted-foreground">
                          {dateLabel}:
                        </span>{" "}
                        {dateValue}
                      </div>
                      <div className="text-[11px] text-primary/70 font-medium">
                        {[serviceFit, getSourceTypeLabel(opp)].filter(Boolean).join(" · ")}
                      </div>
                      {additionalTestingTypes(opp).length > 0 && (
                        <div className="text-[11px] text-white/70">
                          <span className="text-muted-foreground">Also covers:</span>{" "}
                          {additionalTestingTypes(opp).slice(0, 3).join(" · ")}
                        </div>
                      )}
                    </div>

                    <div
                      className="flex flex-wrap items-center gap-1 pt-2 border-t border-white/5"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <span className="mr-1 text-[9px] uppercase tracking-wider text-white/35">
                        Quality
                      </span>
                      {GRADE_CONFIGS.map(({ grade, label, short }) => {
                        const isActive = opp.userGrade === grade;
                        return (
                          <button
                            key={grade}
                            type="button"
                            title={
                              grade === "spam"
                                ? "Mark not relevant before opening or generating an AI brief"
                                : label
                            }
                            disabled={isGrading}
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleGrade(opp.id, grade);
                            }}
                            className={`rounded-md border px-1.5 py-0.5 text-[9px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                              isActive
                                ? "border-primary/40 bg-primary/15 text-primary"
                                : grade === "spam"
                                  ? "border-red-300/15 bg-red-300/[0.04] text-red-200/65 hover:bg-red-300/10 hover:text-red-100"
                                  : "border-white/10 bg-white/[0.03] text-white/50 hover:bg-white/8 hover:text-white/80"
                            }`}
                          >
                            {isGrading && isActive ? (
                              <Loader2 className="inline h-2.5 w-2.5 animate-spin" />
                            ) : (
                              short
                            )}
                          </button>
                        );
                      })}
                    </div>

                    <div className="flex items-center justify-between gap-2 pt-1">
                      <div
                        className={
                          "flex items-center gap-1 text-[10px] transition-colors " +
                          (canViewAiBrief(opp)
                            ? "text-primary/70 group-hover:text-primary"
                            : "text-amber-300/75")
                        }
                        title={
                          opp.summaryIneligibilityReason ??
                          opp.quality?.reasons?.[0] ??
                          undefined
                        }
                      >
                        <Sparkles className="w-3 h-3" /> {aiBriefLabel(opp)}
                      </div>
                      <div className="flex items-center gap-1">
                        {href && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 hover:bg-white/10 hover:text-white"
                            asChild
                            onClick={(event) => event.stopPropagation()}
                          >
                            <a href={href} target="_blank" rel="noreferrer">
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          </Button>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 hover:bg-destructive/20 hover:text-destructive text-muted-foreground"
                          onClick={(event) => {
                            event.stopPropagation();
                            if (confirm("Delete this opportunity?")) {
                              deleteMutation.mutate({ id: opp.id });
                            }
                          }}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  </motion.article>
                );
              })}
                </div>
              </section>
            ))}
          </AnimatePresence>
          </>
        )}

        {Boolean((oppsData as any)?.ranking?.truncated) && (
          <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-4 py-3 text-xs text-amber-100">
            Ranking reached its bounded candidate window. Refine the search or filters for an exact total.
          </div>
        )}

        {oppsData && oppsData.total > 0 && (
          <div className="mt-4 pt-4 border-t border-white/10 flex flex-col sm:flex-row justify-between gap-3 sm:items-center text-sm text-muted-foreground">
            <span>
              Showing {(page - 1) * PAGE_SIZE + 1}–
              {Math.min(page * PAGE_SIZE, oppsData.total)} of {oppsData.total}{" "}
              results
            </span>
            <div className="flex items-center gap-2">
              <span className="text-xs">
                Page {page} of {Math.ceil(oppsData.total / PAGE_SIZE)}
              </span>
              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  className="h-8 border-white/10 bg-transparent hover:bg-white/5 disabled:opacity-30"
                >
                  Prev
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page * PAGE_SIZE >= oppsData.total}
                  onClick={() => setPage((current) => current + 1)}
                  className="h-8 border-white/10 bg-transparent hover:bg-white/5 disabled:opacity-30"
                >
                  Next
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      <Dialog open={isFetchOpen} onOpenChange={setIsFetchOpen}>
        <DialogContent className="bg-popover/95 backdrop-blur-xl border-white/10 text-white sm:max-w-[720px]">
          <form onSubmit={handleFetchSubmit}>
            <DialogHeader>
              <DialogTitle className="font-display text-xl">
                Fetch Intelligence
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {showRunProgress
                  ? "Manual ingestion progress is persisted while you navigate or refresh."
                  : "Run the hardened opportunity ensemble: SAM.gov, Tango, CanadaBuys/TED, and quota-aware browser search can run independently. Candidates are deduplicated and judged before promotion."}
              </DialogDescription>
            </DialogHeader>
            <div className="pt-4">
              <ProviderQuotaTelemetry />
            </div>
            {showRunProgress && currentRun ? (
              <div className="grid gap-5 py-6">
                <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-xs uppercase tracking-widest text-muted-foreground">
                        Run status
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-sm font-medium capitalize">
                        {isOpportunityRunActive(currentRun.status) && (
                          <Loader2 className="h-4 w-4 animate-spin text-primary" />
                        )}
                        {currentRun.status.replaceAll("_", " ")}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-muted-foreground">
                        Providers
                      </div>
                      <div className="text-lg font-semibold">
                        {currentRun.providersCompleted}/{currentRun.providersTotal}
                      </div>
                    </div>
                  </div>
                  <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full rounded-full bg-primary transition-all duration-500"
                      style={{
                        width: `${opportunityRunProgress(
                          currentRun.providersCompleted,
                          currentRun.providersTotal,
                        )}%`,
                      }}
                    />
                  </div>
                  {currentRun.currentProvider && (
                    <p className="mt-3 text-xs text-white/70">
                      Running:{" "}
                      <span className="font-medium text-white">
                        {currentRun.currentProvider === "aiDiscovery"
                          ? "AI Opportunity Discovery"
                          : currentRun.currentProvider === "samGov"
                            ? "SAM.gov Official API"
                            : currentRun.currentProvider === "tango"
                              ? "Tango Federal Opportunities"
                              : currentRun.currentProvider === "internationalPublicPortals"
                                ? "Canada + Europe Procurement"
                                : currentRun.currentProvider}
                      </span>
                    </p>
                  )}
                  {currentRun.statusMessage && (
                    <p className="mt-2 text-xs text-white/60">
                      {currentRun.statusMessage}
                    </p>
                  )}
                  <p className="mt-2 text-xs text-white/60">
                    Heartbeat:{" "}
                    {currentRun.heartbeatAt
                      ? `${Math.max(
                          0,
                          Math.round(
                            (Date.now() -
                              new Date(currentRun.heartbeatAt).getTime()) /
                              1000,
                          ),
                        )}s ago`
                      : "not reported"}
                    {currentRun.startedAt
                      ? ` · Elapsed ${Math.max(
                          0,
                          Math.round(
                            (Date.now() -
                              new Date(currentRun.startedAt).getTime()) /
                              1000,
                          ),
                        )}s`
                      : ""}
                  </p>
                  {isOpportunityRunActive(currentRun.status) &&
                    isOpportunityRunStale(currentRun.heartbeatAt) && (
                      <p className="mt-2 text-xs text-amber-300">
                        Heartbeat is stale; the backend should recover this run
                        before another start.
                      </p>
                    )}
                </div>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                  {opportunityRunMetrics(currentRun).map(([label, value]) => (
                    <div
                      key={label}
                      className="rounded-lg border border-white/10 bg-background/30 px-3 py-2"
                    >
                      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
                        {label}
                      </div>
                      <div className="mt-0.5 text-base font-semibold">
                        {value}
                      </div>
                    </div>
                  ))}
                </div>
                {(currentRun.providerErrors?.length ?? 0) > 0 && (
                  <div className="max-h-36 space-y-2 overflow-y-auto rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-3">
                    <div className="text-[10px] uppercase tracking-wider text-amber-300">
                      Provider warnings / errors
                    </div>
                    {currentRun.providerErrors!.map((item) => (
                      <p
                        key={`${item.provider}-${item.error}`}
                        className="text-xs text-white/75"
                      >
                        <span className="font-medium text-white">
                          {item.provider}:
                        </span>{" "}
                        {item.error}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="grid gap-5 py-6">
                {currentRunIsStale && (
                  <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-3 text-xs text-amber-100">
                    The previous run stopped reporting progress. Starting this
                    manual run will safely mark it failed and continue.
                  </div>
                )}
                <div className="grid gap-2">
                  <Label className="text-xs uppercase tracking-widest text-muted-foreground">
                    Sources
                  </Label>
                  <div className="grid gap-4 max-h-[390px] overflow-y-auto pr-1">
                    {FETCH_PROVIDER_GROUPS.map((group) => (
                      <div key={group.id} className="grid gap-2">
                        <div className="text-[10px] uppercase tracking-wider text-white/45">
                          {group.label}
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                          {group.options.map(({ key, label, desc, stub }) => {
                            const checked = fetchProviders.includes(key);
                            return (
                              <button
                                key={key}
                                type="button"
                                disabled={stub}
                                onClick={() =>
                                  !stub && toggleFetchProvider(key)
                                }
                                className={`flex items-start gap-2.5 p-2.5 rounded-lg border text-left transition-colors ${
                                  stub
                                    ? "border-white/5 bg-white/2 opacity-40 cursor-not-allowed"
                                    : checked
                                      ? "border-primary/40 bg-primary/10 cursor-pointer"
                                      : "border-white/10 bg-white/3 hover:bg-white/5 cursor-pointer"
                                }`}
                              >
                                <div
                                  className={`mt-0.5 w-3.5 h-3.5 rounded-sm border flex-shrink-0 flex items-center justify-center ${
                                    stub
                                      ? "border-white/20"
                                      : checked
                                        ? "border-primary bg-primary"
                                        : "border-white/20"
                                  }`}
                                >
                                  {checked && !stub && (
                                    <svg
                                      className="w-2 h-2 text-white"
                                      viewBox="0 0 12 12"
                                      fill="none"
                                    >
                                      <path
                                        d="M2 6l3 3 5-5"
                                        stroke="currentColor"
                                        strokeWidth="1.5"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                      />
                                    </svg>
                                  )}
                                </div>
                                <div className="min-w-0">
                                  <div className="flex items-center gap-1.5">
                                    <span className="text-xs font-medium leading-none">
                                      {label}
                                    </span>
                                    {stub && (
                                      <span className="inline-flex items-center gap-0.5 text-[9px] text-amber-500/70 font-medium">
                                        <Clock className="w-2.5 h-2.5" /> Pending
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-[10px] text-muted-foreground mt-0.5">
                                    {desc}
                                  </p>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                  {fetchProviders.length === 0 && (
                    <p className="text-[11px] text-amber-400">
                      Select at least one source to fetch from.
                    </p>
                  )}
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="query">Search Query</Label>
                  <div className="relative">
                    <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
                    <Input
                      id="query"
                      value={fetchQuery}
                      onChange={(e) => setFetchQuery(e.target.value)}
                      placeholder='e.g. "occupational health services" government RFP due in 30 days'
                      className="bg-background/50 border-white/10 pl-9"
                    />
                  </div>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {searchPresets.map((preset) => (
                      <button
                        key={preset.key}
                        type="button"
                        title={preset.query}
                        onClick={() => setFetchQuery(preset.query)}
                        className="text-[10px] px-2 py-1 rounded-full border border-white/10 bg-white/5 hover:bg-white/10 text-white/80"
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="days">Date Range (Days Back)</Label>
                  <Input
                    id="days"
                    type="number"
                    value={fetchDays}
                    onChange={(e) => setFetchDays(e.target.value)}
                    min="1"
                    max="365"
                    className="bg-background/50 border-white/10"
                  />
                </div>
              </div>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setIsFetchOpen(false)}
                className="hover:bg-white/5"
              >
                Cancel
              </Button>
              {showRunProgress && currentRun ? (
                <>
                  {isOpportunityRunActive(currentRun.status) && (
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={handleStopRun}
                      disabled={isStoppingFetch}
                    >
                      {isStoppingFetch && (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      )}
                      Stop Run
                    </Button>
                  )}
                  {!isOpportunityRunActive(currentRun.status) &&
                    (currentRun.providerErrors?.length ?? 0) > 0 && (
                      <Button
                        type="button"
                        onClick={handleRetryFailedProviders}
                        disabled={isRetryingFetch}
                        className="bg-primary hover:bg-primary/90"
                      >
                        {isRetryingFetch && (
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        )}
                        Retry Problem Sources
                      </Button>
                    )}
                  {!isOpportunityRunActive(currentRun.status) && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setLastStartedRunId(null)}
                      className="border-white/10 bg-white/5"
                    >
                      New Manual Run
                    </Button>
                  )}
                </>
              ) : (
                <Button
                  type="submit"
                  disabled={isStartingFetch || fetchProviders.length === 0}
                  className="bg-primary hover:bg-primary/90"
                >
                  {isStartingFetch ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <DownloadCloud className="w-4 h-4 mr-2" />
                  )}
                  {isStartingFetch ? "Starting..." : "Start Fetch"}
                </Button>
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={isImportOpen} onOpenChange={setIsImportOpen}>
        <DialogContent className="bg-popover/95 backdrop-blur-xl border-white/10 text-white sm:max-w-[425px]">
          <form onSubmit={handleImportSubmit}>
            <DialogHeader>
              <DialogTitle className="font-display text-xl">
                Import CSV
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                Upload a CSV file containing historical opportunities.
              </DialogDescription>
            </DialogHeader>
            <div className="py-8">
              <label
                htmlFor="file-upload"
                className="flex flex-col items-center justify-center w-full h-32 border-2 border-white/10 border-dashed rounded-xl cursor-pointer bg-background/30 hover:bg-white/5 transition-colors"
              >
                <div className="flex flex-col items-center justify-center pt-5 pb-6">
                  <FileSpreadsheet className="w-8 h-8 mb-3 text-muted-foreground" />
                  <p className="mb-2 text-sm text-muted-foreground">
                    <span className="font-semibold text-white">
                      Click to upload
                    </span>{" "}
                    or drag and drop
                  </p>
                  <p className="text-xs text-muted-foreground/70">
                    CSV files only
                  </p>
                </div>
                <input
                  id="file-upload"
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onChange={(e) => setImportFile(e.target.files?.[0] || null)}
                />
              </label>
              {importFile && (
                <div className="mt-4 p-3 bg-primary/10 border border-primary/20 rounded-lg flex items-center gap-3">
                  <FileSpreadsheet className="w-4 h-4 text-primary" />
                  <span className="text-sm font-medium text-primary">
                    {importFile.name}
                  </span>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setIsImportOpen(false)}
                className="hover:bg-white/5"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!importFile || importMutation.isPending}
                className="bg-primary hover:bg-primary/90"
              >
                {importMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Upload className="w-4 h-4 mr-2" />
                )}
                {importMutation.isPending ? "Importing..." : "Upload & Import"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={summaryOpen} onOpenChange={setSummaryOpen}>
        <DialogContent className="bg-popover/95 backdrop-blur-xl border-white/10 text-white sm:max-w-[640px] max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-display text-xl flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-primary" /> RFP Brief
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {selectedOpportunity?.title ?? "Opportunity summary"}
            </DialogDescription>
          </DialogHeader>

          <div className="py-2 space-y-5">
            {selectedOpportunity && (
              <OpportunityEvidencePanel opp={selectedOpportunity} />
            )}
            {summaryLoading ? (
              <div className="py-12 text-center space-y-3">
                <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto" />
                <p className="text-sm text-muted-foreground">
                  Analyzing RFP...
                </p>
              </div>
            ) : summaryError ? (
              <div className="p-4 rounded-xl border border-destructive/20 bg-destructive/10 text-sm text-destructive/90">
                {summaryError}
              </div>
            ) : summaryData ? (
              <div className="space-y-5">
                {summaryData.preliminary && (
                  <div className="text-[11px] text-amber-200/90 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                    Preliminary brief from saved search evidence. Verify the
                    source before treating this as bid-ready.
                    {summaryData.verificationReason
                      ? ` ${summaryData.verificationReason}`
                      : ""}
                  </div>
                )}
                {summaryData.provider === "fallback" && (
                  <div className="text-[11px] text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                    AI summary unavailable. Showing stored description instead.
                  </div>
                )}

                <section>
                  <h4 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
                    Plain-English Summary
                  </h4>
                  <p className="text-sm text-white/90 leading-relaxed">
                    {summaryData.summary}
                  </p>
                </section>

                <section>
                  <h4 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
                    Why It May Matter to Occu-Med
                  </h4>
                  <p className="text-sm text-white/90 leading-relaxed">
                    {summaryData.occumedFit}
                  </p>
                </section>

                <section>
                  <h4 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
                    Likely Service Lines
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {(summaryData.serviceLines ?? []).map(
                      (line: string, index: number) => (
                        <Badge
                          key={index}
                          className="bg-primary/10 text-primary border-primary/20 text-[11px]"
                        >
                          {line}
                        </Badge>
                      ),
                    )}
                    {(!summaryData.serviceLines ||
                      summaryData.serviceLines.length === 0) && (
                      <span className="text-sm text-white/50">
                        No service lines identified
                      </span>
                    )}
                  </div>
                </section>

                {Array.isArray(summaryData.testsRequested) &&
                  summaryData.testsRequested.length > 0 && (
                    <section>
                      <h4 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
                        Tests Requested
                      </h4>
                      <div className="flex flex-wrap gap-2">
                        {summaryData.testsRequested.map(
                          (test: string, index: number) => (
                            <Badge
                              key={index}
                              className="bg-primary/10 text-primary border-primary/20 text-[11px]"
                            >
                              {test}
                            </Badge>
                          ),
                        )}
                      </div>
                    </section>
                  )}

                {typeof summaryData.scope === "string" &&
                  summaryData.scope.trim() !== "" && (
                    <section>
                      <h4 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
                        Scope
                      </h4>
                      <p className="text-sm text-white/90 leading-relaxed">
                        {summaryData.scope}
                      </p>
                    </section>
                  )}

                <section>
                  <h4 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
                    Key Dates / Deadline
                  </h4>
                  <div className="text-sm text-white/90 space-y-1">
                    <div>
                      <span className="text-muted-foreground">Posted:</span>{" "}
                      {summaryData.keyDates?.posted ?? "Not available"}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Due:</span>{" "}
                      {summaryData.keyDates?.due ?? "Not available"}
                    </div>
                  </div>
                </section>

                <section>
                  <h4 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
                    Agency / Buyer
                  </h4>
                  <p className="text-sm text-white/90">
                    {summaryData.buyer ?? "Not available"}
                  </p>
                </section>

                <section>
                  <h4 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
                    Estimated Value
                  </h4>
                  <p className="text-sm text-white/90">
                    {summaryData.estimatedValue ?? "Not available"}
                  </p>
                </section>

                <section>
                  <h4 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
                    Bid / No-Bid Notes
                  </h4>
                  <ul className="list-disc list-inside text-sm text-white/90 space-y-1">
                    {(summaryData.bidNotes ?? []).map(
                      (note: string, index: number) => (
                        <li key={index}>{note}</li>
                      ),
                    )}
                    {(!summaryData.bidNotes ||
                      summaryData.bidNotes.length === 0) && (
                      <li className="text-white/50">
                        No bid notes available
                      </li>
                    )}
                  </ul>
                </section>

                <section>
                  <h4 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
                    Missing Information
                  </h4>
                  <ul className="list-disc list-inside text-sm text-white/90 space-y-1">
                    {(summaryData.missingInfo ?? []).map(
                      (item: string, index: number) => (
                        <li key={index}>{item}</li>
                      ),
                    )}
                    {(!summaryData.missingInfo ||
                      summaryData.missingInfo.length === 0) && (
                      <li className="text-white/50">
                        No missing information flagged
                      </li>
                    )}
                  </ul>
                </section>

                {summaryData.sourceUrl && (
                  <section>
                    <h4 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
                      Source Link
                    </h4>
                    <a
                      href={summaryData.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm text-primary hover:underline break-all inline-flex items-center gap-1"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />{" "}
                      {summaryData.sourceUrl}
                    </a>
                  </section>
                )}
              </div>
            ) : null}
          </div>

          {selectedOpportunity && (
            <DialogFooter className="flex-col sm:flex-row gap-2 sm:justify-between items-start sm:items-center border-t border-white/10 pt-4">
              <div className="flex items-center gap-1 flex-wrap">
                {GRADE_CONFIGS.map(({ grade, label, short }) => {
                  const isActive = selectedOpportunity.userGrade === grade;
                  const isGrading = gradingIds.has(selectedOpportunity.id);
                  return (
                    <button
                      key={grade}
                      type="button"
                      title={label}
                      disabled={isGrading}
                      onClick={() =>
                        void handleGrade(selectedOpportunity.id, grade)
                      }
                      className={`px-2 py-1 rounded-md border text-[10px] transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed ${
                        isActive
                          ? "bg-white/15 border-white/30 text-white font-medium"
                          : "border-white/10 text-muted-foreground bg-transparent hover:bg-white/5 hover:text-white/80 hover:border-white/20"
                      }`}
                    >
                      {isGrading && isActive ? (
                        <Loader2 className="w-3 h-3 animate-spin inline" />
                      ) : (
                        short
                      )}
                    </button>
                  );
                })}
              </div>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setSummaryOpen(false)}
                className="hover:bg-white/5"
              >
                Close
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
