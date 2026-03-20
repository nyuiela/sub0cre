/**
 * Workflow config shape. Merge schedule (cron) with optional contract config for EVM flows.
 * Contract addresses can be inlined in config.staging.json / config.production.json from contracts.json.
 */

import type { ChainContractConfig } from "./contracts";

export interface WorkflowConfig {
  schedule: string;
  contracts?: ChainContractConfig;
  /** Backend base URL for agent-markets and onchain-created (e.g. https://api.sub0.example). */
  backendUrl?: string;
  /** Secret id for backend API key (namespace sub0). If unset, backend may 401. */
  backendApiKeySecretId?: string;
  /**
   * When true (e.g. docker-settings), use getSecret + plain fetch for backend calls instead of Confidential HTTP.
   * Use only for simulate/Docker where the DON vault template may not be resolved.
   */
  backendUsePlainAuth?: boolean;
  /** No-auth CRE endpoints. When set, workflow calls these and does not send API key. */
  backendAgentMarketsPath?: string;
  backendOnchainCreatedPath?: string;
  /** When true, compliance pre-check is called per agent+market pair before LLM dispatch. */
  complianceEnabled?: boolean;
  /** When true, x402 payment steps are active for each workflow execution. */
  x402Enabled?: boolean;
  /** When true, DataStreamsRegistry and LiveRegistrySync cron workflows run. */
  dataStreamsEnabled?: boolean;
  /** When true, compliance decisions are recorded on-chain via Sub0CRERegistry. */
  aceComplianceMode?: boolean;
  /** When true, agentEvolution runs extended 10k-backtest RL loop. */
  deepEvolution?: boolean;
  /** When true, webhookBridge forwards events to the frontend webhook URL. */
  frontendWebhookEnabled?: boolean;
  /** Direct frontend webhook URL for webhookBridge (bypasses backend WS when set). */
  frontendWebhookUrl?: string;
}
