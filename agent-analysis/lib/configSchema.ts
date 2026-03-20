import { z } from "zod";

export const agentAnalysisConfigSchema = z.object({
  schedule: z.string(),
  backendUrl: z.string(),
  backendApiKeySecretId: z.string().optional(),
  backendUsePlainAuth: z.boolean().optional(),
  geminiModel: z.string().optional(),
  grokModel: z.string().optional(),
  maxAgentsPerRun: z.number().optional(),
  maxMarketsPerAgent: z.number().optional(),
});
