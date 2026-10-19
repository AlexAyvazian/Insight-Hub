import React, { useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { providerStatusSummary, type ProviderStatusSummary } from "./opportunityDecision";

const TONE_STYLES: Record<ProviderStatusSummary["tone"], string> = {
  ok: "border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-200",
  warn: "border-amber-500/25 bg-amber-500/[0.06] text-amber-200",
  bad: "border-red-500/25 bg-red-500/[0.06] text-red-200",
};

const DOT_STYLES: Record<ProviderStatusSummary["tone"], string> = {
  ok: "bg-emerald-400",
  warn: "bg-amber-400",
  bad: "bg-red-400",
};

export function ProviderStatusChip({ summary }: { summary: ProviderStatusSummary }) {
  const accountsLine =
    summary.accounts > 0
      ? `${summary.accounts - summary.exhausted}/${summary.accounts} accounts available`
      : "No metered accounts recorded";
  const budgetDetail = summary.budgets
    .map((b) =>
      b.limit == null ? `${b.label}: ${b.calls} calls (no cap)` : `${b.label}: ${b.remaining ?? 0}/${b.limit} left`,
    )
    .join("\n");
  const title = [
    accountsLine,
    summary.coolingDown > 0 ? `${summary.coolingDown} cooling down` : null,
    summary.needsConfirmation > 0 ? `${summary.needsConfirmation} need quota confirmation` : null,
    budgetDetail || null,
  ]
    .filter(Boolean)
    .join("\n");
  const exhaustedBudgets = summary.budgets.filter((b) => b.exhausted);
  return (
    <div
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[10px] whitespace-nowrap ${TONE_STYLES[summary.tone]}`}
      title={title}
      data-tone={summary.tone}
    >
      <Activity className="h-3 w-3" />
      <span className={`h-1.5 w-1.5 rounded-full ${DOT_STYLES[summary.tone]}`} />
      <span>{accountsLine}</span>
      {summary.coolingDown > 0 && <span className="opacity-80">· {summary.coolingDown} cooling</span>}
      {exhaustedBudgets.length > 0 ? (
        <span className="opacity-90">· budget spent: {exhaustedBudgets.map((b) => b.label).join(", ")}</span>
      ) : summary.budgets.length > 0 ? (
        <span className="opacity-70">· purpose budgets OK</span>
      ) : null}
    </div>
  );
}

/**
 * Compact provider / quota status from GET /api/release-c/status (accountUsage, orchestration.purposeBudgets).
 * Renders nothing while loading, when the route is unavailable or unauthorized, or when it carries no usage data.
 */
export function ProviderStatusIndicator() {
  const [summary, setSummary] = useState<ProviderStatusSummary | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const baseUrl = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
        const response = await fetch(`${baseUrl}/api/release-c/status`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          // Unauthorized or unavailable: stay hidden and stop polling.
          setSummary(null);
          return;
        }
        setSummary(providerStatusSummary(await response.json()));
      } catch {
        if (!controller.signal.aborted) setSummary(null);
        return;
      }
      if (!controller.signal.aborted) timer = setTimeout(load, 60_000);
    };
    void load();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, []);
  return summary ? <ProviderStatusChip summary={summary} /> : null;
}
