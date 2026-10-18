/**
 * TEST FIXTURE ONLY. Frozen, issue-tagged Opportunities audit corpus (audit 2026-10-17/18, findings F-01..F-25).
 *
 * These are synthetic records written to reproduce specific defects against the regression profile in
 * docs/neon-profile/regression/rows.json. They are NOT production records and passing them does not
 * establish live precision or recall; see docs/quality/opportunities-baseline-2026-10-18.md.
 */
export interface AuditCase {
  id: string;
  findings: string[];
  title: string;
  description: string;
}

/** Out-of-scope work that must never become Verified Actionable because of a word or acronym. */
export const HARD_NEGATIVES: AuditCase[] = [
  {
    id: "neg-construction-qa",
    findings: ["F-01", "F-02"],
    title: "Construction Quality Assurance Medical Center Expansion",
    description:
      "Request for proposal for construction quality assurance and inspection at the medical center expansion; contractor costs; OSHA lead requirements.",
  },
  {
    id: "neg-medical-waste",
    findings: ["F-01", "F-02"],
    title: "Medical Waste Hauling and Disposal",
    description:
      "Invitation for bid for regulated medical waste pickup from health clinics; DOT hazmat transport; provider costs.",
  },
  {
    id: "neg-fleet-division",
    findings: ["F-01"],
    title: "Division of Fleet Services Vehicle Maintenance",
    description:
      "Request for proposal. The provider shall maintain vehicle systems, track costs and lead times, and order parts under DOT requirements.",
  },
  {
    id: "neg-bartender",
    findings: ["F-01"],
    title: "Bartender and Catering Services",
    description: "Event catering procurement. Bartender services. Costs and order details. Tender closes Friday.",
  },
  {
    id: "neg-leadership",
    findings: ["F-01"],
    title: "Public Leadership Development Program",
    description:
      "Request for proposal for a leadership training program for department supervisors; provider costs and systems access.",
  },
  {
    id: "neg-physical-plant",
    findings: ["F-01"],
    title: "Physical Plant Supervision Services",
    description:
      "Solicitation for physical plant supervision, building systems operations, and provider costs for the campus.",
  },
  {
    id: "neg-television",
    findings: ["F-01"],
    title: "Television Production and Revision Services",
    description: "Request for proposal for television production, revision, and provision of broadcast systems; all costs included.",
  },
  {
    id: "neg-nurse-staffing",
    findings: ["F-02"],
    title: "Healthcare Staffing Services RFP",
    description:
      "Request for proposal for temporary nurse staffing at county health clinic. Provider shall supply RNs and LPNs.",
  },
  {
    id: "neg-workers-comp",
    findings: ["F-02"],
    title: "Workers' Compensation Third Party Administration",
    description:
      "Request for proposals for workers compensation claims administration including medical case management and return to work.",
  },
];

/** Genuine Occu-Med purchased scope that must not disappear before evidence is evaluated. */
export const HARD_POSITIVES: AuditCase[] = [
  {
    id: "pos-oconus-clearance",
    findings: ["F-04"],
    title: "Medical Clearance Examinations - OCONUS",
    description:
      "Request for quote: provider network to perform deployment medical examinations, DD2795 pre-deployment health assessments, labs and immunizations for contractor personnel at overseas sites.",
  },
  {
    id: "pos-medical-exam-services",
    findings: ["F-04"],
    title: "Medical Examination Services",
    description:
      "The County seeks a contractor to provide pre-employment physical examinations and drug and alcohol testing for county employees. Proposals due Nov 30.",
  },
  {
    id: "pos-dot-testing",
    findings: ["F-01"],
    title: "DOT Drug and Alcohol Testing Services",
    description:
      "Request for proposal for DOT drug and alcohol testing services, including urine specimen collection and breath alcohol testing for safety-sensitive employees.",
  },
  {
    id: "pos-firefighter-physicals",
    findings: ["F-04"],
    title: "Annual Firefighter Physicals",
    description:
      "Request for proposal for NFPA 1582 firefighter physical examinations, medical surveillance, audiometric testing and spirometry for fire department personnel.",
  },
  {
    id: "pos-audiometry-respirator",
    findings: ["F-01"],
    title: "Employee Audiometric Testing and Respirator Fit Testing",
    description:
      "Solicitation for annual audiometric testing, respirator fit testing, and medical surveillance examinations under OSHA 1910.134 for 400 employees.",
  },
];

/** Genuine scope with a vague title: must stay retained for review, not silently dropped or auto-verified. */
export const VAGUE_TITLE_POSITIVE: AuditCase = {
  id: "pos-vague-title",
  findings: ["F-04", "F-23"],
  title: "Professional Services for Employees",
  description:
    "Solicitation for annual audiometric testing, respirator fit testing, and medical surveillance examinations under OSHA 1910.134 for 400 employees.",
};

/** A live re-solicitation that mentions its incumbent award. */
export const RECOMPETE_SOLICITATION: AuditCase = {
  id: "pos-recompete-awarded-to",
  findings: ["F-07"],
  title: "Pre-Employment Physical Examination Services RFP",
  description:
    "Request for proposal for pre-employment physical examinations. The incumbent contract was previously awarded to Acme Clinics in 2021.",
};
