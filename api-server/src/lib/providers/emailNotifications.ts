/**
 * Email Notification Provider
 *
 * Polls a dedicated email inbox for procurement opportunity notifications
 * from government portals. Uses IMAP to fetch emails and extracts
 * opportunity details from the email content.
 *
 * Benefits:
 * - No scraping required
 * - Official notification system
 * - Real-time updates
 * - Works with any email provider
 */

import { createHash } from "crypto";
import type { DataSourceProvider, FetchOptions, NormalizedOpportunity, ProviderFetchResult, ProviderStatus } from "./types";
import { resolveCredential } from "../config/providerConfig";
import { classifyResult } from "../search/relevance";
import { decideRelevance } from "../search/relevanceDecision";

interface EmailConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  tls: boolean;
}

interface EmailMessage {
  from: string;
  subject: string;
  body: string;
  date: Date;
  messageId: string;
}

const MAX_EMAIL_SOURCE_BYTES = 64 * 1024;
const MAX_EMAIL_MESSAGES = 50;

// IMAP envelope dates can be Date objects or raw date strings in ImapFlow 2.
export function emailEnvelopeDate(value: Date | string | undefined, fallback = new Date()): Date {
  const parsed = value instanceof Date ? value : value ? new Date(value) : fallback;
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;

  const error = new Error("Email notification fetch was cancelled");
  error.name = "AbortError";
  throw error;
}

export class EmailNotificationProvider implements DataSourceProvider {
  readonly name = "emailNotifications" as const;

  private async config(): Promise<EmailConfig | null> {
    const [host, portStr, user, password] = await Promise.all([
      resolveCredential("emailImapHost", "EMAIL_IMAP_HOST"),
      resolveCredential("emailImapPort", "EMAIL_IMAP_PORT"),
      resolveCredential("emailImapUser", "EMAIL_IMAP_USER"),
      resolveCredential("emailImapPassword", "EMAIL_IMAP_PASSWORD"),
    ]);

    if (!host || !user || !password) return null;

    const parsedPort = portStr ? Number.parseInt(portStr, 10) : 993;

    return {
      host,
      port: Number.isFinite(parsedPort) ? parsedPort : 993,
      user,
      password,
      tls: true,
    };
  }

  async isConfigured(): Promise<boolean> {
    return !!(await this.config());
  }

  async fetch(options: FetchOptions): Promise<ProviderFetchResult> {
    const config = await this.config();
    if (!config) {
      return { records: [], total: 0, errors: ["Email provider not configured"] };
    }

    const records: NormalizedOpportunity[] = [];
    const errors: string[] = [];

    try {
      const messages = await this.fetchRecentEmails(config, options.signal);

      for (const message of messages) {
        const opp = this.extractOpportunity(message);
        if (opp) {
          const relevance = classifyResult({
            title: opp.title,
            snippet: opp.description,
            url: opp.sourceUrl,
            allowHistorical: true,
          });

          if (decideRelevance(relevance).verdict !== "reject") {
            records.push(opp);
          }
        }
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    return {
      records: records.slice(0, options.limit ?? MAX_EMAIL_MESSAGES),
      total: records.length,
      errors,
    };
  }

  async getStatus(): Promise<ProviderStatus> {
    const configured = await this.isConfigured();
    return { name: this.name, configured, healthy: configured };
  }

  private async fetchRecentEmails(config: EmailConfig, signal?: AbortSignal): Promise<EmailMessage[]> {
    const messages: EmailMessage[] = [];
    throwIfAborted(signal);

    // ImapFlow exposes a named export. Loading it only when this provider is
    // configured keeps the server startup path independent from IMAP runtime code.
    const { ImapFlow } = await import("imapflow");
    const client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.tls,
      auth: {
        user: config.user,
        pass: config.password,
      },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });

    try {
      await client.connect();
      throwIfAborted(signal);

      const mailbox = await client.mailboxOpen("INBOX");
      if (!mailbox.exists) return messages;

      const range = `${Math.max(1, mailbox.exists - (MAX_EMAIL_MESSAGES - 1))}:*`;

      for await (const message of client.fetch(range, {
        envelope: true,
        // Do not download attachments or unlimited RFC822 sources. A single
        // large email previously had enough headroom to terminate this service.
        source: { start: 0, maxLength: MAX_EMAIL_SOURCE_BYTES },
      })) {
        throwIfAborted(signal);

        if (!message.envelope || !message.source) continue;

        const text = message.source.toString("utf-8");
        const bodyMatch = text.match(/Content-Type: text\/plain[\s\S]*?\r\n\r\n([\s\S]*?)(?=\r\n--|\r\n\r\nContent-Type:|$)/i);
        const body = bodyMatch
          ? bodyMatch[1].replace(/\r\n/g, "\n").trim()
          : text.slice(0, MAX_EMAIL_SOURCE_BYTES);

        messages.push({
          from: message.envelope.from?.[0]?.address || message.envelope.sender?.[0]?.address || "",
          subject: message.envelope.subject || "",
          body,
          date: emailEnvelopeDate(message.envelope.date),
          messageId: message.envelope.messageId || `imap-${message.uid}`,
        });
      }
    } finally {
      try {
        await client.logout();
      } catch {
        // The socket may already be closed after a timeout or authentication error.
      }
    }

    return messages;
  }

  private extractOpportunity(message: EmailMessage): NormalizedOpportunity | null {
    const subject = message.subject;
    const body = message.body;

    const procurementKeywords = ["RFP", "RFQ", "solicitation", "bid", "opportunity", "contract", "procurement"];
    const hasProcurementKeyword = procurementKeywords.some(
      (keyword) =>
        subject.toLowerCase().includes(keyword.toLowerCase()) ||
        body.toLowerCase().includes(keyword.toLowerCase()),
    );

    if (!hasProcurementKeyword) return null;

    const urlMatch = body.match(/https?:\/\/[^\s<>\"]+/);
    const sourceUrl = urlMatch ? urlMatch[0] : undefined;

    const agencyMatch = body.match(/(?:Agency|Department|from):\s*([^\n\r]+)/i);
    const agency = agencyMatch ? agencyMatch[1].trim() : this.extractAgencyFromEmail(message.from);

    const externalId = `email-${createHash("sha256").update(message.messageId).digest("hex").slice(0, 16)}`;

    return {
      externalId,
      title: subject,
      agency: agency || "Government Agency",
      type: "Solicitation",
      status: "active",
      postedDate: message.date,
      sourceUrl,
      description: body.slice(0, 2000),
      source: "emailNotifications",
      providerName: "emailNotifications",
      rawData: {
        providerName: "email_notification",
        providerFamily: "email_notification",
        discoveryMethod: "email_notification",
        sourceId: "email-notifications",
        sourceConfidence: "high",
        emailFrom: message.from,
        emailSubject: subject,
        emailDate: message.date.toISOString(),
        tags: ["email-notification", "official-source"],
      },
    };
  }

  private extractAgencyFromEmail(from: string): string | null {
    const match = from.match(/@([^.]+)/);
    if (match) {
      const domain = match[1];
      if (domain.includes("gov")) return "Federal Agency";
      if (domain.includes("state")) return "State Agency";
      if (domain.includes("county")) return "County Agency";
    }
    return null;
  }
}

export const emailNotificationProvider = new EmailNotificationProvider();
