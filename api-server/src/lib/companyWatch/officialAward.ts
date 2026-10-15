/** One official government contract award record, from any official source, as stored for Company Watch. */
export type OfficialAwardSource = "dod_contract_announcement" | "usaspending" | "insight_hub_opportunity";

export interface OfficialAward {
  /** Stable identity: the same award from the same source always has the same key. */
  awardKey: string;
  source: OfficialAwardSource;
  /** Recipient wording exactly as the record states it (for a multi-award notice, the whole recipient list). */
  recipientText: string;
  recipientUei: string | null;
  awardingAgency: string | null;
  amount: number | null;
  contractNumber: string | null;
  /** true: modification/option on an existing contract; false: new award; null: not stated. */
  modification: boolean | null;
  /** Award / announcement / signature date (YYYY-MM-DD). */
  actionDate: string | null;
  workLocation: string | null;
  /** "USA" for U.S. places of performance, otherwise the stated country; null when not stated. */
  popCountry: string | null;
  description: string;
  sourceUrl: string | null;
  completionDate: string | null;
}

/** Normalized contract number for cross-source de-duplication (W52P1J-20-D-0001 == W52P1J20D0001). */
export function contractNumberKey(value: string | null | undefined): string | null {
  const key = String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return key.length >= 8 ? key : null;
}

const US_STATES = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "Florida", "Georgia",
  "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland",
  "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire",
  "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania",
  "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington",
  "West Virginia", "Wisconsin", "Wyoming", "District of Columbia", "Washington, D.C.", "D.C.", "Puerto Rico", "Guam",
  "U.S. Virgin Islands", "American Samoa", "Northern Mariana Islands", "United States",
];
const STATE_RE = new RegExp(`(?:^|,\\s*|\\s)(?:${US_STATES.map(s => s.replace(/[.]/g, "\\.")).join("|")})\\s*$`, "i");
const UNSPECIFIED = /\b(?:various|multiple|undetermined|to be determined|tbd|locations?|sites?)\b/i;

/**
 * Country of a DoD "Work will be performed in ..." location list. Any non-U.S. place makes the work overseas.
 * Returns null when no location can be classified.
 */
export function locationCountry(location: string | null | undefined): string | null {
  const text = String(location ?? "").replace(/\(\s*\d+(?:\.\d+)?%\s*\)/g, "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const parts = text.split(/;\s*(?:and\s+)?|\s+and\s+(?=[A-Z])/).map(part => part.replace(/[,;\s]+$/, "").trim()).filter(Boolean);
  let domestic = false;
  for (const part of parts) {
    if (STATE_RE.test(part)) { domestic = true; continue; }
    if (UNSPECIFIED.test(part) && !/,/.test(part)) continue;
    const last = part.split(",").pop()?.trim() ?? "";
    if (/^[A-Z][A-Za-z.' -]{2,40}$/.test(last)) return last;
  }
  return domestic ? "USA" : null;
}
