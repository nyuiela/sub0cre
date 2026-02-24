/**
 * ConditionalTokensV2 (CTF) view-only interactions.
 * CRE uses: getCollectionId, getPositionId, getOutcomeSlotCount, balanceOf.
 * No prepareCondition, splitPosition, redeemPositions etc. from CRE.
 */

import type { EvmContext } from "./evm";
import { CTF_ABI } from "./abis";
import { callContract, decodeCallResult, buildCallData } from "./evm";

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

export function getCollectionId(
  ctx: EvmContext,
  conditionId: `0x${string}`,
  outcomeIndex: number
): `0x${string}` {
  const indexSet = 1 << outcomeIndex;
  const data = buildCallData(CTF_ABI, "getCollectionId", [
    ZERO_BYTES32 as `0x${string}`,
    conditionId,
    BigInt(indexSet),
  ]);
  const reply = callContract(
    ctx.runtime,
    ctx.config.chainSelectorName,
    ctx.config.contracts.conditionalTokens as `0x${string}`,
    data
  );
  const raw = decodeCallResult<[`0x${string}`]>(CTF_ABI, "getCollectionId", reply.data);
  return raw[0];
}

export function getPositionId(ctx: EvmContext, collectionId: `0x${string}`): bigint {
  const data = buildCallData(CTF_ABI, "getPositionId", [
    ctx.config.contracts.usdc as `0x${string}`,
    collectionId,
  ]);
  const reply = callContract(
    ctx.runtime,
    ctx.config.chainSelectorName,
    ctx.config.contracts.conditionalTokens as `0x${string}`,
    data
  );
  const raw = decodeCallResult<[bigint]>(CTF_ABI, "getPositionId", reply.data);
  return raw[0];
}

export function getOutcomeSlotCount(ctx: EvmContext, conditionId: `0x${string}`): number {
  const data = buildCallData(CTF_ABI, "getOutcomeSlotCount", [conditionId]);
  const reply = callContract(
    ctx.runtime,
    ctx.config.chainSelectorName,
    ctx.config.contracts.conditionalTokens as `0x${string}`,
    data
  );
  const raw = decodeCallResult<[bigint]>(CTF_ABI, "getOutcomeSlotCount", reply.data);
  return Number(raw[0]);
}

export function balanceOf(ctx: EvmContext, account: `0x${string}`, positionId: bigint): bigint {
  const data = buildCallData(CTF_ABI, "balanceOf", [account, positionId]);
  const reply = callContract(
    ctx.runtime,
    ctx.config.chainSelectorName,
    ctx.config.contracts.conditionalTokens as `0x${string}`,
    data
  );
  const raw = decodeCallResult<[bigint]>(CTF_ABI, "balanceOf", reply.data);
  return raw[0];
}

export function getVaultBalanceForOutcome(
  ctx: EvmContext,
  conditionId: `0x${string}`,
  outcomeIndex: number
): bigint {
  const collectionId = getCollectionId(ctx, conditionId, outcomeIndex);
  const positionId = getPositionId(ctx, collectionId);
  return balanceOf(ctx, ctx.config.contracts.predictionVault as `0x${string}`, positionId);
}
