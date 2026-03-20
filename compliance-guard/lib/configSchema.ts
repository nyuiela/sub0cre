import { z } from "zod";

export const complianceGuardConfigSchema = z.object({
  schedule: z.string(),
  backendUrl: z.string(),
  backendApiKeySecretId: z.string().optional(),
  backendUsePlainAuth: z.boolean().optional(),
  blockedCountries: z.array(z.string()).optional(),
  minWalletAgeDays: z.number().optional(),
});
