import { z } from "zod";

const contractsSchema = z
  .object({
    chainId: z.number(),
    chainSelectorName: z.string(),
    gasLimit: z.string().optional(),
    contracts: z.record(z.string()),
    eip712: z
      .object({
        domainName: z.string(),
        domainVersion: z.string(),
        quoteTypeName: z.string(),
      })
      .optional(),
    conventions: z
      .object({
        usdcDecimals: z.number(),
        outcomeTokenDecimals: z.number(),
        parentCollectionId: z.string(),
      })
      .optional(),
  })
  .passthrough()
  .optional();

export const confidentialTradeConfigSchema = z.object({
  schedule: z.string(),
  backendUrl: z.string(),
  backendApiKeySecretId: z.string().optional(),
  backendUsePlainAuth: z.boolean().optional(),
  contracts: contractsSchema,
});
