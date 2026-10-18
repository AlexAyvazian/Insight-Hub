/** Machine labels for why a notice was accepted or rejected. These are code labels, not relevance vocabulary. */
export const REASON_CODES = {
  explicit: "PATH_A_EXPLICIT_SERVICE_MATCH",
  component: "PATH_B_COMPONENT_COMBINATION",
  regulatory: "PATH_C_REGULATORY_PROGRAM",
  network: "PATH_D_NETWORK_MANAGED_DELIVERY",
  genericScope: "PATH_E_GENERIC_TITLE_SPECIFIC_SCOPE",
  negative: "CONDITIONAL_FALSE_POSITIVE_RULE",
  hardReject: "HARD_REJECT_NON_BIDDABLE_OR_JUNK",
  procurementOnly: "PROCUREMENT_SIGNAL_ONLY_NOT_RELEVANT",
  portalVerified: "PORTAL_DIRECT_RELEVANCE_EVIDENCE",
  portalLikely:
    "PORTAL_HIGH_PROPENSITY_BUYER_WITH_OFFICIAL_PROCUREMENT_EVIDENCE",
  notProcurementNotice: "NOT_A_PROCUREMENT_NOTICE",
  authenticityHold: "PROCUREMENT_AUTHENTICITY_REVIEW_HOLD",
} as const;
