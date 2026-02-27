/**
 * LMSR quote and signing types for PredictionVault.executeTrade.
 * EIP-712 struct: LMSRQuote(questionId, outcomeIndex, buy, quantity, tradeCostUsdc, nonce, deadline).
 */

export interface LMSRQuoteParams {
  questionId: `0x${string}`;
  outcomeIndex: number;
  buy: boolean;
  quantity: bigint;
  tradeCostUsdc: bigint;
  nonce: bigint;
  deadline: bigint;
}

export interface SignedQuoteResult {
  questionId: `0x${string}`;
  outcomeIndex: number;
  buy: boolean;
  quantity: string;
  tradeCostUsdc: string;
  nonce: string;
  deadline: string;
  signature: `0x${string}`;
}

/** One fill in a batch (order book): user signature + quote params. User address recovered from signature. */
export interface BatchTradeItem {
  userSignature: string;
  quantity: string;
  tradeCostUsdc: string;
  nonce: string;
  deadline: string;
}

/** Batch trade payload: shared market params + array of trades (one writeReport per trade). */
export interface BatchTradePayload {
  questionId: string;
  conditionId: string;
  outcomeIndex: number;
  buy: boolean;
  trades: BatchTradeItem[];
}

/** Response when executing a batch of trades (one txHash per successful submit). */
export interface BatchTradeResponse {
  txHashes: string[];
  errors?: string[];
}
