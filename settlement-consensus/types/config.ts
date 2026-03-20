/**
 * Workflow config for settlement-consensus.
 * HTTP-triggered: two-LLM deliberation in CRE TEE, then EVM write to AgentSettlementReceiver.
 */

export interface SettlementConsensusConfig {
  /** Cron schedule (kept for potential future trigger; not primary). */
  schedule: string;
  /** Backend base URL. */
  backendUrl: string;
  /** Secret id for backend API key. */
  backendApiKeySecretId?: string;
  /** When true, use plain HTTP + getSecret (docker/simulate). */
  backendUsePlainAuth?: boolean;
  /** Contracts config (needs agentSettlementReceiver + chainSelectorName). */
  contracts?: {
    chainId: number;
    chainSelectorName: string;
    gasLimit?: string;
    contracts: Record<string, string>;
  };
}
