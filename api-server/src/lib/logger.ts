import pino from "pino";
import { redactSensitiveText } from "./security/logRedaction";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  hooks: {
    // Redacts the final serialized line, so nested fields and serialized errors are covered too.
    streamWrite: (line) => redactSensitiveText(line),
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
