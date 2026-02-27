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
  /** Funder (CRE_ETH_PRIVATE_KEY) nonce for the ETH transfer tx. Required for broadcast: caller must fetch via eth_getTransactionCount and pass to avoid "nonce too low". */
  funderNonce?: number;
  /** Optional per-request entropy (e.g. random hex) so each run yields a different agent key when simulator RNG is deterministic. */
  entropy?: string;
}

export interface CreateAgentKeyResponse {
  address: string;
  encryptedKeyBlob: string;
  /** Signed ETH transfer tx (backend broadcasts to fund agent with ~$10 ETH). */
  signedEthTransfer?: string;
  /** Signed ERC20 approve tx (backend broadcasts so agent can spend USDC via vault). */
  signedErc20?: string;
  /** Signed conditional token setApprovalForAll tx (backend broadcasts). */
  signedCT?: string;
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
