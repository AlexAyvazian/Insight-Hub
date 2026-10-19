import React, { useEffect, useState } from "react";
import { format } from "date-fns";
import { AlertCircle, ExternalLink, FileText, History, Loader2, ShieldCheck } from "lucide-react";
import { OpportunityStateBadge } from "./OpportunityDecisionState";
import {
  DOCUMENT_STATE_LABELS,
  RELEASE_TAG_LABELS,
  citationDocument,
  citationPages,
  documentInventoryLine,
  documentStateTone,
  freshnessView,
  humanizeCode,
  primaryScopeView,
  providerLabel,
  storedDecision,
  type OpportunityDocumentsResponse,
  type OpportunityVersionsResponse,
} from "./opportunityDecision";

export type LoadState<T> =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: T };

function formatWhen(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? format(date, "MMM d, yyyy h:mm a") : null;
}

/** GETs one evidence route for an opportunity when the detail opens; aborts when it closes or changes. */
export function useOpportunityEvidence<T>(opportunityId: string | null | undefined, kind: "versions" | "documents"): LoadState<T> | null {
  const [state, setState] = useState<LoadState<T> | null>(null);
  useEffect(() => {
    if (!opportunityId) {
      setState(null);
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    const baseUrl = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    fetch(`${baseUrl}/api/opportunities/${encodeURIComponent(opportunityId)}/${kind}`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((data: T) => {
        if (!controller.signal.aborted) setState({ status: "ready", data });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: "error" });
      });
    return () => controller.abort();
  }, [opportunityId, kind]);
  return state;
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
      {children}
    </h4>
  );
}

function Pending({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-white/50">
      <Loader2 className="h-3 w-3 animate-spin" /> {label}
    </div>
  );
}

export function OpportunityEvidenceView({
  opp,
  versions,
  documents,
  now,
}: {
  opp: any;
  versions: LoadState<OpportunityVersionsResponse> | null;
  documents: LoadState<OpportunityDocumentsResponse> | null;
  now?: number;
}) {
  const decision = storedDecision(opp);
  const scope = primaryScopeView(decision?.primaryScope);
  const citations = Array.isArray(decision?.citations) ? decision!.citations! : [];
  const fallbackReasons: string[] = (
    Array.isArray(opp?.relevance?.reasons) && opp.relevance.reasons.length > 0
      ? opp.relevance.reasons
      : Array.isArray(opp?.quality?.reasons)
        ? opp.quality.reasons
        : []
  )
    .map(String)
    .slice(0, 3);
  const freshness = freshnessView(opp);
  const sourceUrl: string | null = opp?.samUrl || opp?.sourceUrl || opp?.url || null;
  const provider: string = opp?.providerName || opp?.source || "manual";
  const mergedSources: string[] = Array.isArray(opp?.crossSource?.sources) ? opp.crossSource.sources.map(String) : [];
  const docData = documents?.status === "ready" ? documents.data : null;
  const unread = Number(docData?.summary?.unread ?? 0);
  const versionList = versions?.status === "ready" ? (versions.data.versions ?? []) : [];

  return (
    <div className="space-y-4 rounded-xl border border-white/10 bg-background/30 p-3" data-testid="opportunity-evidence">
      <div className="flex flex-wrap items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-primary" />
        <OpportunityStateBadge opp={opp} now={now} />
        {decision ? (
          <span className="text-[10px] text-white/50">
            {[
              decision.decisionVersion != null ? `Decision v${decision.decisionVersion}` : "Stored decision",
              decision.method ? humanizeCode(decision.method) : null,
              decision.score != null ? `score ${Math.round(decision.score)}` : null,
              decision.authoritative ? "authoritative" : "flag only",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        ) : (
          <span className="text-[10px] text-white/45">No stored decision yet — shown from the listing classification.</span>
        )}
        {decision?.holdCode && (
          <span className="rounded border border-amber-500/25 bg-amber-500/10 px-1.5 py-px text-[10px] text-amber-200">
            Hold: {humanizeCode(decision.holdCode)}
          </span>
        )}
        {unread > 0 && (
          <span className="rounded border border-amber-500/25 bg-amber-500/10 px-1.5 py-px text-[10px] text-amber-200">
            {unread} unread document{unread === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {decision?.readTimeConflict && (
        <div className="text-[11px] text-amber-200/90 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
          {decision.readTimeConflict}
        </div>
      )}

      <section>
        <SectionHeading>Fit Reasoning</SectionHeading>
        {decision?.reason ? (
          <p className="text-sm text-white/90 leading-relaxed">{decision.reason}</p>
        ) : fallbackReasons.length > 0 ? (
          <ul className="list-disc list-inside text-sm text-white/80 space-y-1">
            {fallbackReasons.map((reason, index) => (
              <li key={index}>{reason}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-white/50">No fit reasoning recorded.</p>
        )}
        {scope && (
          <div className="mt-2 text-[11px] text-white/75">
            <span className="text-muted-foreground">Primary purchased scope:</span>{" "}
            {scope.terms.length > 0 ? scope.terms.join(", ") : scope.evidenced ? "evidenced" : "not evidenced"}
            {scope.kind && scope.kind !== "service" ? ` (${humanizeCode(scope.kind)})` : ""}
            {scope.source && scope.source !== "none" ? ` · from ${scope.source}` : ""}
            {scope.hold ? <div className="text-amber-200/90 mt-0.5">{scope.hold}</div> : null}
          </div>
        )}
        {Array.isArray(decision?.families) && decision!.families!.length > 0 && (
          <div className="mt-1 text-[10px] text-white/45">Reviewed by: {decision!.families!.join(", ")}</div>
        )}
      </section>

      <section>
        <SectionHeading>Evidence Citations</SectionHeading>
        {citations.length > 0 ? (
          <ul className="space-y-2">
            {citations.slice(0, 8).map((citation, index) => {
              const pages = citationPages(citation.section);
              return (
                <li key={index} className="text-[12px] leading-snug">
                  <div className="text-[10px] text-primary/80">
                    {citationDocument(citation.section)}
                    {pages ? ` · p.${pages}` : ""}
                  </div>
                  <blockquote className="border-l-2 border-primary/30 pl-2 text-white/80 italic">
                    “{citation.quote}”
                  </blockquote>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-[12px] text-white/50">No verified citations on record.</p>
        )}
      </section>

      <section>
        <SectionHeading>
          <FileText className="h-3 w-3" /> Documents
        </SectionHeading>
        {documents == null || documents.status === "loading" ? (
          <Pending label="Loading document inventory…" />
        ) : documents.status === "error" ? (
          <p className="text-[12px] text-white/50">Document inventory unavailable.</p>
        ) : (
          <>
            <p className={`text-[12px] ${unread > 0 ? "text-amber-200" : "text-white/75"}`}>
              {unread > 0 && <AlertCircle className="mr-1 inline h-3 w-3" />}
              {documentInventoryLine(documents.data)}
            </p>
            {(documents.data.documents ?? []).length > 0 && (
              <ul className="mt-1.5 space-y-1">
                {(documents.data.documents ?? []).slice(0, 20).map((doc) => (
                  <li key={doc.id} className="flex items-start justify-between gap-2 text-[11px]">
                    <span className="min-w-0 truncate text-white/80" title={doc.title ?? doc.url ?? undefined}>
                      {doc.url ? (
                        <a href={doc.url} target="_blank" rel="noreferrer" className="hover:underline">
                          {doc.title || doc.url}
                        </a>
                      ) : (
                        doc.title || "Untitled document"
                      )}
                      {doc.pages != null && (
                        <span className="text-white/40">
                          {" "}
                          · {doc.pagesRead != null ? `${doc.pagesRead}/` : ""}
                          {doc.pages} pp
                        </span>
                      )}
                    </span>
                    <span className={`shrink-0 ${documentStateTone(doc.state)}`}>
                      {DOCUMENT_STATE_LABELS[doc.state] ?? humanizeCode(doc.state)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <section>
        <SectionHeading>
          <History className="h-3 w-3" /> Version History
        </SectionHeading>
        {versions == null || versions.status === "loading" ? (
          <Pending label="Loading version history…" />
        ) : versions.status === "error" ? (
          <p className="text-[12px] text-white/50">Version history unavailable.</p>
        ) : versionList.length === 0 ? (
          <p className="text-[12px] text-white/50">No recorded versions.</p>
        ) : (
          <>
            {(versions.data.cancelled || Number(versions.data.amendments ?? 0) > 0) && (
              <p className="mb-1 text-[11px] text-amber-200/90">
                {versions.data.cancelled ? "Cancelled. " : ""}
                {Number(versions.data.amendments ?? 0) > 0
                  ? `${versions.data.amendments} amendment${versions.data.amendments === 1 ? "" : "s"}.`
                  : ""}
              </p>
            )}
            <ol className="space-y-1">
              {versionList.slice(0, 12).map((version) => (
                <li key={version.id} className="text-[11px] text-white/75">
                  <span
                    className={
                      version.releaseTag === "cancellation"
                        ? "text-red-300"
                        : version.releaseTag === "amendment"
                          ? "text-amber-200"
                          : "text-primary/80"
                    }
                  >
                    {RELEASE_TAG_LABELS[version.releaseTag] ?? humanizeCode(version.releaseTag)}
                  </span>
                  <span className="text-white/45"> · {formatWhen(version.observedAt) ?? "date unknown"}</span>
                  {Array.isArray(version.changedFields) && version.changedFields.length > 0 && (
                    <span className="text-white/55"> · changed {version.changedFields.map(humanizeCode).join(", ")}</span>
                  )}
                </li>
              ))}
            </ol>
          </>
        )}
      </section>

      <section>
        <SectionHeading>Provenance &amp; Freshness</SectionHeading>
        <div className="space-y-0.5 text-[11px] text-white/75">
          <div>
            <span className="text-muted-foreground">Provider:</span> {providerLabel(provider)}
            {mergedSources.filter((s) => s !== provider).length > 0
              ? ` (also via ${mergedSources.filter((s) => s !== provider).map(providerLabel).join(", ")})`
              : ""}
          </div>
          {sourceUrl && (
            <div className="truncate">
              <span className="text-muted-foreground">Source:</span>{" "}
              <a href={sourceUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
                <ExternalLink className="h-3 w-3" /> {sourceUrl}
              </a>
            </div>
          )}
          <div>
            <span className="text-muted-foreground">Last observed:</span> {formatWhen(freshness.lastObserved) ?? "Unknown"}
          </div>
          <div>
            <span className="text-muted-foreground">Decided:</span> {formatWhen(freshness.decidedAt) ?? "Not yet decided"}
          </div>
          {freshness.stale && (
            <div className="text-amber-200/90">
              Decision is stale{freshness.staleReason ? ` (${humanizeCode(freshness.staleReason)})` : ""}; it will be
              re-evaluated.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

/** Decision, evidence, documents, versions and provenance for one opportunity; evidence routes load on open. */
export function OpportunityEvidencePanel({ opp }: { opp: any }) {
  const versions = useOpportunityEvidence<OpportunityVersionsResponse>(opp?.id, "versions");
  const documents = useOpportunityEvidence<OpportunityDocumentsResponse>(opp?.id, "documents");
  return <OpportunityEvidenceView opp={opp} versions={versions} documents={documents} />;
}
