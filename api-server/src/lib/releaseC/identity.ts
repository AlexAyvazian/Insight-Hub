/**
 * Shared identities for Release C: the opportunity key used across documents/queue/ledger, the content hash that
 * invalidates cached judgments, and model-family resolution so two accounts or gateways serving the same underlying
 * model never count as independent votes.
 */
import { createHash } from "node:crypto";
import type { NormalizedOpportunity } from "../providers/types";
import { generatedProviderNativeId, providerKeyForOpportunity } from "../ingestion/opportunityIdentity";

/** Same shape as the existing "provider" dedupe key, so it lines up with opportunity_dedupe_keys rows. */
export function opportunityKey(record: NormalizedOpportunity): string {
  return `provider:${providerKeyForOpportunity(record)}:${generatedProviderNativeId(record).trim().toLowerCase()}`;
}

/**
 * The same key for a stored opportunities row: promotion stores generatedProviderNativeId as notice_id and
 * providerKeyForOpportunity as provider_key, so a row maps back to the decision made on its record.
 */
export function opportunityKeyForRow(row: {
  providerKey?: unknown;
  noticeId?: unknown;
  samUrl?: unknown;
  title?: unknown;
  agency?: unknown;
  solicitationNumber?: unknown;
}): string {
  const notice = String(row.noticeId ?? "").trim();
  const native = notice ||
    generatedProviderNativeId({
      externalId: "",
      sourceUrl: row.samUrl ? String(row.samUrl) : undefined,
      title: String(row.title ?? ""),
      agency: String(row.agency ?? ""),
      solicitationNumber: row.solicitationNumber ? String(row.solicitationNumber) : undefined,
    } as NormalizedOpportunity);
  return `provider:${String(row.providerKey ?? "") || "manual"}:${native.trim().toLowerCase()}`;
}

function iso(value: Date | string | null | undefined): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

/**
 * Hash of everything a relevance judgment depends on: the FULL description (not a prefix), title, buyer, notice
 * type, deadline, set-aside, place, NAICS/PSC, every current document hash (attachments and amendments), and the
 * OCCU_MED_AWARE profile version. Any change anywhere produces a new hash and therefore a fresh judgment.
 */
export function judgmentContentHash(
  record: NormalizedOpportunity,
  context: { documentHashes?: string[]; profileVersion?: string | null } = {},
): string {
  const raw = (record.rawData ?? {}) as Record<string, unknown>;
  return createHash("sha256")
    .update(
      JSON.stringify({
        url: record.sourceUrl ?? "",
        id: record.externalId ?? "",
        title: record.title ?? "",
        agency: record.agency ?? "",
        subAgency: record.subAgency ?? "",
        type: record.type ?? "",
        solicitation: record.solicitationNumber ?? "",
        naics: record.naicsCode ?? "",
        psc: (raw.classificationCode as string | undefined) ?? "",
        setAside: record.setAside ?? "",
        place: record.placeOfPerformance ?? "",
        deadline: iso(record.responseDeadline),
        modified: (raw.modifiedDate as string | undefined) ?? "",
        description: record.description ?? "",
        documents: [...(context.documentHashes ?? [])].sort(),
        profile: context.profileVersion ?? "",
      }),
    )
    .digest("hex");
}

const FAMILIES: Array<[RegExp, string]> = [
  [/gpt-oss/i, "openai-gpt-oss"],
  [/\bgpt-?[345]|\bo[134]-|openai\//i, "openai-gpt"],
  [/llama|meta\//i, "meta-llama"],
  [/mi[sx]tral|codestral|magistral|ministral/i, "mistral"],
  [/deepseek/i, "deepseek"],
  [/qwen|qwq/i, "alibaba-qwen"],
  [/gemini|gemma/i, "google-gemini"],
  [/claude|anthropic/i, "anthropic-claude"],
  [/minimax/i, "minimax"],
  [/command|cohere|aya/i, "cohere"],
  [/nemotron/i, "nvidia-nemotron"],
  [/phi-?\d/i, "microsoft-phi"],
  [/kimi|moonshot/i, "moonshot-kimi"],
  [/glm|zhipu/i, "zhipu-glm"],
  [/grok/i, "xai-grok"],
];

/** Model family from a model id. Unknown ids keep their own id (treated as their own family). */
export function modelFamily(modelId: string | null | undefined, providerName = ""): string {
  const id = (modelId ?? "").trim();
  for (const [pattern, family] of FAMILIES) if (pattern.test(id)) return family;
  if (!id) {
    // Fall back to the provider's own default family when the model id is not exposed.
    const defaults: Record<string, string> = {
      gemini: "google-gemini",
      minimax: "minimax",
      clod: "anthropic-claude",
      deepseek: "deepseek",
      mistral: "mistral",
    };
    return defaults[providerName] ?? `provider:${providerName || "unknown"}`;
  }
  return `model:${id.toLowerCase()}`;
}

/** Resolves a provider's configured model id when it exposes one (OpenAI-compatible adapters, Groq, OpenRouter). */
export async function providerModelFamily(provider: { name: string }): Promise<string> {
  const candidate = provider as { getModel?: () => Promise<string | null> | string | null; defaultModel?: string };
  let model: string | null = null;
  try {
    const value = typeof candidate.getModel === "function" ? await candidate.getModel() : null;
    model = typeof value === "string" ? value : null;
  } catch {
    model = null;
  }
  return modelFamily(model ?? candidate.defaultModel ?? null, provider.name);
}
