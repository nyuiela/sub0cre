/**
 * Workflow config for cross-chain-sync.
 * EVM log-triggered CCIP broadcast of market metadata to Arbitrum Sepolia / Polygon Amoy.
 */

export interface CrossChainSyncConfig {
  /** Cron schedule (fallback for periodic sync runs). */
  schedule: string;
  /** Backend base URL. */
  backendUrl: string;
  /** Secret id for backend API key. */
  backendApiKeySecretId?: string;
  /** When true, use plain HTTP + getSecret (docker/simulate). */
  backendUsePlainAuth?: boolean;
  /** Source chain config (where MarketCreated events are emitted). */
  sourceContracts?: {
    chainId: number;
    chainSelectorName: string;
    contracts: Record<string, string>;
  };
  /** CCIP destination chain selector names (e.g. ["arbitrum-testnet-sepolia", "polygon-testnet-amoy"]). */
  destinationChains?: string[];
}
