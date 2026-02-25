/**
 * CRE (Contract Report Encoding) payload types for Sub0 and PredictionVault.
 * Matches md/cre.contract.md: report = prefix (1 byte) + abi.encode(payload).
 */

/** Sub0 CRE action prefixes (first byte of report). */
export const SUB0_CRE_ACTION = {
  CREATE: 0x00,
  RESOLVE: 0x01,
  STAKE: 0x02,
  REDEEM: 0x03,
} as const;

/** PredictionVault CRE action prefixes. */
export const PREDICTION_VAULT_CRE_ACTION = {
  EXECUTE_TRADE: 0x00,
  SEED_LIQUIDITY: 0x01,
} as const;

/** Sub0 resolve: abi.encode(questionId, payouts, oracle). */
export interface Sub0ResolvePayload {
  questionId: `0x${string}`;
  payouts: readonly bigint[];
  oracle: `0x${string}`;
}

/** Sub0 stake: abi.encode(questionId, parentCollectionId, partition, token, amount, owner). */
export interface Sub0StakePayload {
  questionId: `0x${string}`;
  parentCollectionId: `0x${string}`;
  partition: readonly bigint[];
  token: `0x${string}`;
  amount: bigint;
  owner: `0x${string}`;
}

/** Sub0 redeem: abi.encode(parentCollectionId, conditionId, indexSets, token, owner, deadline, nonce, signature). */
export interface Sub0RedeemPayload {
  parentCollectionId: `0x${string}`;
  conditionId: `0x${string}`;
  indexSets: readonly bigint[];
  token: `0x${string}`;
  owner: `0x${string}`;
  deadline: bigint;
  nonce: bigint;
  signature: `0x${string}`;
}

/** PredictionVault execute trade: flat args for abi.encode. */
export interface PredictionVaultExecuteTradePayload {
  questionId: `0x${string}`;
  outcomeIndex: bigint;
  buy: boolean;
  quantity: bigint;
  tradeCostUsdc: bigint;
  maxCostUsdc: bigint;
  nonce: bigint;
  deadline: bigint;
  user: `0x${string}`;
  donSignature: `0x${string}`;
  userSignature: `0x${string}`;
}
