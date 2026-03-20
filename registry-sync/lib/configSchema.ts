import { z } from "zod";

const contractsSchema = z
  .object({
    chainId: z.number(),
    chainSelectorName: z.string(),
    contracts: z.record(z.string()),
  })
  .passthrough()
  .optional();

export const registrySyncConfigSchema = z.object({
  schedule: z.string(),
  backendUrl: z.string(),
  backendApiKeySecretId: z.string().optional(),
  backendUsePlainAuth: z.boolean().optional(),
  contracts: contractsSchema,
});
