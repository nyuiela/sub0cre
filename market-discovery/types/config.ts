/**
 * Workflow config for market-discovery.
 * Cron-driven: fetch agent markets from backend, create on-chain, POST registry-sync.
 */

export interface MarketDiscoveryConfig {
  /** Cron schedule (e.g. "0 */5 * * * *"). */
  schedule: string;
  /** Backend base URL (e.g. http://host.docker.internal:4000). */
  backendUrl: string;
  /** Secret id for backend API key (namespace sub0). */
  backendApiKeySecretId?: string;
  /** When true, use plain HTTP + getSecret instead of Confidential HTTP (docker/simulate). */
  backendUsePlainAuth?: boolean;
  /** Gemini model to use for market proposals (default: gemini-2.0-flash). */
  geminiModel?: string;
  /** Max number of markets to create per cron run. */
  maxMarketsPerRun?: number;
  /** Contracts config (needs predictionVault + chainSelectorName). */
  contracts?: {
    chainId: number;
    chainSelectorName: string;
    gasLimit?: string;
    contracts: Record<string, string>;
  };
}
