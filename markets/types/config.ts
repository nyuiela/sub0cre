/**
 * Workflow config shape. Merge schedule (cron) with optional contract config for EVM flows.
 * Contract addresses can be inlined in config.staging.json / config.production.json from contracts.json.
 */

import type { ChainContractConfig } from "./contracts";

export interface WorkflowConfig {
  schedule: string;
  contracts?: ChainContractConfig;
}
