import "./support/useFixtureProfile";
import assert from "node:assert/strict";
import test from "node:test";
import { hasPrimaryOccuMedServiceEvidence, containsCompletePhrase } from "../../opportunityScopeEvidence";
import { opportunityDescriptionContext } from "../opportunityDescriptionContext";
import { classifyOpportunityQuality } from "../../opportunityQuality";

const now = new Date("2026-10-17T20:00:00Z");
const source = {
  agency: "Department of the Army", type: "Solicitation", status: "active", providerName: "tango",
  sourceConfidence: "high", samUrl: "https://sam.gov/opp/test/view",
  responseDeadline: new Date("2026-11-13T00:00:00Z"),
};

test("whole-token matching does not count incidental acronyms or substrings", () => {
  assert.equal(containsCompletePhrase("Under the leadership provision costs", "DER"), false);
  assert.equal(containsCompletePhrase("Under the leadership provision costs", "STS"), false);
  assert.equal(containsCompletePhrase("Provision of Strategic Leaders Programme", "vision"), false);
  assert.equal(containsCompletePhrase("Lead exposure testing", "lead"), true);
  assert.equal(containsCompletePhrase("Employee medical examinations", "medical examinations"), true);
});

test("unrelated primary scopes cannot be called verified because of generic health boilerplate", () => {
  const junk = [
    "Quality Assurance Services - Civil Works and Military Construction Projects",
    "USMCFP SPRINGFIELD - Bio-Medical Waste Removal",
    "Provision of Strategic Leaders Programme",
    "Nurse-Midwife Staff Augmentation",
    "Occupational Therapy Staffing Services",
  ];
  for (const title of junk) {
    assert.equal(hasPrimaryOccuMedServiceEvidence(title, "General medical health and safety requirements"), false, title);
    assert.notEqual(classifyOpportunityQuality({ ...source, title, description: "General medical health and safety requirements" }, now).classification, "verified-open", title);
  }
});

test("specific service titles remain eligible; generic scopes wait for review", () => {
  assert.equal(hasPrimaryOccuMedServiceEvidence("RFP Occupational Health Services", "Employee examinations and drug testing"), true);
  assert.equal(classifyOpportunityQuality({ ...source, title: "RFP Occupational Health Services", description: "Employee examinations and drug testing" }, now).classification, "verified-open");
  const ambiguous = classifyOpportunityQuality({ ...source, title: "RFP - General Medical Contract", description: "Administrative and vendor reporting language only" }, now);
  assert.notEqual(ambiguous.classification, "verified-open");
});

test("recognizes genuine medical-exam and laboratory-testing title abbreviations", () => {
  assert.equal(hasPrimaryOccuMedServiceEvidence("OH Medical Exams Blanket Purchase Agreement (BPA)", "Medical examinations for employees"), true);
  assert.equal(hasPrimaryOccuMedServiceEvidence("Kadena Lab Testing Services BPA", "Clinical laboratory testing for employees"), true);
  assert.equal(hasPrimaryOccuMedServiceEvidence("Boxelder JCC Medical Services", "General administrative requirements"), false);
});

test("AI context preserves evidence in later description sections", () => {
  const fullText = "Administrative boilerplate ".repeat(500) + "\nPre-placement medical examinations required by employer\n" + "Terms and conditions ".repeat(700);
  const excerpt = opportunityDescriptionContext(fullText, 7_000);
  assert.ok(excerpt.includes("Pre-placement medical examinations required by employer"));
  assert.ok(excerpt.includes("[Document excerpt"));
  assert.ok(excerpt.length < fullText.length);
  assert.equal(opportunityDescriptionContext("short description"), "short description");
});
