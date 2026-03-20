/**
 * Workflow config for confidential-trade.
 * HTTP-triggered standalone TEE trade execution workflow.
 */

export interface ConfidentialTradeConfig {
  /** Cron schedule (kept for consistency; not primary trigger). */
  schedule: string;
  /** Backend base URL. */
  backendUrl: string;
  /** Secret id for backend API key. */
  backendApiKeySecretId?: string;
  /** When true, use plain HTTP + getSecret (docker/simulate). */
  backendUsePlainAuth?: boolean;
  /** Contracts config (needs predictionVault + chainSelectorName). */
  contracts?: {
    chainId: number;
    chainSelectorName: string;
    gasLimit?: string;
    contracts: Record<string, string>;
    eip712?: {
      domainName: string;
      domainVersion: string;
      quoteTypeName: string;
    };
    conventions?: {
      usdcDecimals: number;
      outcomeTokenDecimals: number;
      parentCollectionId: string;
    };
  };
}
