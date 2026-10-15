import { timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import { consumeDurableRateLimit } from "./durable-rate-limit";

const router = Router();

export interface RatePolicy {
  bucket: string;
  limit: number;
  windowMs: number;
}

interface RateWindow {
  startedAt: number;
  count: number;
}

export type WriteCapability = "read" | "user_write" | "admin_write";

const fallbackWindows = new Map<string, RateWindow>();
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const MAX_RATE_WINDOWS = 5_000;
const RATE_WINDOW_RETENTION_MS = 15 * 60_000;

function configuredOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const raw of (process.env.INSIGHT_HUB_ALLOWED_ORIGINS ?? "").split(",")) {
    const value = raw.trim();
    if (!value) continue;
    try {
      origins.add(new URL(value).origin);
    } catch {
    }
  }
  return origins;
}

export function mutationOriginAllowed(req: Request): boolean {
  if (!MUTATING_METHODS.has(req.method.toUpperCase())) return true;
  const origin = req.get("origin");
  if (!origin) return true;

  try {
    const parsed = new URL(origin);
    const host = req.get("host");
    if (host) {
      const requestOrigin = `${req.protocol}://${host}`;
      if (parsed.origin === requestOrigin) return true;
    }
    return configuredOrigins().has(parsed.origin);
  } catch {
    return false;
  }
}

function safeTokenMatch(required: string, supplied: string): boolean {
  const requiredBuffer = Buffer.from(required);
  const suppliedBuffer = Buffer.from(supplied);
  return (
    requiredBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(requiredBuffer, suppliedBuffer)
  );
}

export function adminReadAllowed(req: Request): boolean {
  const required = process.env.INSIGHT_HUB_ADMIN_TOKEN?.trim();
  if (!required) return true;
  const supplied = req.get("x-insight-hub-write-token") ?? "";
  return safeTokenMatch(required, supplied);
}

export function writeCapability(
  req: Pick<Request, "method" | "path">,
): WriteCapability {
  const method = req.method.toUpperCase();
  if (!MUTATING_METHODS.has(method)) return "read";
  const path = req.path;

  const admin =
    path === "/opportunities/feedback/rescore" ||
    path === "/opportunities/import" ||
    path === "/opportunities/enrich" ||
    path === "/opportunities/reconcile-expired" ||
    path.startsWith("/hardening/retention") ||
    (/^\/opportunities\/[^/]+$/.test(path) && method === "DELETE") ||
    path.startsWith("/source-monitor/") ||
    path.startsWith("/settings") ||
    path.startsWith("/rfp-sources/crawler") ||
    path.startsWith("/rfp-sources/import") ||
    /\/federal-intel\/[^/]+\/refresh\/?$/.test(path);

  return admin ? "admin_write" : "user_write";
}

function writeTokenAllowed(req: Request, capability: WriteCapability): boolean {
  if (capability === "read") return true;

  const adminRequired = process.env.INSIGHT_HUB_ADMIN_TOKEN?.trim();
  const writeRequired = process.env.INSIGHT_HUB_WRITE_TOKEN?.trim();
  const requireAllWrites = process.env.INSIGHT_HUB_REQUIRE_WRITE_TOKEN === "true";
  const supplied = req.get("x-insight-hub-write-token") ?? "";

  if (capability === "admin_write" && adminRequired) {
    return safeTokenMatch(adminRequired, supplied);
  }
  if (writeRequired && (capability === "admin_write" || requireAllWrites)) {
    return safeTokenMatch(writeRequired, supplied);
  }
  return true;
}

export function expensiveRoutePolicy(
  req: Pick<Request, "method" | "path">,
): RatePolicy | null {
  const method = req.method.toUpperCase();
  const path = req.path;
  if (method !== "POST" && method !== "PATCH" && method !== "DELETE") return null;

  if (method === "POST" && path === "/opportunities/fetch") {
    return { bucket: "manual-fetch", limit: 2, windowMs: 60_000 };
  }
  if (method === "POST" && path === "/opportunities/enrich") {
    return { bucket: "opportunity-enrich", limit: 2, windowMs: 5 * 60_000 };
  }
  if (method === "POST" && /^\/opportunities\/[^/]+\/summary\/?$/.test(path)) {
    return { bucket: "opportunity-summary", limit: 30, windowMs: 60_000 };
  }
  if (method === "POST" && path === "/govcon/recompete-verify") {
    return { bucket: "recompete-verify", limit: 20, windowMs: 60_000 };
  }
  if (method === "POST" && /\/federal-intel\/[^/]+\/refresh\/?$/.test(path)) {
    return { bucket: "federal-intel-refresh", limit: 10, windowMs: 60_000 };
  }
  if (method === "POST" && path === "/opportunities/feedback/rescore") {
    return { bucket: "feedback-rescore", limit: 1, windowMs: 10 * 60_000 };
  }
  if (method === "POST" && path === "/hardening/retention/apply") {
    return { bucket: "retention-apply", limit: 1, windowMs: 10 * 60_000 };
  }
  if (method === "POST" && /^\/opportunities\/[^/]+\/feedback\/?$/.test(path)) {
    return { bucket: "opportunity-feedback", limit: 120, windowMs: 60_000 };
  }
  if (method === "POST" && path === "/govcon/feedback") {
    return { bucket: "govcon-feedback", limit: 120, windowMs: 60_000 };
  }
  if (method === "POST" && path === "/company-watch/awards/refresh") {
    return { bucket: "company-watch-award-refresh", limit: 2, windowMs: 10 * 60_000 };
  }
  return null;
}

function pruneFallbackWindows(now: number): void {
  if (fallbackWindows.size >= 500) {
    for (const [key, value] of fallbackWindows) {
      if (now - value.startedAt > RATE_WINDOW_RETENTION_MS) {
        fallbackWindows.delete(key);
      }
    }
  }
  while (fallbackWindows.size >= MAX_RATE_WINDOWS) {
    const oldestKey = fallbackWindows.keys().next().value as string | undefined;
    if (!oldestKey) break;
    fallbackWindows.delete(oldestKey);
  }
}

function consumeFallback(
  client: string,
  policy: RatePolicy,
  now: number,
): { allowed: boolean; retryAfterSeconds: number } {
  pruneFallbackWindows(now);
  const key = `${client}:${policy.bucket}`;
  const existing = fallbackWindows.get(key);
  const current =
    !existing || now - existing.startedAt >= policy.windowMs
      ? { startedAt: now, count: 0 }
      : existing;
  if (current.count >= policy.limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil(
        Math.max(1, policy.windowMs - (now - current.startedAt)) / 1000,
      ),
    };
  }
  current.count += 1;
  fallbackWindows.set(key, current);
  return { allowed: true, retryAfterSeconds: 0 };
}

router.use(async (req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  if (!mutationOriginAllowed(req)) {
    return res.status(403).json({ error: "Cross-origin write request rejected." });
  }

  const capability = writeCapability(req);
  if (!writeTokenAllowed(req, capability)) {
    return res.status(401).json({
      error:
        capability === "admin_write"
          ? "Administrative write authorization is required."
          : "Write authorization token is required.",
    });
  }

  const policy = expensiveRoutePolicy(req);
  if (!policy) return next();

  const client = req.ip || req.socket.remoteAddress || "unknown";
  try {
    const result = await consumeDurableRateLimit(
      policy.bucket,
      client,
      policy.limit,
      policy.windowMs,
    );
    if (!result.allowed) {
      res.setHeader("Retry-After", String(result.retryAfterSeconds));
      return res.status(429).json({
        error: "Request rate limit reached for this expensive operation.",
        retryAfterSeconds: result.retryAfterSeconds,
        limiter: "shared",
      });
    }
    return next();
  } catch (error) {
    req.log?.warn?.(error, "shared rate limiter unavailable; using local fallback");
    const fallback = consumeFallback(client, policy, Date.now());
    if (!fallback.allowed) {
      res.setHeader("Retry-After", String(fallback.retryAfterSeconds));
      return res.status(429).json({
        error: "Request rate limit reached for this expensive operation.",
        retryAfterSeconds: fallback.retryAfterSeconds,
        limiter: "local-fallback",
      });
    }
    return next();
  }
});

export function clearApiHardeningRateWindows(): void {
  fallbackWindows.clear();
}

export default router;
