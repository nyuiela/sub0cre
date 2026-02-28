/**
 * PredictionVault executeTrade EIP-712: user signs UserTrade, DON signs DONQuote.
 * USER_TRADE_TYPEHASH = UserTrade(bytes32 marketId, uint256 outcomeIndex, bool buy, uint256 quantity, uint256 maxCostUsdc, uint256 nonce, uint256 deadline)
 * DON_QUOTE_TYPEHASH = DONQuote(bytes32 marketId, uint256 outcomeIndex, bool buy, uint256 quantity, uint256 tradeCostUsdc, address user, uint256 nonce, uint256 deadline)
 */

export interface LMSRQuoteParams {
  questionId: `0x${string}`;
  outcomeIndex: number;
  user: `0x${string}`;
  buy: boolean;
  quantity: bigint;
  tradeCostUsdc: bigint;
  nonce: bigint;
  deadline: bigint;
}

/** Params for DON to sign DONQuote (tradeCostUsdc + user). Same quantity, nonce, deadline as UserTrade for consistency. */
export interface DONQuoteParams {
  questionId: `0x${string}`;
  outcomeIndex: number;
  buy: boolean;
  quantity: bigint | string | number;
  tradeCostUsdc: bigint | string | number;
  user: `0x${string}`;
  nonce: bigint;
  deadline: bigint;
}

export interface SignedQuoteResult {
  questionId: `0x${string}`;
  outcomeIndex: number;
  user?: `0x${string}`;
  buy: boolean;
  quantity: string;
  tradeCostUsdc: string;
  nonce: string;
  deadline: string;
  signature: `0x${string}`;
}

/** One fill in a batch (order book): user signature + quote params. User address recovered from UserTrade signature. */
export interface BatchTradeItem {
  userSignature: string;
  quantity: string;
  tradeCostUsdc: string;
  /** User-signed max cost; must be >= tradeCostUsdc. Defaults to tradeCostUsdc if omitted. */
  maxCostUsdc?: string;
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
