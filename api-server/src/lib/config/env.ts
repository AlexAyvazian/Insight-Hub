/**
 * Central environment variable management.
 * All provider credentials and feature flags are read from here.
 */

export const env = {
  // SAM.gov
  SAM_GOV_API_KEY: process.env.SAM_GOV_API_KEY,
  SAM_GOV_BASE_URL:
    process.env.SAM_GOV_BASE_URL ||
    "https://api.sam.gov/opportunities/v2/search",

  // Federal Register
  FEDERAL_REGISTER_API_BASE:
    process.env.FEDERAL_REGISTER_API_BASE ||
    "https://www.federalregister.gov/api/v1",

  // Gemini AI
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_KEY_2: process.env.GEMINI_KEY_2,
  GEMINI_KEY_3: process.env.GEMINI_KEY_3,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  GROQ_KEY_2: process.env.GROQ_KEY_2,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENROUTER_KEY_2: process.env.OPENROUTER_KEY_2,

  // Additional AI / model providers
  CEREBRAS_API_KEY: process.env.CEREBRAS_API_KEY,
  COHERE_API_KEY: process.env.COHERE_API_KEY,
  COHERE_API_KEY_2: process.env.COHERE_API_KEY_2,
  COHERE_API_KEY_3: process.env.COHERE_API_KEY_3,
  COHERE_API_KEY_4: process.env.COHERE_API_KEY_4,
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  FAL_API_KEY: process.env.FAL_API_KEY,
  MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY,
  NVIDIA_API_KEY: process.env.NVIDIA_API_KEY,
  VOYAGE_API_KEY: process.env.VOYAGE_API_KEY,
  HUGGINGFACE_API_KEY: process.env.HUGGINGFACE_API_KEY,

  // Renewable / recurring search and extraction providers
  EXA_API_KEY: process.env.EXA_API_KEY,
  EXA_API_KEY_2: process.env.EXA_API_KEY_2,
  EXA_API_KEY_3: process.env.EXA_API_KEY_3,
  PARALLEL_API_KEY: process.env.PARALLEL_API_KEY,
  LINKUP_API_KEY: process.env.LINKUP_API_KEY,
  LINKUP_API_KEY_2: process.env.LINKUP_API_KEY_2,

  // Document extraction (Release C): free-tier accounts only, hard-capped below the free allowance
  LLMWHISPERER_API_KEY: process.env.LLMWHISPERER_API_KEY,
  LLMWHISPERER_API_KEY_2: process.env.LLMWHISPERER_API_KEY_2,
  NUTRIENT_API_KEY: process.env.NUTRIENT_API_KEY,
  YOU_API_KEY: process.env.YOU_API_KEY,
  YOU_API_KEY_2: process.env.YOU_API_KEY_2,
  LANGSEARCH_API_KEY: process.env.LANGSEARCH_API_KEY,
  LANGSEARCH_API_KEY_2: process.env.LANGSEARCH_API_KEY_2,
  LANGSEARCH_API_KEY_3: process.env.LANGSEARCH_API_KEY_3,
  LANGSEARCH_API_KEY_4: process.env.LANGSEARCH_API_KEY_4,
  FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY,
  FIRECRAWL_API_KEY_2: process.env.FIRECRAWL_API_KEY_2,
  FIRECRAWL_API_KEY_3: process.env.FIRECRAWL_API_KEY_3,
  KEENABLE_API_KEY: process.env.KEENABLE_API_KEY,
  MICROLINK_API_KEY: process.env.MICROLINK_API_KEY,
  BROWSER_USE_API_KEY: process.env.BROWSER_USE_API_KEY,
  BROWSERBASE_API_KEY: process.env.BROWSERBASE_API_KEY,
  BROWSERBASE_KEY_2: process.env.BROWSERBASE_KEY_2,
  BROWSERLESS_KEY: process.env.BROWSERLESS_KEY,
  APIFY_KEY: process.env.APIFY_KEY,
  OCR_SPACE_KEY: process.env.OCR_SPACE_KEY,
  SOCRATA_APP_TOKEN: process.env.SOCRATA_APP_TOKEN,
  SOCRATA_API_KEY: process.env.SOCRATA_API_KEY,
  SOCRATA_API_SECRET: process.env.SOCRATA_API_SECRET,
  WEBSEARCH_API_KEY: process.env.WEBSEARCH_API_KEY,

  // Vector search / storage backends
  PINECONE_API_KEY: process.env.PINECONE_API_KEY,
  PINECONE_INDEX_HOST: process.env.PINECONE_INDEX_HOST,
  PINECONE_NAMESPACE: process.env.PINECONE_NAMESPACE,
  QDRANT_API_KEY: process.env.QDRANT_API_KEY,
  QDRANT_URL: process.env.QDRANT_URL,
  QDRANT_COLLECTION: process.env.QDRANT_COLLECTION,

  // Infrastructure connectors
  CLOUDFLARE_WORKER_API: process.env.CLOUDFLARE_WORKER_API,
  CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
  CLOUDFLARE_API_TOKEN_BACKUP: process.env.CLOUDFLARE_API_TOKEN_BACKUP,
  CLOUDFLARE_BROWSER_ACCOUNT_ID: process.env.CLOUDFLARE_BROWSER_ACCOUNT_ID,
  CLOUDFLARE_BROWSER_DEPLOY_TOKEN: process.env.CLOUDFLARE_BROWSER_DEPLOY_TOKEN,
  CLOUDFLARE_EMBEDDING_MODEL: process.env.CLOUDFLARE_EMBEDDING_MODEL,
  CLOUDFLARE_RERANK_MODEL: process.env.CLOUDFLARE_RERANK_MODEL,
  MONGO_DB_API: process.env.MONGO_DB_API,

  // Hub 1 surface APIs
  GOVCON_API_KEY: process.env.GOVCON_API_KEY,
  GNEWS_API_KEY: process.env.GNEWS_API_KEY,
  APITUBE_NEWS_API_KEY: process.env.APITUBE_NEWS_API_KEY,
  APITUBE_NEWS_API_KEY_2: process.env.APITUBE_NEWS_API_KEY_2,
  APITUBE_NEWS_API_KEY_3: process.env.APITUBE_NEWS_API_KEY_3,
  TINYFISH_API_KEY: process.env.TINYFISH_API_KEY,
  LOGO_DEV_TOKEN: process.env.LOGO_DEV_TOKEN,

  // Procurement source feature flags
  STATE_PROCUREMENT_SOURCES_ENABLED:
    process.env.STATE_PROCUREMENT_SOURCES_ENABLED,
  COUNTY_PROCUREMENT_SOURCES_ENABLED:
    process.env.COUNTY_PROCUREMENT_SOURCES_ENABLED,
  UNIVERSITY_BID_SOURCES_ENABLED: process.env.UNIVERSITY_BID_SOURCES_ENABLED,
  CITY_PROCUREMENT_SOURCES_ENABLED:
    process.env.CITY_PROCUREMENT_SOURCES_ENABLED,
  MUNICIPAL_PROCUREMENT_SOURCES_ENABLED:
    process.env.MUNICIPAL_PROCUREMENT_SOURCES_ENABLED,
  LOCAL_GOV_BID_SOURCES_ENABLED: process.env.LOCAL_GOV_BID_SOURCES_ENABLED,

  // Search / ranking feature flags
  ENABLE_SEMANTIC_RERANK: process.env.ENABLE_SEMANTIC_RERANK,

  // Tango Procurement Intelligence
  TANGO_API_KEY: process.env.TANGO_API_KEY,
  TANGO_BASE_URL: process.env.TANGO_BASE_URL,

  // BidNet Direct
  BIDNET_API_KEY: process.env.BIDNET_API_KEY,
  BIDNET_BASE_URL: process.env.BIDNET_BASE_URL,
} as const;

export type EnvKey = keyof typeof env;

export function envFlag(key: EnvKey, defaultValue = false): boolean {
  const value = env[key];
  if (value == null || value === "") return defaultValue;
  return /^(1|true|yes|on|enabled)$/i.test(String(value).trim());
}

export const procurementSourceFlags = {
  state: envFlag("STATE_PROCUREMENT_SOURCES_ENABLED", true),
  county: envFlag("COUNTY_PROCUREMENT_SOURCES_ENABLED", false),
  university: envFlag("UNIVERSITY_BID_SOURCES_ENABLED", false),
  city: envFlag("CITY_PROCUREMENT_SOURCES_ENABLED", false),
  municipal: envFlag("MUNICIPAL_PROCUREMENT_SOURCES_ENABLED", false),
  localGov: envFlag("LOCAL_GOV_BID_SOURCES_ENABLED", false),
} as const;

export function isAnyLocalProcurementSourceEnabled(): boolean {
  return (
    procurementSourceFlags.county ||
    procurementSourceFlags.city ||
    procurementSourceFlags.municipal ||
    procurementSourceFlags.localGov
  );
}
