import assert from "node:assert/strict";
import test from "node:test";

process.env.RFP_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.INTEL_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.AUTH_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.APP_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

const [{ tangoContractToRecompete, recompeteNaicsCodes }, { normalizeTangoForecast, tangoPlaceText, tangoPlaceState }] =
  await Promise.all([import("../tangoExpiringContracts"), import("../tangoForecastProvider")]);

function contract(overrides: Record<string, unknown> = {}) {
  return {
    key: "CONT_AWD_75N98024F00123_7529_75N98019D00012_7529",
    piid: "75N98024F00123",
    description: "PROVIDE MEDICAL EXAM SERVICES FOR EMPLOYEES",
    award_date: "2024-03-01",
    total_contract_value: "1250000.50",
    obligated: 400000,
    naics: { code: "621111", description: "Offices of Physicians" },
    recipient: { display_name: "Acme Occupational Health LLC", uei: "ABC123" },
    place_of_performance: { city_name: "Bethesda", state_code: "MD" },
    period_of_performance: {
      start_date: "2024-03-01",
      current_end_date: "2027-02-28",
      ultimate_completion_date: "2027-02-28",
    },
    awarding_office: { office_name: "NIH Acquisition", agency_name: "National Institutes of Health", department_name: "Department of Health and Human Services" },
    set_aside: { description: "Small Business Set-Aside" },
    ...overrides,
  };
}

test("an expiring Tango contract becomes a recompete record with the incumbent named", () => {
  const record = tangoContractToRecompete(contract());
  assert.ok(record);
  assert.equal(record.isRecompete, true);
  assert.equal(record.recompeteEvidence, "incumbent-award");
  assert.equal(record.incumbentName, "Acme Occupational Health LLC");
  assert.equal(record.incumbentAward.expires, "2027-02-28");
  assert.equal(record.incumbentAward.currentValue, 1250000.5);
  assert.equal(record.valueHigh, 1250000.5);
  assert.equal(record.title, "Provide Medical Exam Services For Employees");
  assert.equal(record.agency, "Department of Health and Human Services");
  assert.equal(record.subAgency, "National Institutes of Health");
  assert.equal(record.naics, "621111");
  assert.equal(record.setAside, "Small Business Set-Aside");
  assert.equal(record.state, "MD");
  assert.equal(record.placeOfPerformance, "Bethesda, MD");
  assert.equal(record.estimatedAwardFiscalYear, 2027);
  assert.equal(record.sourceUrl, "https://www.usaspending.gov/award/CONT_AWD_75N98024F00123_7529_75N98019D00012_7529");
});

test("a contract with no named recipient or no end date is not a recompete signal", () => {
  assert.equal(tangoContractToRecompete(contract({ recipient: null })), null);
  assert.equal(tangoContractToRecompete(contract({ period_of_performance: {} })), null);
  assert.equal(tangoContractToRecompete({}), null);
});

test("a key that is not a USAspending award id gets no source link rather than a guessed one", () => {
  const record = tangoContractToRecompete(contract({ key: "7529_75N98024F00123" }));
  assert.ok(record);
  assert.equal(record.sourceUrl, null);
});

test("the NAICS filter narrows to profile codes and is empty when no profile code matches", () => {
  const profile = ["621111", "621112", "541690"];
  assert.deepEqual(recompeteNaicsCodes(profile, undefined), profile);
  assert.deepEqual(recompeteNaicsCodes(profile, "621"), ["621111", "621112"]);
  assert.deepEqual(recompeteNaicsCodes(profile, "621498"), ["621498"]);
  assert.equal(recompeteNaicsCodes(profile, "622"), null);
});

test("Tango forecast place of performance is read from the documented display string", () => {
  assert.equal(tangoPlaceText("Rockville, MD"), "Rockville, MD");
  assert.equal(tangoPlaceState("Rockville, MD"), "MD");
  assert.equal(tangoPlaceState("Washington, DC 20201"), "DC");
  assert.equal(tangoPlaceText({ city: "Austin", state: "TX" }), "Austin, TX");
  assert.equal(tangoPlaceState({ city: "Austin", state: "TX" }), "TX");
  assert.equal(tangoPlaceText(null), null);
});

test("a Tango forecast keeps its place, period and vehicle instead of dropping them", () => {
  const record = normalizeTangoForecast({
    id: 7,
    source_system: "DHS",
    external_id: "F-7",
    agency: "DHS",
    title: "Medical Support Services",
    naics_code: "621999",
    fiscal_year: 2027,
    place_of_performance: "Phoenix, AZ",
    estimated_period: "1 base + 4 option years",
    contract_vehicle: "BPA",
  });
  assert.equal(record.placeOfPerformance, "Phoenix, AZ");
  assert.equal(record.state, "AZ");
  assert.equal(record.estimatedPeriod, "1 base + 4 option years");
  assert.equal(record.contractVehicle, "BPA");
  assert.equal(record.isRecompete, false);
});
