/**
 * LMSR pricing workflow request and response types.
 * DON signs the quote; user/agent signs intent; relayer submits both.
 */

import type { ChainContractConfig } from "./contracts";

export interface LmsrPricingConfig {
  contracts?: ChainContractConfig;
  deadlineSeconds?: number;
}

export interface LmsrPricingRequestPayload {
  marketId: string;
  outcomeIndex: number;
  quantity: string;
  bParameter: string;
}

export interface LmsrPricingResponse {
  tradeCostUsdc: string;
  donSignature: string;
  deadline: string;
  nonce: string;
}
