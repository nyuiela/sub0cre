/**
 * Workflow config for agent-analysis.
 * Cron + HTTP driven: fetch active agent+market pairs, run LLM analysis, POST /api/orders.
 */

export interface AgentAnalysisConfig {
  /** Cron schedule (e.g. "0 */15 * * * *"). */
  schedule: string;
  /** Backend base URL. */
  backendUrl: string;
  /** Secret id for backend API key (namespace sub0). */
  backendApiKeySecretId?: string;
  /** When true, use plain HTTP + getSecret (docker/simulate). */
  backendUsePlainAuth?: boolean;
  /** Gemini model for trading decisions. */
  geminiModel?: string;
  /** Grok/xAI model for trading decisions. */
  grokModel?: string;
  /** Max agents to process per cron run. */
  maxAgentsPerRun?: number;
  /** Max markets per agent per run. */
  maxMarketsPerAgent?: number;
}
