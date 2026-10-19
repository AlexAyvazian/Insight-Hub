import { Router } from "express";
import { rfpDb } from "@workspace/db";
import { settingsTable } from "@workspace/db/schema";
import { fetchFecCompany, fetchSecCompany } from "../lib/companyWatch/disclosures";
import { invalidateCredentialSettingsCache, resolveCredential } from "../lib/config/providerConfig";
import { invalidateSettingsSnapshotCache } from "../lib/config/sharedSettingsSnapshot";

const router = Router();

export function validateDisclosureSettings(body: Record<string, unknown>): { fecApiKey?: string; secUserAgent?: string } {
  const result: { fecApiKey?: string; secUserAgent?: string } = {};
  if (body.fecApiKey !== undefined) {
    if (typeof body.fecApiKey !== "string" || !/^[A-Za-z0-9_-]{12,128}$/.test(body.fecApiKey.trim())) throw new Error("Enter a valid FEC API key.");
    result.fecApiKey = body.fecApiKey.trim();
  }
  if (body.secUserAgent !== undefined) {
    if (typeof body.secUserAgent !== "string" || body.secUserAgent.length > 200 || !/^[\x20-\x7e]+$/.test(body.secUserAgent) || !/\S+@\S+\.\S+/.test(body.secUserAgent)) throw new Error("SEC User-Agent must identify the organization and a contact email, without line breaks.");
    result.secUserAgent = body.secUserAgent.trim();
  }
  if (!Object.keys(result).length) throw new Error("Supply an FEC key or SEC User-Agent.");
  return result;
}

// /settings inherits the existing administrative write boundary; credentials are never returned.
router.put("/settings/company-watch-sources", async (req, res) => {
  let values: ReturnType<typeof validateDisclosureSettings>;
  try { values = validateDisclosureSettings(req.body ?? {}); }
  catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "Invalid settings" }); }
  try {
    await rfpDb.transaction(async transaction => {
      for (const [key, value] of Object.entries(values)) await transaction.insert(settingsTable).values({ key, value })
        .onConflictDoUpdate({ target: settingsTable.key, set: { value } });
    });
    invalidateCredentialSettingsCache();
    invalidateSettingsSnapshotCache();
    const [fec, sec] = await Promise.all([resolveCredential("fecApiKey", "FEC_API_KEY"), resolveCredential("secUserAgent", "SEC_USER_AGENT")]);
    return res.json({ fecConfigured: Boolean(fec), secConfigured: Boolean(sec),
      ...(values.fecApiKey ? { fecMatchesSupplied: fec === values.fecApiKey } : {}),
      ...(values.secUserAgent ? { secMatchesSupplied: sec === values.secUserAgent } : {}) });
  } catch { return res.status(503).json({ error: "Company Watch source settings could not be saved." }); }
});

router.get("/company-watch/disclosures/status", async (_req, res) => {
  const [fec, sec] = await Promise.all([resolveCredential("fecApiKey", "FEC_API_KEY"), resolveCredential("secUserAgent", "SEC_USER_AGENT")]);
  return res.json({ fecConfigured: Boolean(fec), secConfigured: Boolean(sec) });
});

router.get("/company-watch/disclosures", async (req, res) => {
  const company = typeof req.query.company === "string" ? req.query.company.trim() : "";
  if (!company || company.length > 120) return res.status(400).json({ error: "Supply a company name (up to 120 characters)." });
  const [fec, sec] = await Promise.all([resolveCredential("fecApiKey", "FEC_API_KEY"), resolveCredential("secUserAgent", "SEC_USER_AGENT")]);
  const refresh = req.query.refresh === "true";
  const [secResult, fecResult] = await Promise.allSettled([
    sec ? fetchSecCompany(company, sec, refresh) : Promise.resolve({ status: "not_configured", message: "SEC User-Agent is not configured.", issuer: null, filings: [] }),
    fec ? fetchFecCompany(company, fec, refresh) : Promise.resolve({ status: "not_configured", message: "FEC API key is not configured.", committees: [] }),
  ]);
  const failure = (source: string, error: unknown) => {
    // Never forward fetch errors containing URLs, query strings, credentials or provider response bodies.
    const message = error instanceof Error ? error.message : "";
    const code = /returned HTTP (\d{3})/.exec(message)?.[1];
    return { status: "error", message: code ? `${source} returned HTTP ${code}; saved records will be used when available.` : `${source} is temporarily unavailable; try again later.` };
  };
  return res.json({ company,
    sec: secResult.status === "fulfilled" ? secResult.value : failure("SEC", secResult.reason),
    fec: fecResult.status === "fulfilled" ? fecResult.value : failure("FEC", fecResult.reason) });
});

export default router;
