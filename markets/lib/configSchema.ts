/**
 * Zod schema for workflow config. Used by Runner.newRunner({ configSchema }) so config
 * is validated at load time (aligns with CRE docs "Making Confidential Requests").
 */

import { z } from "zod";

const contractsSchema = z
  .object({
    chainId: z.number(),
    chainSelectorName: z.string(),
    gasLimit: z.string().optional(),
    contracts: z.record(z.string()),
    eip712: z.object({
      domainName: z.string(),
      domainVersion: z.string(),
      quoteTypeName: z.string(),
    }),
    conventions: z.object({
      usdcDecimals: z.number(),
      outcomeTokenDecimals: z.number(),
      parentCollectionId: z.string(),
    }),
  })
  .passthrough()
  .optional();

export const workflowConfigSchema = z.object({
  schedule: z.string(),
  backendUrl: z.string().optional(),
  backendApiKeySecretId: z.string().optional(),
  backendUsePlainAuth: z.boolean().optional(),
  backendAgentMarketsPath: z.string().optional(),
  backendOnchainCreatedPath: z.string().optional(),
  contracts: contractsSchema,
});

export type WorkflowConfigFromSchema = z.infer<typeof workflowConfigSchema>;
