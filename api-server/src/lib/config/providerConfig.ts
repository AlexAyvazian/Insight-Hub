import { rfpDb as db } from "@workspace/db";
import { settingsTable } from "@workspace/db/schema";
import { createCredentialSettingsCache } from "./credentialSettingsCache";

export { createCredentialSettingsCache };

export type ProviderName =
  | "samGov"
  | "texasEsbd"
  | "nyScr"
  | "publicPortalProviders"
  | "eunaBonfire"
  | "internationalPublicPortals"
  | "gemini"
  | "tango"
  | "bidnet"
  | "firecrawl"
  | "browserbase"
  | "keenable"
  | "tinyfish"
  | "microlink"
  | "openrouter"
  | "groq"
  | "exa"
  | "browseAi"
  | "browserUse"
  | "clod"
  | "jina"
  | "minimax"
  | "you"
  | "langsearch"
  | "parallel"
  | "linkup"
  | "socrata"
  | "websearch"
  | "grantsGov"
  | "usaSpending"
  | "federalRegister"
  | "cerebras"
  | "cohere"
  | "deepseek"
  | "fal"
  | "mistral"
  | "nvidia"
  | "pinecone"
  | "qdrant"
  | "cloudflareWorker"
  | "mongoDb"
  | "voyage"
  | "huggingFace"
  | "selfHostedCrawler"
  | "rssAggregator"
  | "localLlm"
  | "selfHostedSearch"
  | "emailNotifications";

export type RfpProviderName = Exclude<ProviderName, "usaSpending" | "federalRegister">;

/**
 * Real active inputs that can contribute opportunity candidates. Legacy portal
 * aliases and retired finite providers are intentionally absent.
 */
export const RFP_INGESTION_PROVIDER_NAMES = [
  "samGov",
  "tango",
  "internationalPublicPortals",
  "you",
  "browserbase",
  "keenable",
  "tinyfish",
  "parallel",
  "exa",
  "firecrawl",
  "langsearch",
  "linkup",
  "socrata",
  "websearch",
  "rssAggregator",
  "emailNotifications",
] as const satisfies readonly ProviderName[];

export type RfpIngestionProviderName = (typeof RFP_INGESTION_PROVIDER_NAMES)[number];

const RFP_INGESTION_PROVIDER_SET = new Set<string>(RFP_INGESTION_PROVIDER_NAMES);

export function isRfpIngestionProviderName(value: string): value is RfpIngestionProviderName {
  return RFP_INGESTION_PROVIDER_SET.has(value);
}

export type ProviderUseCase = "direct_source" | "web_discovery" | "research_analysis" | "hybrid";

export interface ProviderDefinition {
  name: RfpProviderName;
  displayName: string;
  description: string;
  category: "primary" | "ai" | "search" | "procurement";
  useCase: ProviderUseCase;
  requiredFields: ProviderField[];
  optionalFields: ProviderField[];
  docsUrl?: string;
  signupUrl?: string;
  capabilities: string[];
  status?: "live" | "partial" | "not_configured" | "coming_soon" | "active";
  notes?: string;
}

export interface ProviderField {
  key: string;
  label: string;
  type: "secret" | "text" | "url";
  placeholder: string;
  description?: string;
  dbKey: string;
  envKey?: string;
}

const secretField = (
  dbKey: string,
  envKey: string,
  label = "API Key",
): ProviderField => ({
  key: "apiKey",
  label,
  type: "secret",
  placeholder: `Your ${label}`,
  dbKey,
  envKey,
});

const provider = (
  name: RfpProviderName,
  displayName: string,
  category: ProviderDefinition["category"],
  useCase: ProviderUseCase,
  requiredFields: ProviderField[],
  capabilities: string[],
  status: ProviderDefinition["status"] = "partial",
  description = `${displayName} data source for opportunity intelligence.`,
): ProviderDefinition => ({
  name,
  displayName,
  description,
  category,
  useCase,
  requiredFields,
  optionalFields: [],
  capabilities,
  status,
});

export const PROVIDER_DEFINITIONS: Record<RfpProviderName, ProviderDefinition> = {
  samGov: provider(
    "samGov",
    "SAM.gov",
    "primary",
    "direct_source",
    [secretField("samApiKey", "SAM_GOV_API_KEY")],
    ["Federal solicitations", "Targeted service queries", "Official opportunity hydration"],
    "live",
    "Direct official source for U.S. federal contracting opportunities from the System for Award Management.",
  ),
  texasEsbd: provider(
    "texasEsbd",
    "Texas ESBD / Texas SmartBuy",
    "primary",
    "direct_source",
    [],
    ["Texas public solicitations", "Due dates", "Solicitation IDs", "Official buyer portal"],
    "live",
    "Dedicated compatibility parser for the official Texas ESBD / Texas SmartBuy listing.",
  ),
  nyScr: provider(
    "nyScr",
    "New York State Contract Reporter",
    "primary",
    "direct_source",
    [],
    ["New York public solicitations", "CR numbers", "Issue/due dates", "Official buyer portal"],
    "live",
    "Dedicated compatibility parser for the official New York State Contract Reporter listing.",
  ),
  publicPortalProviders: provider(
    "publicPortalProviders",
    "U.S. Public Portals (Legacy Alias)",
    "procurement",
    "web_discovery",
    [],
    ["Legacy selection alias", "Routes into quota-aware browser discovery"],
    "not_configured",
    "Legacy selection alias retained for old requests. It does not run a standalone portal crawler or retired search provider; current state/local discovery is handled by the quota-aware browser/search ensemble.",
  ),
  eunaBonfire: provider(
    "eunaBonfire",
    "Euna Supplier Network (Legacy Alias)",
    "procurement",
    "web_discovery",
    [],
    ["Legacy selection alias", "Routes into quota-aware browser discovery"],
    "not_configured",
    "Legacy Euna/Bonfire selection alias. Current discovery uses the active browser/search ensemble; no Euna credentials or retired search-provider dependency is required.",
  ),
  internationalPublicPortals: provider(
    "internationalPublicPortals",
    "Canada + Europe Procurement",
    "procurement",
    "direct_source",
    [],
    [
      "CanadaBuys official tender discovery",
      "TED anonymous Search API",
      "UK Find a Tender + Contracts Finder (OCDS)",
      "World Bank procurement notices",
      "Live US bid feeds: NYC City Record, LA RAMP, Montgomery County MD",
      "EU CPV 85147000 Company health services",
      "Canada/Europe source telemetry",
    ],
    "live",
    "First-class international procurement source combining CanadaBuys official tender pages with the European Union's anonymous TED published-notice Search API. No dedicated international API key is required.",
  ),
  gemini: provider(
    "gemini",
    "Gemini AI",
    "ai",
    "hybrid",
    [secretField("geminiApiKey", "GEMINI_API_KEY")],
    ["Query generation", "Extraction", "Relevance scoring", "Independent account failover"],
    "active",
    "Google Gemini supports query generation and procurement scoring through the configured independent-account pool.",
  ),
  tango: {
    ...provider(
      "tango",
      "Tango",
      "procurement",
      "direct_source",
      [secretField("tangoApiKey", "TANGO_API_KEY")],
      ["Direct federal procurement API", "Structured opportunity metadata", "Bounded pagination"],
      "live",
      "Independent structured federal opportunity source using the Tango by MakeGov API.",
    ),
    optionalFields: [
      {
        key: "baseUrl",
        label: "API Base URL",
        type: "url",
        placeholder: "https://tango.makegov.com/api/",
        dbKey: "tangoBaseUrl",
        envKey: "TANGO_BASE_URL",
      },
    ],
  },
  bidnet: {
    ...provider(
      "bidnet",
      "BidNet Direct",
      "procurement",
      "direct_source",
      [secretField("bidnetApiKey", "BIDNET_API_KEY")],
      ["Planned state and local bid access"],
      "coming_soon",
      "Configuration scaffold only. The direct endpoint, authentication contract, and response mapping are not implemented.",
    ),
    optionalFields: [
      {
        key: "baseUrl",
        label: "API Base URL",
        type: "url",
        placeholder: "BidNet API base URL",
        dbKey: "bidnetBaseUrl",
        envKey: "BIDNET_BASE_URL",
      },
    ],
  },
  firecrawl: provider(
    "firecrawl",
    "Firecrawl",
    "search",
    "web_discovery",
    [secretField("firecrawlApiKey", "FIRECRAWL_API_KEY")],
    ["Web search", "Full-page scraping", "Markdown extraction", "Three-account failover"],
    "active",
    "Monthly-credit discovery and page extraction fallback. Search and scrape share the same three-account failover pool.",
  ),
  browserbase: provider(
    "browserbase",
    "Browserbase Search / Fetch",
    "search",
    "web_discovery",
    [secretField("browserbaseApiKey", "BROWSERBASE_API_KEY")],
    ["Web search", "Managed page fetch", "Two-account failover"],
    "active",
    "Managed search and page-fetch fallback with two independent account slots.",
  ),
  tinyfish: {
    ...provider(
      "tinyfish", "TinyFish Intelligence", "search", "web_discovery",
      [secretField("tinyfishApiKey2", "TINYFISH_API_KEY_2", "Intelligence API Key (secondary)")],
      ["Web opportunity discovery", "Dedicated intelligence key"],
      "active",
      "Uses a separate secondary TinyFish key for Fetch Intelligence. The original TINYFISH_API_KEY remains news-only.",
    ),
    docsUrl: "https://docs.tinyfish.ai/search-api/reference",
    signupUrl: "https://agent.tinyfish.ai/",
  },
  keenable: {
    ...provider(
      "keenable",
      "Keenable",
      "search",
      "web_discovery",
      [],
      ["Keyless web search", "Date filtering", "Page fetch", "Optional higher-rate API key"],
      "active",
      "Keyless-first search and page-fetch provider. KEENABLE_API_KEY is optional and only raises service limits.",
    ),
    optionalFields: [secretField("keenableApiKey", "KEENABLE_API_KEY", "Optional API Key")],
  },
  microlink: {
    ...provider(
      "microlink",
      "Microlink",
      "search",
      "research_analysis",
      [],
      ["Keyless page text extraction", "Daily-budget guard", "Final enrichment fallback"],
      "active",
      "Final page-extraction fallback protected by a tiny daily request budget. It is not used for opportunity discovery.",
    ),
    optionalFields: [secretField("microlinkApiKey", "MICROLINK_API_KEY", "Optional API Key")],
  },
  openrouter: {
    ...provider(
      "openrouter",
      "OpenRouter",
      "ai",
      "hybrid",
      [secretField("openrouterApiKey", "OPENROUTER_API_KEY")],
      ["AI model routing", "Extraction", "Scoring", "Independent account failover"],
      "active",
    ),
    optionalFields: [
      {
        key: "model",
        label: "Model ID",
        type: "text",
        placeholder: "OpenRouter model",
        dbKey: "openrouterModel",
        envKey: "OPENROUTER_MODEL",
      },
    ],
  },
  groq: {
    ...provider(
      "groq",
      "Groq",
      "ai",
      "hybrid",
      [secretField("groqApiKey", "GROQ_API_KEY")],
      ["Fast AI inference", "Extraction", "Scoring", "Independent account failover"],
      "active",
    ),
    optionalFields: [
      {
        key: "model",
        label: "Model ID",
        type: "text",
        placeholder: "Groq model",
        dbKey: "groqModel",
        envKey: "GROQ_MODEL",
      },
    ],
  },
  exa: provider(
    "exa",
    "Exa",
    "search",
    "web_discovery",
    [secretField("exaApiKey", "EXA_API_KEY")],
    ["Neural search", "Semantic discovery", "Three-account failover", "Per-account quota telemetry"],
    "active",
  ),
  browseAi: {
    ...provider(
      "browseAi",
      "Browse AI",
      "search",
      "web_discovery",
      [secretField("browseAiApiKey", "BROWSE_AI_API_KEY")],
      ["Scraping robots", "Structured extraction"],
      "partial",
    ),
    optionalFields: [
      {
        key: "robotId",
        label: "Default Robot ID",
        type: "text",
        placeholder: "Browse AI robot ID",
        dbKey: "browseAiRobotId",
        envKey: "BROWSE_AI_ROBOT_ID",
      },
    ],
  },
  browserUse: provider(
    "browserUse",
    "BrowserUse AI",
    "search",
    "web_discovery",
    [secretField("browserUseApiKey", "BROWSER_USE_API_KEY")],
    ["Browser automation", "Dynamic site extraction"],
    "partial",
  ),
  clod: {
    ...provider(
      "clod",
      "CLōD AI",
      "ai",
      "hybrid",
      [secretField("clodApiKey", "CLOD_API_KEY", "API Key (JWT)")],
      ["AI extraction", "Scoring"],
      "partial",
    ),
    optionalFields: [
      {
        key: "model",
        label: "Model ID",
        type: "text",
        placeholder: "CLōD model",
        dbKey: "clodModel",
        envKey: "CLOD_MODEL",
      },
    ],
  },
  jina: {
    ...provider(
      "jina",
      "Jina AI Reader",
      "search",
      "research_analysis",
      [],
      ["Keyless URL-to-markdown Reader", "Optional higher Reader rate", "Embeddings when keyed"],
      "active",
      "First-choice page reader. Basic Reader works without a key; JINA_API_KEY only raises Reader limits and enables embeddings.",
    ),
    optionalFields: [secretField("jinaApiKey", "JINA_API_KEY", "Optional API Key")],
  },
  minimax: provider("minimax", "Minimax AI", "ai", "hybrid", [secretField("minimaxApiKey", "MINIMAX_API_KEY")], ["Opportunity extraction", "Relevance scoring"], "partial"),
  you: provider("you", "You.com", "search", "web_discovery", [secretField("youApiKey", "YOU_API_KEY")], ["Web search", "Opportunity sourcing", "Two-account failover", "Per-account quota/reset telemetry"], "active"),
  langsearch: provider("langsearch", "LangSearch", "search", "web_discovery", [secretField("langsearchApiKey", "LANGSEARCH_API_KEY")], ["LLM-native search", "Opportunity sourcing", "Four independent account slots"], "active"),
  parallel: provider("parallel", "Parallel", "search", "web_discovery", [secretField("parallelApiKey", "PARALLEL_API_KEY")], ["Web search", "State/local/private RFP discovery", "Monthly renewable fallback"], "active"),
  linkup: provider("linkup", "Linkup", "search", "web_discovery", [secretField("linkupApiKey", "LINKUP_API_KEY")], ["Web search", "Domain-filtered opportunity discovery"], "active"),
  socrata: provider("socrata", "Tyler Data & Insights / Socrata", "procurement", "web_discovery", [secretField("socrataApiKey", "SOCRATA_API_KEY", "API Key"), secretField("socrataApiSecret", "SOCRATA_API_SECRET", "API Secret")], ["Official open-data catalog discovery", "State and municipal procurement datasets", "Structured-source fallback"], "active"),
  websearch: provider("websearch", "WebSearch API", "search", "web_discovery", [secretField("websearchApiKey", "WEBSEARCH_API_KEY")], ["Broad web search", "Opportunity sourcing"], "partial"),
  grantsGov: {
    ...provider("grantsGov", "Grants.gov", "primary", "research_analysis", [], ["Federal grants funding intelligence", "Health program funding discovery"], "live", "Public federal grants database — no API key required. Intelligence and funding context only; not an RFP ingestion source."),
    notes: "Funding and program intelligence only. Grants.gov records feed the intel database, not the RFP opportunity list.",
  },

  cerebras: provider("cerebras", "Cerebras", "ai", "hybrid", [secretField("cerebrasApiKey", "CEREBRAS_API_KEY")], ["AI extraction", "Fast inference", "Scoring failover"], "active"),
  cohere: provider("cohere", "Cohere", "ai", "research_analysis", [secretField("cohereApiKey", "COHERE_API_KEY")], ["Semantic reranking", "Opportunity relevance scoring", "Four-account failover"], "active"),
  deepseek: provider("deepseek", "DeepSeek", "ai", "hybrid", [secretField("deepseekApiKey", "DEEPSEEK_API_KEY")], ["AI extraction", "Reasoning", "Scoring failover"], "active"),
  fal: provider("fal", "Fal.ai", "ai", "research_analysis", [secretField("falApiKey", "FAL_API_KEY")], ["Media/model utility workflows"], "partial"),
  mistral: provider("mistral", "Mistral", "ai", "hybrid", [secretField("mistralApiKey", "MISTRAL_API_KEY")], ["AI extraction", "Structured generation", "Scoring failover"], "active"),
  nvidia: provider("nvidia", "NVIDIA NIM", "ai", "hybrid", [secretField("nvidiaApiKey", "NVIDIA_API_KEY")], ["AI extraction", "Open model inference", "Scoring failover"], "active"),
  pinecone: {
    ...provider(
      "pinecone",
      "Pinecone",
      "search",
      "research_analysis",
      [
        secretField("pineconeApiKey", "PINECONE_API_KEY"),
        {
          key: "indexHost",
          label: "Index Host",
          type: "url",
          placeholder: "https://your-index.svc.region.pinecone.io",
          dbKey: "pineconeIndexHost",
          envKey: "PINECONE_INDEX_HOST",
        },
      ],
      ["Vector storage", "Similarity search", "Opportunity retrieval memory"],
      "active",
    ),
    optionalFields: [
      {
        key: "namespace",
        label: "Namespace",
        type: "text",
        placeholder: "opportunities",
        dbKey: "pineconeNamespace",
        envKey: "PINECONE_NAMESPACE",
      },
    ],
  },
  qdrant: {
    ...provider(
      "qdrant",
      "Qdrant",
      "search",
      "research_analysis",
      [
        {
          key: "url",
          label: "Qdrant URL",
          type: "url",
          placeholder: "https://your-cluster.qdrant.io",
          dbKey: "qdrantUrl",
          envKey: "QDRANT_URL",
        },
        secretField("qdrantApiKey", "QDRANT_API_KEY"),
      ],
      ["Vector storage", "Similarity search", "Opportunity retrieval memory"],
      "active",
    ),
    optionalFields: [
      {
        key: "collection",
        label: "Collection",
        type: "text",
        placeholder: "insight_hub_opportunities",
        dbKey: "qdrantCollection",
        envKey: "QDRANT_COLLECTION",
      },
    ],
  },
  cloudflareWorker: provider("cloudflareWorker", "Cloudflare Worker API", "search", "web_discovery", [secretField("cloudflareWorkerApi", "CLOUDFLARE_WORKER_API", "Worker API URL")], ["Edge extraction endpoint", "Crawler/proxy utility"], "active"),
  mongoDb: provider("mongoDb", "MongoDB API", "search", "research_analysis", [secretField("mongoDbApi", "MONGO_DB_API", "MongoDB API Key / URL")], ["External document store", "Future enrichment cache"], "partial"),
  voyage: provider("voyage", "Voyage AI", "ai", "research_analysis", [secretField("voyageApiKey", "VOYAGE_API_KEY")], ["Embeddings", "Semantic similarity", "Vector indexing fallback"], "active"),
  huggingFace: provider("huggingFace", "Hugging Face", "ai", "hybrid", [secretField("huggingFaceApiKey", "HUGGINGFACE_API_KEY")], ["Embeddings", "Model inference", "Vector indexing fallback"], "active"),
  selfHostedCrawler: provider("selfHostedCrawler", "Self-Hosted Crawler", "search", "web_discovery", [secretField("selfHostedCrawlerUrl", "SELF_HOSTED_CRAWLER_URL", "Crawler Service URL")], ["Full-page scraping", "Markdown extraction", "No API keys required"], "active"),
  rssAggregator: provider("rssAggregator", "RSS Feed Aggregator", "procurement", "direct_source", [], ["Government RSS feeds", "Real-time updates", "No API keys required"], "live", "Aggregates RSS feeds from official government portals for supplemental opportunity discovery without paid search dependencies."),
  localLlm: provider("localLlm", "Local LLM (Retired)", "ai", "research_analysis", [], ["Retired integration"], "not_configured", "Retired self-hosted LLM integration. The hardened runtime no longer supports Ollama, LocalAI, or local OpenAI-compatible inference as an extraction or scoring fallback."),
  selfHostedSearch: provider("selfHostedSearch", "Self-Hosted Search (Meilisearch/Typesense)", "search", "research_analysis", [secretField("selfHostedSearchEndpoint", "SELF_HOSTED_SEARCH_ENDPOINT", "Search Engine URL")], ["Full-text search", "No API keys required", "Self-hosted"], "active", "Self-hosted search engine provider supporting Meilisearch, Typesense, or compatible servers for non-production research paths."),
  emailNotifications: {
    ...provider(
      "emailNotifications",
      "Email Notifications",
      "procurement",
      "direct_source",
      [
        {
          key: "imapHost",
          label: "IMAP Host",
          type: "text",
          placeholder: "imap.gmail.com",
          dbKey: "emailImapHost",
          envKey: "EMAIL_IMAP_HOST",
        },
        {
          key: "imapPort",
          label: "IMAP Port",
          type: "text",
          placeholder: "993",
          dbKey: "emailImapPort",
          envKey: "EMAIL_IMAP_PORT",
        },
        {
          key: "imapUser",
          label: "Email Address",
          type: "text",
          placeholder: "procurement@example.com",
          dbKey: "emailImapUser",
          envKey: "EMAIL_IMAP_USER",
        },
        secretField("emailImapPassword", "EMAIL_IMAP_PASSWORD", "Email Password/App Password"),
      ],
      ["Email notification parsing", "Official portal alerts", "No scraping required"],
      "live",
      "Polls a dedicated email inbox for procurement opportunity notifications from government portals.",
    ),
    optionalFields: [],
  },
};

/**
 * Resolve a provider credential.
 *
 * Precedence (env-first):
 *   1. Environment variable — Render secrets and process-level env take priority.
 *   2. Database setting — used only when the environment variable is absent or empty.
 *
 * Returns null when neither source provides a non-empty value.
 * Never logs or exposes the resolved secret value.
 */
const credentialSettingsCache = createCredentialSettingsCache(async () => {
  const rows = await db.select().from(settingsTable);
  return new Map(rows.map((row) => [row.key, row.value]));
});

export function invalidateCredentialSettingsCache(): void {
  credentialSettingsCache.invalidate();
}

export interface ResolvedCredential {
  value: string;
  source: "environment" | "database";
  key: string;
}

export async function resolveCredentialWithSource(
  dbKey: string,
  envKey?: string,
): Promise<ResolvedCredential | null> {
  if (envKey) {
    const envVal = process.env[envKey];
    if (envVal && envVal.trim()) {
      return { value: envVal.trim(), source: "environment", key: envKey };
    }
  }

  try {
    const dbVal = (await credentialSettingsCache.get()).get(dbKey);
    if (dbVal && dbVal.trim()) {
      return { value: dbVal.trim(), source: "database", key: dbKey };
    }
  } catch {
    // DB may be unavailable during early startup; treat as unconfigured.
  }

  return null;
}

export async function resolveCredential(
  dbKey: string,
  envKey?: string,
): Promise<string | null> {
  return (await resolveCredentialWithSource(dbKey, envKey))?.value ?? null;
}

/** Check whether a credential is configured without returning its value. */
export async function isCredentialConfigured(
  dbKey: string,
  envKey?: string,
): Promise<boolean> {
  return (await resolveCredential(dbKey, envKey)) !== null;
}
