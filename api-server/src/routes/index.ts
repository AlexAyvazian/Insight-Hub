import { Router, type IRouter } from "express";
import apiHardeningRouter from "../middleware/api-hardening";
import apiRequestValidationRouter from "../middleware/api-request-validation";
import requestObservability from "../middleware/request-observability";
import healthRouter from "./health";
import databaseStatusRouter from "./database-status";
import hardeningDiagnosticsRouter from "./hardening-diagnostics";
import releaseCStatusRouter from "./release-c-status";
import retentionLifecycleRouter from "./retention-lifecycle";
import opportunitySafetyBoundaryRouter from "./opportunity-safety-boundary";
import opportunityFeedbackRouter from "./opportunity-feedback";
import settingsRouter from "./settings";
import forecastPolicyBoundaryRouter from "./forecast-policy-boundary";
import searchRouter from "./search";
import relevanceProfileRouter from "./relevanceProfile";
import govconForecastEnsembleRouter from "./govcon-forecast-ensemble";
import govconRouter from "./govcon";
import relevantNewsRouter from "./relevant-news";
import companyWatchRouter from "./company-watch";
import companyDisclosuresRouter from "./company-disclosures";
import transferredIntelligenceBoundaryRouter from "./transferred-intelligence-boundary";
import rfpSourcesRuntimeRouter from "./rfp-sources-runtime";
import rfpProviderBoundaryRouter from "../middleware/rfp-provider-boundary";
import manualOnlyPortalHealthBoundaryRouter from "../middleware/manual-only-portal-health-boundary";
import opportunityVectorSyncBoundary from "../middleware/opportunity-vector-sync-boundary";
import { lazyRouter } from "./lazy-router";

const router: IRouter = Router();

router.use(requestObservability);
router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

router.use(apiHardeningRouter);
router.use(apiRequestValidationRouter);

router.use(healthRouter);
router.use(databaseStatusRouter);
router.use(hardeningDiagnosticsRouter);
router.use(releaseCStatusRouter);
router.use(retentionLifecycleRouter);

// Non-procurement intelligence workspaces are owned by Insight Hub 2. Keep the
// old API prefixes explicit so stale clients fail loudly instead of touching the
// legacy Hub 1 handlers or Intel database.
router.use(transferredIntelligenceBoundaryRouter);

router.use(
  lazyRouter(
    (req) => /^\/opportunities\/[^/]+\/summary\/?$/.test(req.path),
    () => import("./opportunity-summary-v2"),
  ),
);
router.use(
  lazyRouter(
    (req) => req.method === "GET" && /^\/opportunities\/[^/]+\/(versions|documents)\/?$/.test(req.path),
    () => import("./opportunity-evidence"),
  ),
);
router.use(rfpProviderBoundaryRouter);
router.use(
  lazyRouter(
    (req) => req.path.startsWith("/opportunities/ingestion-runs"),
    () => import("./ingestion-diagnostics"),
  ),
);
router.use(opportunitySafetyBoundaryRouter);
router.use(opportunityVectorSyncBoundary);
router.use(
  lazyRouter(
    (req) => req.path === "/opportunities" || req.path.startsWith("/opportunities/"),
    () => import("./opportunities"),
  ),
);
router.use(opportunityFeedbackRouter);
router.use(settingsRouter);
router.use(
  lazyRouter(
    (req) => req.path === "/providers" || req.path.startsWith("/providers/"),
    () => import("./providers"),
  ),
);
router.use(manualOnlyPortalHealthBoundaryRouter);
router.use(rfpSourcesRuntimeRouter);
router.use(
  lazyRouter(
    (req) => req.path.startsWith("/rfp-sources/crawler"),
    () => import("./crawler-admin"),
  ),
);
router.use(
  lazyRouter(
    (req) => req.path === "/rfp-sources" || req.path.startsWith("/rfp-sources/"),
    () => import("./rfp-sources"),
  ),
);
router.use(govconForecastEnsembleRouter);
router.use(govconRouter);
router.use(relevantNewsRouter);
router.use(companyWatchRouter);
router.use(companyDisclosuresRouter);
router.use(forecastPolicyBoundaryRouter);
router.use(searchRouter);
router.use(relevanceProfileRouter);

export default router;
