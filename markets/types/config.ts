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
}
