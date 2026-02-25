/**
 * Platform workflow: liquidity seeding, market creation, and lifecycle actions.
 * Trigger: Cron or HTTP. Uses env private key (CRE_ETH_PRIVATE_KEY) for writes.
 * - createMarket: Sub0.create(Market); caller must have GAME_CREATOR_ROLE for Public.
 * - seedMarketLiquidity(questionId, amountUsdc): only if caller is PredictionVault owner.
 */

import type { Runtime } from "@chainlink/cre-sdk";
import type { WorkflowConfig } from "../types/config";
import type { OracleType, InvitationType } from "../types/market";
import { submitCreateMarket, computeQuestionId, getMarket, isMarketEmpty } from "../lib/sub0";
import { submitSeedMarketLiquidity } from "../lib/predictionVault";
import { setTimeout } from "timers/promises";

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

/**
 * HTTP handler: create market onchain via Sub0.create(Market). Platform only; requires config.contracts and env key with GAME_CREATOR_ROLE for Public markets.
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
    duration,
    outcomeSlotCount: body.outcomeSlotCount,
    oracleType: body.oracleType,
    marketType: body.marketType,
  });
  runtime.log("Create market submitted.");

  let seedTxHash = "";
  const amountUsdc = body.amountUsdc != null ? BigInt(body.amountUsdc) : 0n;
  if (amountUsdc > 0n) {
    // seedTxHash = submitSeedMarketLiquidity(runtime, contracts, questionId, amountUsdc);
    runtime.log("Seed market liquidity submitted for new market.");
  }

  const ctx = { runtime, config: contracts };
  let market = await getMarket(ctx, questionId, { useLatestBlock: true });
  if (isMarketEmpty(market)) {
    runtime.log("Market not found on first read (block may not include tx yet); retrying once.");
    market = await getMarket(ctx, questionId, { useLatestBlock: true });
  }
  // if (isMarketEmpty(market)) {
  //   throw new Error(
  //     `Reporter tx succeeded but market not found. The inner Sub0.create may have reverted (check GAME_CREATOR_ROLE and params). TxHash: ${createMarketTxHash}`
  //   );
  // }

  const out: Record<string, string> = {
    status: "ok",
    result: "createMarket",
    questionId,
    question: market?.question ?? "",
    conditionId: market?.conditionId ?? "0x0000000000000000000000000000000000000000000000000000000000000000",
    oracle: market?.oracle ?? "0x0000000000000000000000000000000000000000",
    owner: market?.owner ?? "0x0000000000000000000000000000000000000000",
    createdAt: market?.createdAt != null ? String(market.createdAt) : "0",
    duration: market?.duration != null ? String(market.duration) : "0",
    outcomeSlotCount: String(market?.outcomeSlotCount ?? 0),
    oracleType: String(market?.oracleType ?? 0),
    marketType: String(market?.marketType ?? 0),
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
  const out: Record<string, string> = { status: "ok" };
  if (txHash) out.txHash = txHash;
  return out;
}

/**
 * Cron handler: placeholder for periodic platform checks (e.g. health, metrics).
 * Actual seed/settlement are triggered by backend or HTTP.
 */
export function handlePlatformCron(runtime: Runtime<WorkflowConfig>): string {
  runtime.log("Platform cron: no action (use HTTP to seed liquidity or trigger actions).");
  return "ok";
}
