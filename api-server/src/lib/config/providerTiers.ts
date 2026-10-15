/**
 * Provider Tier Configuration
 *
 * This registry describes reliability/cost posture only. Runtime ownership is
 * defined by sourceArchitecture.ts. The quota scheduler owns actual spend order.
 */

import type { ProviderName } from "./providerConfig";

export type ProviderTier = "tier1" | "tier2" | "tier3" | "disabled";

export interface ProviderTierConfig {
  name: ProviderName;
  tier: ProviderTier;
  requiresApiKey: boolean;
  requiresSelfHosted: boolean;
  description: string;
  priority: number;
}

function config(
  name: ProviderName,
  tier: ProviderTier,
  requiresApiKey: boolean,
  requiresSelfHosted: boolean,
  description: string,
  priority: number,
): ProviderTierConfig {
  return { name, tier, requiresApiKey, requiresSelfHosted, description, priority };
}

export const PROVIDER_TIERS: Record<ProviderName, ProviderTierConfig> = {
  samGov: config("samGov", "tier1", false, false, "Official federal government procurement source", 1),
  tango: config("tango", "tier1", true, false, "Independent structured federal procurement source", 2),
  internationalPublicPortals: config("internationalPublicPortals", "tier1", false, false, "CanadaBuys official Canadian tenders plus anonymous TED, UK Find a Tender, UK Contracts Finder, World Bank and live US city/county bid feeds (NYC, Los Angeles RAMP, Montgomery County MD, State of Delaware)", 3),
  texasEsbd: config("texasEsbd", "tier1", false, false, "Texas official procurement compatibility source", 4),
  nyScr: config("nyScr", "tier1", false, false, "New York official procurement compatibility source", 5),
  rssAggregator: config("rssAggregator", "tier1", false, false, "Explicit supplemental government RSS input", 6),
  grantsGov: config("grantsGov", "tier1", false, false, "Federal grants intelligence; not an open-RFP source", 7),
  emailNotifications: config("emailNotifications", "tier1", false, false, "Explicit procurement-alert inbox input", 8),

  keenable: config("keenable", "tier2", false, false, "Keyless-first search/fetch with optional higher-rate key", 1),
  tinyfish: config("tinyfish", "tier2", true, false, "Hourly-renewing web search with provider-level budget", 1.5),
  you: config("you", "tier2", true, false, "Daily-renewing search with two independent accounts", 2),
  browserbase: config("browserbase", "tier2", true, false, "Managed search/fetch with two independent accounts", 3),
  parallel: config("parallel", "tier2", true, false, "Monthly-renewable web discovery API", 4),
  exa: config("exa", "tier2", true, false, "Semantic discovery with three independent accounts", 5),
  firecrawl: config("firecrawl", "tier2", true, false, "Three-account search and page extraction fallback", 6),
  langsearch: config("langsearch", "tier2", true, false, "Four-slot web opportunity discovery pool", 7),
  linkup: config("linkup", "tier2", true, false, "Domain-aware web discovery API", 8),
  socrata: config("socrata", "tier2", true, false, "Tyler/Socrata public-data procurement discovery", 9),
  websearch: config("websearch", "tier3", true, false, "Broad web search emergency fallback", 10),

  jina: config("jina", "tier2", false, false, "First-choice keyless page reader; optional key raises Reader rate", 11),
  microlink: config("microlink", "tier3", false, false, "Tiny-daily final page extraction fallback", 12),

  cerebras: config("cerebras", "tier2", true, false, "Fast procurement relevance judge", 20),
  groq: config("groq", "tier2", true, false, "Fast procurement judge with independent account failover", 21),
  mistral: config("mistral", "tier2", true, false, "Procurement judge fallback", 22),
  nvidia: config("nvidia", "tier2", true, false, "Finite hosted-inference emergency judge fallback", 23),
  openrouter: config("openrouter", "tier2", true, false, "Model-routing judge fallback with independent account failover", 24),
  gemini: config("gemini", "tier2", true, false, "Query generation and judge fallback with independent account failover", 25),
  minimax: config("minimax", "tier2", true, false, "Procurement judge fallback", 26),
  deepseek: config("deepseek", "tier3", true, false, "Procurement judge fallback", 27),
  clod: config("clod", "tier3", true, false, "Experimental procurement judge fallback", 28),
  cohere: config("cohere", "tier2", true, false, "Semantic reranking with four independent account fallbacks", 29),
  localLlm: config("localLlm", "disabled", false, true, "Retired local model path", 0),

  pinecone: config("pinecone", "tier2", true, false, "Vector retrieval memory", 30),
  qdrant: config("qdrant", "tier2", true, false, "Vector retrieval memory", 31),
  voyage: config("voyage", "tier2", true, false, "Embedding provider", 32),
  huggingFace: config("huggingFace", "tier2", true, false, "Model/embedding utility provider", 33),

  usaSpending: config("usaSpending", "disabled", false, false, "Award/history intelligence only; not open-RFP ingestion", 0),
  federalRegister: config("federalRegister", "disabled", false, false, "Policy/rule intelligence only; not opportunity ingestion", 0),
  publicPortalProviders: config("publicPortalProviders", "disabled", false, false, "Legacy portal alias into browser discovery", 0),
  eunaBonfire: config("eunaBonfire", "disabled", false, false, "Legacy Euna/Bonfire alias into browser discovery", 0),
  selfHostedCrawler: config("selfHostedCrawler", "disabled", false, true, "Self-hosted crawler disabled for manual opportunity discovery", 0),
  selfHostedSearch: config("selfHostedSearch", "disabled", false, true, "Self-hosted search disabled for manual opportunity discovery", 0),
  bidnet: config("bidnet", "disabled", true, false, "BidNet direct endpoint is not implemented", 0),
  browseAi: config("browseAi", "disabled", true, false, "Browser automation path disabled", 0),
  browserUse: config("browserUse", "disabled", true, false, "Browser automation path disabled", 0),
  cloudflareWorker: config("cloudflareWorker", "disabled", true, false, "Cloudflare Worker extraction path disabled", 0),
  mongoDb: config("mongoDb", "disabled", true, false, "Unused alternate database integration", 0),
  fal: config("fal", "disabled", true, false, "Media/model utility; not procurement discovery", 0),
};

export function getProvidersByTier(tier: ProviderTier): ProviderName[] {
  return Object.entries(PROVIDER_TIERS)
    .filter(([, value]) => value.tier === tier)
    .sort(([, left], [, right]) => left.priority - right.priority)
    .map(([name]) => name as ProviderName);
}

export function getProviderTier(provider: ProviderName): ProviderTierConfig {
  return PROVIDER_TIERS[provider];
}

export function isStableProvider(provider: ProviderName): boolean {
  return PROVIDER_TIERS[provider].tier === "tier1";
}

export function requiresSelfHosted(provider: ProviderName): boolean {
  return PROVIDER_TIERS[provider].requiresSelfHosted;
}

export function getRecommendedProviders(
  useCase: "discovery" | "enrichment" | "extraction" | "search",
): ProviderName[] {
  switch (useCase) {
    case "discovery":
      return [
        "samGov",
        "tango",
        "internationalPublicPortals",
        "keenable",
        "you",
        "browserbase",
        "parallel",
        "exa",
        "firecrawl",
        "langsearch",
        "linkup",
        "socrata",
      ];
    case "enrichment":
      return ["jina", "keenable", "browserbase", "firecrawl", "microlink"];
    case "extraction":
      return ["cerebras", "groq", "mistral", "nvidia", "openrouter", "gemini"];
    case "search":
      return [
        "keenable",
        "you",
        "browserbase",
        "parallel",
        "exa",
        "firecrawl",
        "langsearch",
        "linkup",
        "websearch",
      ];
  }
}
