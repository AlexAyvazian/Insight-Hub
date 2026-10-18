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
    logMethod(args, method) {
      method.apply(
        this,
        args.map((arg) => (typeof arg === "string" ? redactSensitiveText(arg) : arg)) as Parameters<typeof method>,
      );
    },
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
