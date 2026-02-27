/**
 * Sub0 market and related types.
 * Matches Sub0.getMarket(questionId) return shape.
 */

export type OracleType = 0 | 1 | 2 | 3; // NONE, PLATFORM, ARBITRATOR, CUSTOM

export type InvitationType = number; // from InvitationManager

export interface Sub0Market {
  question: string;
  conditionId: `0x${string}`;
  oracle: `0x${string}`;
  owner: `0x${string}`;
  createdAt: bigint;
  duration: bigint;
  outcomeSlotCount: number;
  oracleType: OracleType;
  marketType: InvitationType;
}

export type QuestionId = `0x${string}`;

export type ConditionId = `0x${string}`;

/** Params for Sub0.create(Market). conditionId, createdAt are set onchain; owner must match backend creator for questionId. */
export interface CreateMarketParams {
  question: string;
  oracle: `0x${string}`;
  /** Creator address; contract uses this as actualCreator for questionId and GAME_CREATOR_ROLE. */
  owner: `0x${string}`;
  duration: number | bigint;
  outcomeSlotCount: number;
  oracleType: OracleType; // 1=PLATFORM, 2=ARBITRATOR, 3=CUSTOM (not 0=NONE)
  marketType: InvitationType; // 0=Single, 1=Group, 2=Public
}
