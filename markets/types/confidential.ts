/**
 * Payload and response types for Confidential Compute workflows.
 * Agent key generation and confidential trade execution.
 */

import type { ChainContractConfig } from "./contracts";

export interface CreateAgentKeyConfig {
  agentKeysNamespace?: string;
}

export interface CreateAgentKeyPayload {
  agentId: string;
}

export interface CreateAgentKeyResponse {
  address: string;
}

export interface ConfidentialTradePayload {
  agentId: string;
  marketId: string;
  outcomeIndex: number;
  buy: boolean;
  quantity: string;
  tradeCostUsdc: string;
  nonce: string;
  deadline: string;
}

export interface ExecuteConfidentialTradeConfig {
  contracts?: ChainContractConfig;
  agentKeysNamespace?: string;
}

export interface ExecuteConfidentialTradeResponse {
  txHash: string;
}
