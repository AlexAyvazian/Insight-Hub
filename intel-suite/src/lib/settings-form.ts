import * as z from "zod";

export const settingsFormSchema = z.object({
  organizationName: z.string().min(2, "Organization name is required").optional().or(z.literal("")),
  defaultKeywords: z.string().optional(),
  defaultDateRange: z.coerce.number<string | number>().min(1).max(365).optional(),
});
