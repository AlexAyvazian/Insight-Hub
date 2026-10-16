/**
 * Turns stored official award records into Company Watch leads for each watched company.
 *
 * Attribution is decided per company from the RECIPIENT of the official record only:
 *  - confirmed_awardee:   the recipient starts with the company's name / documented alias and it is a new award;
 *  - documented_incumbent: same recipient match, but the action is a modification/option on an existing contract
 *                          (the company already holds that contract and is receiving more work on it);
 *  - possible_match:      only a short acronym-like name matched; shown, but never called a confirmed award.
 * A company named anywhere else in the record (another awardee's text, a description) is never attributed.
 */
import { findAwardee } from "./companyIdentity";
import { assessOccuMedDemand, type DemandAssessment } from "./occuMedDemand";
import { contractNumberKey, type OfficialAward } from "./officialAward";
import type { StoredAward } from "./awardStore";

export type AwardAttribution = "confirmed_awardee" | "documented_incumbent" | "possible_match";

export interface AwardLead {
  awardKey: string;
  source: OfficialAward["source"];
  sourceLabel: string;
  sourceUrl: string | null;
  attribution: AwardAttribution;
  attributionNote: string;
  matchedRecipient: string;
  recipientUei: string | null;
  awardingAgency: string | null;
  amount: number | null;
  contractNumber: string | null;
  modification: boolean | null;
  actionDate: string | null;
  workLocation: string | null;
  popCountry: string | null;
  completionDate: string | null;
  description: string;
  firstSeenAt: string;
  newlyDetected: boolean;
  /** Fields the official source did not state. */
  missing: string[];
  demand: DemandAssessment;
}

export const NEW_DETECTION_HOURS = 72;

const SOURCE_LABELS: Record<OfficialAward["source"], string> = {
  dod_contract_announcement: "Department of War daily contract announcement",
  usaspending: "USAspending.gov award record",
  insight_hub_opportunity: "Award notice in Insight Hub opportunities",
  sam_gov_award_notice: "SAM.gov official award notice (cached in Insight Hub)",
};

/** Recipient entry of a DoD paragraph without its location/contract-number tail, for display. */
function recipientName(entry: string): string {
  return entry.split(/,\s+(?=[A-Z][a-z])/)[0]!.replace(/\s*\([^)]*\)\s*$/, "").trim() || entry;
}

export function buildCompanyLeads(company: string, awards: StoredAward[], now = Date.now()): AwardLead[] {
  const leads: AwardLead[] = [];
  for (const award of awards) {
    const found = findAwardee(award.recipientText, company);
    if (!found) continue;
    const name = recipientName(found.recipient);
    const attribution: AwardAttribution = found.match.basis === "short_name"
      ? "possible_match"
      : award.modification === true ? "documented_incumbent" : "confirmed_awardee";
    const attributionNote = attribution === "possible_match"
      ? `The official record names "${name}". "${company}" is a short name, so this may be a different firm; check the recipient${award.recipientUei ? ` (UEI ${award.recipientUei})` : ""}.`
      : attribution === "documented_incumbent"
        ? `Official record: "${name}" received a modification/option on a contract it already holds (incumbent receiving more work).`
        : `Official record names "${name}" as the awardee${found.match.basis === "alias" ? ` (documented ${company} legal name)` : ""}.`;
    const text = `${award.description} ${award.awardingAgency ?? ""}`;
    const demand = assessOccuMedDemand(text, {
      placeOfPerformanceCountry: award.popCountry,
      placeOfPerformanceText: award.workLocation,
      newAward: award.modification === null ? null : !award.modification,
    }, "award_text");
    const missing = [
      award.amount === null && "amount",
      !award.awardingAgency && "awarding agency",
      !award.workLocation && "work location",
      !award.actionDate && "award date",
      !award.sourceUrl && "source link",
      !award.recipientUei && "recipient UEI",
    ].filter((value): value is string => Boolean(value));
    const seen = Date.parse(award.firstSeenAt);
    leads.push({
      awardKey: award.awardKey,
      source: award.source,
      sourceLabel: SOURCE_LABELS[award.source],
      sourceUrl: award.sourceUrl,
      attribution,
      attributionNote,
      matchedRecipient: name,
      recipientUei: award.recipientUei,
      awardingAgency: award.awardingAgency,
      amount: award.amount,
      contractNumber: award.contractNumber,
      modification: award.modification,
      actionDate: award.actionDate,
      workLocation: award.workLocation,
      popCountry: award.popCountry,
      completionDate: award.completionDate,
      description: award.description,
      firstSeenAt: award.firstSeenAt,
      newlyDetected: Number.isFinite(seen) && now - seen <= NEW_DETECTION_HOURS * 3_600_000,
      missing,
      demand,
    });
  }
  return dedupeLeads(leads);
}

const SOURCE_RANK: Record<OfficialAward["source"], number> = { dod_contract_announcement: 0, usaspending: 1, sam_gov_award_notice: 2, insight_hub_opportunity: 3 };
const ATTRIBUTION_RANK: Record<AwardAttribution, number> = { confirmed_awardee: 0, documented_incumbent: 1, possible_match: 2 };

/** The same contract action seen by two sources is one lead (the DoD announcement wins: it states location). */
export function dedupeLeads(leads: AwardLead[]): AwardLead[] {
  const byContract = new Map<string, AwardLead>();
  const out: AwardLead[] = [];
  for (const lead of [...leads].sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source])) {
    const contract = contractNumberKey(lead.contractNumber);
    if (!contract) { out.push(lead); continue; }
    const key = `${contract}:${lead.modification === true ? `mod:${lead.actionDate}` : "base"}`;
    const existing = byContract.get(key);
    if (!existing) { byContract.set(key, lead); out.push(lead); continue; }
    if (!existing.recipientUei && lead.recipientUei) existing.recipientUei = lead.recipientUei;
    existing.newlyDetected ||= lead.newlyDetected;
  }
  return out.sort((a, b) =>
    Number(b.newlyDetected) - Number(a.newlyDetected)
    || (b.actionDate ?? "").localeCompare(a.actionDate ?? "")
    || ATTRIBUTION_RANK[a.attribution] - ATTRIBUTION_RANK[b.attribution]
    || (b.amount ?? 0) - (a.amount ?? 0));
}
