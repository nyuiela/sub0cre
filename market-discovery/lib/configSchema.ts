import { z } from "zod";

const contractsSchema = z
  .object({
    chainId: z.number(),
    chainSelectorName: z.string(),
    gasLimit: z.string().optional(),
    contracts: z.record(z.string()),
  })
  .passthrough()
  .optional();

export const marketDiscoveryConfigSchema = z.object({
  schedule: z.string(),
  backendUrl: z.string(),
  backendApiKeySecretId: z.string().optional(),
  backendUsePlainAuth: z.boolean().optional(),
  geminiModel: z.string().optional(),
  maxMarketsPerRun: z.number().optional(),
  contracts: contractsSchema,
});
