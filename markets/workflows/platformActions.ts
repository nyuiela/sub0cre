/**
 * Platform workflow: CRE actions for Sub0 and PredictionVault.
 * Trigger: Cron or HTTP. Uses env private key (CRE_ETH_PRIVATE_KEY) for writes.
 * - createMarket: Sub0 CRE 0x00. createMarket, resolveMarket, stake, redeem: Sub0 receiver.
 * - seed, executeTrade: PredictionVault receiver.
 */

import type { Runtime } from "@chainlink/cre-sdk";
import type { WorkflowConfig } from "../types/config";
import type { OracleType, InvitationType } from "../types/market";
import {
  submitCreateMarket,
  submitResolveMarket,
  submitStake,
  submitRedeem,
  computeQuestionId,
  getMarket,
  isMarketEmpty,
} from "../lib/sub0";
import { submitSeedMarketLiquidity } from "../lib/predictionVault";

export interface CreateMarketPayload {
  question: string;
  oracle: string;
  duration: string | number;
  outcomeSlotCount: number;
  oracleType: OracleType; // 1=PLATFORM, 2=ARBITRATOR, 3=CUSTOM
  marketType: InvitationType; // 0=Single, 1=Group, 2=Public
  /** Creator address (msg.sender for create); required to compute questionId and return getMarket. */
  creatorAddress: string;
  /** If set, seed workflow runs after create. */
  amountUsdc?: string;
}

export interface SeedLiquidityPayload {
  questionId: string;
  amountUsdc: string;
}

export interface GetMarketPayload {
  questionId: string;
}

export interface ResolveMarketPayload {
  questionId: string;
  payouts: string[];
  oracle: string;
}

export interface StakePayload {
  questionId: string;
  parentCollectionId: string;
  partition: string[] | number[];
  token: string;
  amount: string;
  owner: string;
}

export interface RedeemPayload {
  parentCollectionId: string;
  conditionId: string;
  indexSets: string[] | number[];
  token: string;
  owner: string;
  deadline: string;
  nonce: string;
  signature: string;
}

function parseCreateMarketPayload(input: Uint8Array): CreateMarketPayload {
  const text = new TextDecoder().decode(input);
  const raw = JSON.parse(text) as Record<string, unknown>;
  return {
    question: String(raw.question ?? ""),
    oracle: String(raw.oracle ?? ""),
    duration: Number(raw.duration ?? 0),
    outcomeSlotCount: Number(raw.outcomeSlotCount ?? 2),
    oracleType: Number(raw.oracleType ?? 1) as OracleType,
    marketType: Number(raw.marketType ?? 0) as InvitationType,
    amountUsdc: raw.amountUsdc != null ? String(raw.amountUsdc) : undefined,
    creatorAddress: String(raw.creatorAddress ?? ""),
  };
}

function parseSeedPayload(input: Uint8Array): SeedLiquidityPayload {
  const text = new TextDecoder().decode(input);
  const raw = JSON.parse(text) as Record<string, unknown>;
  return {
    questionId: String(raw.questionId ?? ""),
    amountUsdc: String(raw.amountUsdc ?? "0"),
  };
}

function parseGetMarketPayload(input: Uint8Array): GetMarketPayload {
  const text = new TextDecoder().decode(input);
  const raw = JSON.parse(text) as Record<string, unknown>;
  return {
    questionId: String(raw.questionId ?? ""),
  };
}

function parseResolveMarketPayload(input: Uint8Array): ResolveMarketPayload {
  const text = new TextDecoder().decode(input);
  const raw = JSON.parse(text) as Record<string, unknown>;
  const payouts = raw.payouts as unknown;
  return {
    questionId: String(raw.questionId ?? ""),
    payouts: Array.isArray(payouts) ? payouts.map((p) => String(p ?? "0")) : [],
    oracle: String(raw.oracle ?? ""),
  };
}

function parseStakePayload(input: Uint8Array): StakePayload {
  const text = new TextDecoder().decode(input);
  const raw = JSON.parse(text) as Record<string, unknown>;
  const partition = raw.partition as unknown;
  return {
    questionId: String(raw.questionId ?? ""),
    parentCollectionId: String(raw.parentCollectionId ?? "0x0000000000000000000000000000000000000000000000000000000000000000"),
    partition: Array.isArray(partition) ? partition : [],
    token: String(raw.token ?? ""),
    amount: String(raw.amount ?? "0"),
    owner: String(raw.owner ?? ""),
  };
}

function parseRedeemPayload(input: Uint8Array): RedeemPayload {
  const text = new TextDecoder().decode(input);
  const raw = JSON.parse(text) as Record<string, unknown>;
  const indexSets = raw.indexSets as unknown;
  return {
    parentCollectionId: String(raw.parentCollectionId ?? ""),
    conditionId: String(raw.conditionId ?? ""),
    indexSets: Array.isArray(indexSets) ? indexSets : [],
    token: String(raw.token ?? ""),
    owner: String(raw.owner ?? ""),
    deadline: String(raw.deadline ?? "0"),
    nonce: String(raw.nonce ?? "0"),
    signature: String(raw.signature ?? ""),
  };
}

function toHex32(value: string): `0x${string}` {
  const s = value.trim().toLowerCase();
  if (s.startsWith("0x")) return s as `0x${string}`;
  return `0x${s}` as `0x${string}`;
}

function toAddress(value: string): `0x${string}` {
  const s = value.trim();
  if (s.startsWith("0x")) return s as `0x${string}`;
  return `0x${s}` as `0x${string}`;
}

/**
 * HTTP handler: create market onchain via Sub0.create(Market). Platform only; requires config.contracts and env key with GAME_CREATOR_ROLE for Public markets.
 * Response: when getMarket reads at last finalized block it will not see the just-submitted tx, so we fall back to payload-derived fields (question, oracle, owner, duration, etc.). Use sim-create-broadcast or --broadcast to send txs to the deployed contract.
 * Logging follows CRE bootcamp style for debugging (steps 1-6 in sub0.submitCreateMarket).
 */
export async function handleCreateMarket(runtime: Runtime<WorkflowConfig>, payload: { input: Uint8Array }): Promise<Record<string, string>> {
  runtime.log("CRE Workflow: HTTP Trigger - Create Market (Sub0)");

  const config = runtime.config;
  const contracts = config.contracts;
  if (!contracts) {
    runtime.log("Create market requires config.contracts.");
    throw new Error("Missing config.contracts for platform actions");
  }

  const body = parseCreateMarketPayload(payload.input);
  runtime.log(`[Request] question: "${body.question?.slice(0, 50)}${(body.question?.length ?? 0) > 50 ? "..." : ""}", oracle: ${body.oracle}, creator: ${body.creatorAddress}`);
  if (!body.question?.trim()) throw new Error("question is required");
  if (body.outcomeSlotCount < 2 || body.outcomeSlotCount > 255) throw new Error("outcomeSlotCount must be 2-255");
  const duration = Number(body.duration);
  if (duration <= 0) throw new Error("duration must be positive");
  const oracle = body.oracle.startsWith("0x") ? (body.oracle as `0x${string}`) : (`0x${body.oracle}` as `0x${string}`);
  if (oracle.length !== 42) throw new Error("oracle must be a valid 20-byte address");

  const creatorAddress = body.creatorAddress?.trim();
  if (!creatorAddress) throw new Error("creatorAddress is required (address that signs create tx, e.g. CRE platform key)");
  const creator = creatorAddress.startsWith("0x")
    ? (creatorAddress as `0x${string}`)
    : (`0x${creatorAddress}` as `0x${string}`);
  if (creator.length !== 42) throw new Error("creatorAddress must be a valid 20-byte address");

  const questionId = computeQuestionId(body.question.trim(), creator, oracle);

  const createMarketTxHash = submitCreateMarket(runtime, contracts, {
    question: body.question.trim(),
    oracle,
    owner: creator,
    duration,
    outcomeSlotCount: body.outcomeSlotCount,
    oracleType: body.oracleType,
    marketType: body.marketType,
  });
  if (createMarketTxHash) {
    runtime.log(`Create market submitted. Transaction: ${createMarketTxHash}`);
  } else {
    runtime.log("Create market submitted (no tx hash; use --broadcast for real onchain write).");
  }

  let seedTxHash = "";
  // const amountUsdc = body.amountUsdc != null ? BigInt(body.amountUsdc) : 0n;
  // if (amountUsdc > 0n) {
  //   try {
  //     seedTxHash = submitSeedMarketLiquidity(runtime, contracts, questionId, amountUsdc);
  //   } catch (err) {
  //     runtime.log(
  //       `Seed market liquidity failed: ${err instanceof Error ? err.message : String(err)}`
  //     );
  //   }
  //   if (seedTxHash) {
  //     runtime.log(`Seed market liquidity submitted for new market. Transaction: ${seedTxHash}`);
  //   } else {
  //     runtime.log("Seed market liquidity submitted (no tx hash; use --broadcast for real onchain write).");
  //   }
  // }

  const ctx = { runtime, config: contracts };
  let market: Awaited<ReturnType<typeof getMarket>> | undefined;
  try {
    market = await getMarket(ctx, questionId);
  } catch {
    market = undefined;
  }

  const fromChain =
    market != null &&
    (market.question?.length > 0 ||
      (market.conditionId != null && market.conditionId !== "0x0000000000000000000000000000000000000000000000000000000000000000"));

  const out: Record<string, string> = {
    status: "ok",
    result: "createMarket",
    txHash: createMarketTxHash ?? "",
    questionId,
    question: fromChain ? (market?.question ?? "") : body.question.trim(),
    conditionId: market?.conditionId ?? "0x0000000000000000000000000000000000000000000000000000000000000000",
    oracle: fromChain ? (market?.oracle ?? "") : oracle,
    owner: fromChain ? (market?.owner ?? "") : creator,
    createdAt: market?.createdAt != null ? String(market.createdAt) : "0",
    duration: fromChain && market?.duration != null ? String(market.duration) : String(duration),
    outcomeSlotCount: String(market?.outcomeSlotCount ?? body.outcomeSlotCount),
    oracleType: String(market?.oracleType ?? body.oracleType),
    marketType: String(market?.marketType ?? body.marketType),
  };
  if (createMarketTxHash) out.createMarketTxHash = createMarketTxHash;
  if (seedTxHash) out.seedTxHash = seedTxHash;
  return out;
}

/**
 * HTTP handler: get market by questionId. Read-only; uses config.contracts.sub0 and last finalized block.
 */
export async function handleGetMarket(
  runtime: Runtime<WorkflowConfig>,
  payload: { input: Uint8Array }
): Promise<Record<string, string>> {
  runtime.log("CRE Workflow: HTTP Trigger - Get Market");

  const config = runtime.config;
  const contracts = config.contracts;
  if (!contracts) {
    runtime.log("Get market requires config.contracts.");
    throw new Error("Missing config.contracts for platform actions");
  }

  const body = parseGetMarketPayload(payload.input);
  const questionIdRaw = body.questionId?.trim();
  if (!questionIdRaw) {
    throw new Error("questionId is required");
  }
  const questionId = questionIdRaw.startsWith("0x")
    ? (questionIdRaw as `0x${string}`)
    : (`0x${questionIdRaw}` as `0x${string}`);
  if (questionId.length !== 66) {
    throw new Error("questionId must be a 32-byte hex string (0x + 64 hex chars)");
  }

  const ctx = { runtime, config: contracts };
  const market = await getMarket(ctx, questionId, { useLatestBlock: true });

  return {
    status: "ok",
    result: "getMarket",
    questionId,
    question: market.question ?? "",
    conditionId: market.conditionId ?? "0x0000000000000000000000000000000000000000000000000000000000000000",
    oracle: market.oracle ?? "0x0000000000000000000000000000000000000000",
    owner: market.owner ?? "0x0000000000000000000000000000000000000000",
    createdAt: market.createdAt != null ? String(market.createdAt) : "0",
    duration: market.duration != null ? String(market.duration) : "0",
    outcomeSlotCount: String(market.outcomeSlotCount ?? 0),
    oracleType: String(market.oracleType ?? 0),
    marketType: String(market.marketType ?? 0),
  };
}

/**
 * HTTP handler: seed market liquidity. Platform only; requires config.contracts and owner key.
 * Returns transaction hash when available.
 */
export function handleSeedLiquidity(runtime: Runtime<WorkflowConfig>, payload: { input: Uint8Array }): Record<string, string> {
  const config = runtime.config;
  const contracts = config.contracts;
  if (!contracts) {
    runtime.log("Seed liquidity requires config.contracts.");
    throw new Error("Missing config.contracts for platform actions");
  }

  const body = parseSeedPayload(payload.input);
  const questionId = body.questionId.startsWith("0x")
    ? (body.questionId as `0x${string}`)
    : (`0x${body.questionId}` as `0x${string}`);
  const amountUsdc = BigInt(body.amountUsdc);
  if (amountUsdc <= 0n) {
    throw new Error("amountUsdc must be positive");
  }

  const txHash = submitSeedMarketLiquidity(runtime, contracts, questionId, amountUsdc);
  runtime.log("Seed market liquidity submitted.");
  return { status: "ok", txHash: txHash ?? "" };
}

/**
 * HTTP handler: resolve market via Sub0 CRE (0x01). Oracle must match market.
 * Payload: questionId, payouts (string[]), oracle.
 */
export function handleResolveMarket(runtime: Runtime<WorkflowConfig>, payload: { input: Uint8Array }): Record<string, string> {
  const config = runtime.config;
  const contracts = config.contracts;
  if (!contracts) throw new Error("Missing config.contracts for platform actions");

  const body = parseResolveMarketPayload(payload.input);
  const questionId = toHex32(body.questionId);
  if (questionId.length !== 66) throw new Error("questionId must be 32-byte hex (0x + 64 chars)");
  const payouts = body.payouts.map((p) => BigInt(p));
  if (payouts.length === 0) throw new Error("payouts array is required");
  const oracle = toAddress(body.oracle);
  if (oracle.length !== 42) throw new Error("oracle must be a valid 20-byte address");

  const txHash = submitResolveMarket(runtime, contracts, { questionId, payouts, oracle });
  runtime.log("Resolve market submitted.");
  return { status: "ok", result: "resolveMarket", txHash: txHash ?? "" };
}

/**
 * HTTP handler: stake via Sub0 CRE (0x02). Forwarder stakes on behalf of owner.
 * Payload: questionId, parentCollectionId, partition (number[]), token, amount, owner.
 */
export function handleStake(runtime: Runtime<WorkflowConfig>, payload: { input: Uint8Array }): Record<string, string> {
  const config = runtime.config;
  const contracts = config.contracts;
  if (!contracts) throw new Error("Missing config.contracts for platform actions");

  const body = parseStakePayload(payload.input);
  const questionId = toHex32(body.questionId);
  if (questionId.length !== 66) throw new Error("questionId must be 32-byte hex");
  const parentCollectionId = toHex32(body.parentCollectionId);
  const partition = body.partition.map((p) => BigInt(p));
  const token = toAddress(body.token);
  const amount = BigInt(body.amount);
  if (amount <= 0n) throw new Error("amount must be positive");
  const owner = toAddress(body.owner);
  if (owner.length !== 42) throw new Error("owner must be a valid 20-byte address");

  const txHash = submitStake(runtime, contracts, {
    questionId,
    parentCollectionId,
    partition,
    token,
    amount,
    owner,
  });
  runtime.log("Stake submitted.");
  return { status: "ok", result: "stake", txHash: txHash ?? "" };
}

/**
 * HTTP handler: redeem via Sub0 CRE (0x03). Owner must supply EIP-712 signature (getRedeemDigest + redeemNonce from contract).
 * Payload: parentCollectionId, conditionId, indexSets, token, owner, deadline, nonce, signature.
 */
export function handleRedeem(runtime: Runtime<WorkflowConfig>, payload: { input: Uint8Array }): Record<string, string> {
  const config = runtime.config;
  const contracts = config.contracts;
  if (!contracts) throw new Error("Missing config.contracts for platform actions");

  const body = parseRedeemPayload(payload.input);
  const parentCollectionId = toHex32(body.parentCollectionId);
  const conditionId = toHex32(body.conditionId);
  const indexSets = body.indexSets.map((i) => BigInt(i));
  const token = toAddress(body.token);
  const owner = toAddress(body.owner);
  if (owner.length !== 42) throw new Error("owner must be a valid 20-byte address");
  const deadline = BigInt(body.deadline);
  const nonce = BigInt(body.nonce);
  const signature = body.signature.startsWith("0x") ? (body.signature as `0x${string}`) : (`0x${body.signature}` as `0x${string}`);
  if (!signature || signature.length < 10) throw new Error("signature is required (EIP-712 Redeem from owner)");

  const txHash = submitRedeem(runtime, contracts, {
    parentCollectionId,
    conditionId,
    indexSets,
    token,
    owner,
    deadline,
    nonce,
    signature,
  });
  runtime.log("Redeem submitted.");
  return { status: "ok", result: "redeem", txHash: txHash ?? "" };
}

/**
 * Cron handler: runs settlement for due markets (fetch due from backend, run deliberation + writeReport + resolved per market).
 * Also use HTTP for one-off actions: createMarket, seed, runSettlement, createMarketsFromBackend.
 */
export async function handlePlatformCron(runtime: Runtime<WorkflowConfig>): Promise<string> {
  const { handleSettlementCron } = await import("./settlementCron");
  return handleSettlementCron(runtime);
}
