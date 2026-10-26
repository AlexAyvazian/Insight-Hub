import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const baseUrl = process.env.INSIGHT_E2E_BASE_URL ?? "http://127.0.0.1:4173";
const browserEngine = process.env.INSIGHT_E2E_BROWSER ?? "chromium";
const browserType = { chromium, firefox, webkit }[browserEngine];
if (!browserType) throw new Error(`Unsupported INSIGHT_E2E_BROWSER: ${browserEngine}`);

const future = new Date(Date.now() + 45 * 86_400_000).toISOString();
const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();

async function waitForServer() {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(baseUrl, { redirect: "manual" });
      if (response.ok || response.status === 304) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Vite preview did not become ready at ${baseUrl}: ${
      lastError instanceof Error ? lastError.message : String(lastError ?? "unknown")
    }`,
  );
}

function forecastRecord(recompete) {
  return {
    id: recompete ? "ui-recompete-001" : "ui-forecast-001",
    source: "govconapi",
    sourceId: recompete ? "UI-REC-001" : "UI-FCO-001",
    title: recompete
      ? "Occupational Health Services Recompete"
      : "Planned Occupational Health Medical Services",
    agency: "Department of Example",
    subAgency: "Workforce Health Office",
    description:
      "Occupational health examinations, audiometry, spirometry, and workforce medical services.",
    naics: "621111",
    setAside: "Small Business",
    state: "VA",
    valueRangeText: "$1M-$5M",
    valueLow: 1_000_000,
    valueHigh: 5_000_000,
    estimatedSolicitationDate: future,
    estimatedAwardFiscalYear: new Date().getUTCFullYear() + 1,
    estimatedAwardQuarter: "Q2",
    status: "forecast",
    isRecompete: recompete,
    incumbentName: recompete ? "Example Incumbent LLC" : null,
    incumbentAward: recompete
      ? {
          recipientName: "Example Incumbent LLC",
          currentValue: 2_750_000,
          expires: future,
          awardingAgency: "Department of Example",
          latestActionDate: recent,
        }
      : null,
    pointOfContact: {
      name: "Contracting Officer",
      email: "co@example.gov",
      phone: null,
    },
    sourceUrl: "https://example.gov/forecast/occupational-health",
    lastUpdatedDate: recent,
    relevance: {
      score: 95,
      classification: "strong",
      semanticSimilarity: 0.94,
      provider: "deterministic",
      reasons: ["Core occupational-health scope"],
    },
  };
}

await waitForServer();

const browser = await browserType.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.emulateMedia({ reducedMotion: "reduce" });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

await page.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  const json = (body, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });

  if (path === "/api/opportunities/ingestion-runs/current")
    return json({ run: null });
  if (path === "/api/settings") return json({});
  if (path === "/api/providers") return json({ providers: [] });

  if (path === "/api/opportunities" && request.method() === "GET") {
    return json({
      data: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          noticeId: "UI-TEST-001",
          title: "Occupational Health and Medical Surveillance Services",
          agency: "Department of Example",
          type: "Solicitation",
          status: "active",
          postedDate: recent,
          responseDeadline: future,
          description:
            "Occupational health examinations, audiometry, spirometry, and medical surveillance.",
          solicitationNumber: "UI-TEST-001",
          samUrl: "https://sam.gov/opp/ui-test-001/view",
          providerName: "samGov",
          source: "sam_gov",
          sourceConfidence: "high",
          userGrade: null,
          relevance: {
            score: 96,
            reasons: ["Explicit occupational-health procurement scope"],
            category: "Occupational health",
            confidence: "high",
            feedbackAdj: 0,
            contextualFeedbackAdj: 0,
          },
          quality: {
            classification: "verified-open",
            label: "Verified Open",
            actionable: true,
            summaryEligible: true,
            sourceType: "official-direct",
            reasons: [],
          },
          crossSource: {
            canonicalKey: "sol:departmentofexample:uitest001",
            rank: 10400,
            authority: "official",
            contextHash: "ui-hardening",
            suppressed: false,
          },
        },
      ],
      total: 1,
      page: 1,
      limit: 50,
      view: url.searchParams.get("view") ?? "actionable",
      ranking: {
        mode: "cross-source-v2",
        candidates: 1,
        canonicalRecords: 1,
        queryContext: null,
      },
    });
  }

  if (path === "/api/govcon/forecasts" && request.method() === "GET") {
    const recompete = url.searchParams.get("recompete") === "true";
    return json({
      records: [forecastRecord(recompete)],
      pagination: { limit: 50, offset: 0, total: 1, hasNext: false },
      sourcePageRecords: 1,
      suppressedCount: 0,
      lowRelevanceCount: 0,
      semanticProvider: "deterministic",
      fetchedAt: new Date().toISOString(),
      cached: false,
    });
  }

  if (path === "/api/relevant-news" && request.method() === "GET") {
    return json({
      articles: [
        {
          id: "ui-news-001",
          title: "Federal Agency Announces Occupational Health Contract",
          description:
            "A federal acquisition for workforce medical services and occupational health support.",
          content: null,
          url: "https://example.com/federal-contract-news",
          image: null,
          publishedAt: recent,
          source: {
            name: "Federal Contract News",
            url: "https://example.com",
            country: "us",
          },
          relevanceScore: 92,
        },
      ],
      totalArticles: 1,
      upstreamArticles: 2,
      filteredOut: 1,
      query: "federal occupational health",
      source: "gnews",
      fetchedAt: new Date().toISOString(),
      cached: false,
    });
  }

  return json({});
});

async function viewportMetrics() {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
  }));
}

async function assertNoDocumentOverflow(label) {
  const metrics = await viewportMetrics();
  assert.ok(
    metrics.scrollWidth <= metrics.clientWidth + 1,
    `${browserEngine} ${label} horizontally overflows viewport: ${metrics.scrollWidth} > ${metrics.clientWidth}`,
  );
  return metrics;
}

async function assertLandingPage() {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.getByRole("heading", { name: "Insight Hub", level: 1 }).waitFor();
  const metrics = await assertNoDocumentOverflow("landing page");
  assert.ok(
    metrics.scrollHeight > metrics.clientHeight,
    "landing page must remain vertically scrollable when its cards exceed the viewport",
  );

  const firstInternalCard = page.locator('a[href="/portal/opportunities"]');
  await firstInternalCard.waitFor();
  const firstCardBox = await firstInternalCard.boundingBox();
  assert.ok(firstCardBox && firstCardBox.width > 0, "landing Opportunity Intelligence card must remain visible");

  const homeOrbAnimation = await page
    .locator(".home-orb")
    .first()
    .evaluate((node) => getComputedStyle(node).animationName);
  assert.equal(
    homeOrbAnimation,
    "none",
    "landing decorative orbs must stop under reduced motion",
  );
}

async function assertPortalChrome(path, activeLabel) {
  await page.goto(`${baseUrl}${path}`, {
    waitUntil: "networkidle",
    timeout: 30_000,
  });
  await page.getByRole("main").waitFor();

  assert.equal(await page.getByRole("navigation", { name: "Intelligence workspaces" }).count(), 0,
    `${path} must not link into other intelligence workspaces`);
  const returnLink = page.getByRole("link", { name: "Back to Insight Hub" });
  await returnLink.waitFor();

  const skipLink = page.getByRole("link", { name: "Skip to content" });
  await skipLink.waitFor();
  await skipLink.focus();
  await page.keyboard.press("Enter");
  assert.equal(
    await page.evaluate(() => document.activeElement?.id ?? null),
    "portal-main-content",
    `${browserEngine} ${path} skip link must move keyboard focus to main content`,
  );

  const metrics = await assertNoDocumentOverflow(path);
  const mainId = await page.locator("main").getAttribute("id");
  assert.equal(
    mainId,
    "portal-main-content",
    `${path} must preserve the keyboard skip target`,
  );
  assert.ok(metrics.scrollHeight >= metrics.clientHeight, `${path} must fill the viewport`);

  const activeBox = await returnLink.boundingBox();
  assert.ok(
    activeBox && activeBox.height >= 44,
    `${path} return target must be at least 44px high`,
  );

  const orbAnimation = await page
    .locator(".portal-orb")
    .first()
    .evaluate((node) => getComputedStyle(node).animationName);
  assert.equal(
    orbAnimation,
    "none",
    `${path} must stop decorative orb animation under reduced motion`,
  );
}

async function assertFetchDialogContained(viewportWidth, viewportHeight) {
  await page.setViewportSize({ width: viewportWidth, height: viewportHeight });
  await assertPortalChrome("/portal/opportunities", "Opportunities");
  await page.getByRole("button", { name: "Fetch Intelligence" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  const dialogBox = await dialog.boundingBox();
  assert.ok(dialogBox, "Fetch Intelligence dialog must have a bounding box");
  assert.ok(
    dialogBox.x >= -0.5 && dialogBox.y >= -0.5,
    `Dialog must remain inside the top/left viewport bounds at ${viewportWidth}x${viewportHeight}`,
  );
  assert.ok(
    dialogBox.x + dialogBox.width <= viewportWidth + 0.5,
    `Dialog must remain inside the ${viewportWidth}px viewport width`,
  );
  assert.ok(
    dialogBox.y + dialogBox.height <= viewportHeight + 0.5,
    `Dialog must remain inside the ${viewportHeight}px viewport height`,
  );
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
}

try {
  await assertLandingPage();

  await assertFetchDialogContained(390, 844);
  await assertFetchDialogContained(320, 700);

  await page.setViewportSize({ width: 390, height: 844 });
  await assertPortalChrome("/portal/forecasts", "Forecasts");
  await page.getByRole("heading", { name: "Forecasts" }).waitFor();

  await assertPortalChrome("/portal/recompete-watch", "Recompete Watch");
  await page.getByRole("heading", { name: "Recompete Watch" }).waitFor();

  await assertPortalChrome("/portal/relevant-news", "Relevant News");
  await page.getByRole("textbox", { name: "Search relevant news" }).waitFor();
  const articleLink = page.getByRole("link", { name: "Read Article" });
  await articleLink.waitFor();
  const articleLinkBox = await articleLink.boundingBox();
  assert.ok(
    articleLinkBox && articleLinkBox.height >= 44,
    "Relevant News outbound action must preserve a mobile touch target",
  );

  assert.deepEqual(
    pageErrors,
    [],
    `${browserEngine} emitted UI page errors: ${pageErrors.join(" | ")}`,
  );
  console.log(
    JSON.stringify({
      event: "insight_hub_ui_hardening_passed",
      browser: browserEngine,
      viewports: ["390x844", "320x700"],
      reducedMotion: true,
      verified: [
        "landing-page-mobile-containment",
        "landing-page-vertical-scroll",
        "landing-page-reduced-motion",
        "portal-navigation-active-state",
        "keyboard-skip-focus",
        "mobile-horizontal-overflow",
        "44px-workspace-touch-targets",
        "reduced-motion-background-guard",
        "mobile-dialog-viewport-containment-390",
        "mobile-dialog-viewport-containment-320",
        "modal-escape-dismissal",
        "accessible-relevant-news-search",
        "news-outbound-touch-target",
      ],
    }),
  );
} finally {
  await browser.close();
}
