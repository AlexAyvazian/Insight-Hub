import React from "react";
import { Badge } from "@/components/ui/badge";
import {
  DISPLAY_STATE_LABELS,
  DISPLAY_STATE_ORDER,
  DISPLAY_STATE_STYLES,
  humanizeCode,
  opportunityDisplayState,
  storedDecision,
  type OpportunityDisplayState,
} from "./opportunityDecision";

/** Qualified / Needs Review / Provisional / Out of Scope / Closed, from the stored decision when there is one. */
export function OpportunityStateBadge({ opp, now }: { opp: any; now?: number }) {
  const state = opportunityDisplayState(opp, now);
  const decision = storedDecision(opp);
  const title = decision
    ? [
        `Stored decision${decision.decisionVersion != null ? ` v${decision.decisionVersion}` : ""}`,
        decision.holdCode ? `hold: ${humanizeCode(decision.holdCode)}` : null,
        decision.stale ? "stale — awaiting re-evaluation" : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "No stored decision yet; derived from the listing classification";
  return (
    <Badge
      className={`${DISPLAY_STATE_STYLES[state]} text-[10px] border`}
      title={title}
      data-state={state}
    >
      {DISPLAY_STATE_LABELS[state]}
      {decision?.stale ? <span className="ml-1 text-[9px] opacity-75">· stale</span> : null}
    </Badge>
  );
}

/** Chips that filter the loaded page by display state (like the testing-type chips). */
export function OpportunityStateFilter({
  value,
  counts,
  onChange,
}: {
  value: OpportunityDisplayState | null;
  counts: Record<OpportunityDisplayState, number>;
  onChange: (value: OpportunityDisplayState | null) => void;
}) {
  const total = DISPLAY_STATE_ORDER.reduce((sum, state) => sum + (counts[state] ?? 0), 0);
  return (
    <div
      role="group"
      aria-label="Filter by decision state"
      className="mb-4 flex flex-wrap items-center gap-2"
    >
      <span className="mr-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/50">
        Decision
      </span>
      <button
        type="button"
        aria-pressed={value === null}
        onClick={() => onChange(null)}
        className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
          value === null
            ? "border-primary/50 bg-primary/20 text-white"
            : "border-white/10 bg-white/5 text-white/70 hover:border-primary/30 hover:text-white"
        }`}
      >
        All <span className="tabular-nums text-white/60">{total}</span>
      </button>
      {DISPLAY_STATE_ORDER.map((state) => (
        <button
          key={state}
          type="button"
          aria-pressed={value === state}
          disabled={(counts[state] ?? 0) === 0 && value !== state}
          onClick={() => onChange(value === state ? null : state)}
          className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            value === state
              ? DISPLAY_STATE_STYLES[state]
              : "border-white/10 bg-white/5 text-white/70 hover:border-primary/30 hover:text-white"
          }`}
        >
          {DISPLAY_STATE_LABELS[state]}{" "}
          <span className="tabular-nums text-white/60">{counts[state] ?? 0}</span>
        </button>
      ))}
    </div>
  );
}
