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

export const settlementConsensusConfigSchema = z.object({
  schedule: z.string(),
  backendUrl: z.string(),
  backendApiKeySecretId: z.string().optional(),
  backendUsePlainAuth: z.boolean().optional(),
  contracts: contractsSchema,
});
