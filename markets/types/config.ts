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
}

export const BACKEND_SIGNER_SECRET_NAMESPACE = "sub0";
export const BACKEND_SIGNER_SECRET_ID = "BACKEND_SIGNER_PRIVATE_KEY";
