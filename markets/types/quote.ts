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
