/**
 * LMSR pricing handler: fetch on-chain q, compute cost, sign with DON key.
 * Used by main (action lmsrPricing) and by standalone lmsrPricing workflow.
 */

import type { Runtime } from "@chainlink/cre-sdk";
import Decimal from "decimal.js";
import type { ChainContractConfig } from "../types/contracts";
import type { LmsrPricingRequestPayload, LmsrPricingResponse } from "../types/lmsr";
import { getMarket, ensureQuestionIdBytes32 } from "../lib/sub0";
import { getVaultBalanceForOutcome } from "../lib/ctf";
import { signLMSRQuote, getNonceUsed } from "../lib/predictionVault";
import { costToBuy, costToUsdcUnits } from "../lib/lmsrMath";

declare function randomSeed(mode: 1 | 2): number;

const DEFAULT_DEADLINE_SECONDS = 900;
const DON_SIGNER_ID = "BACKEND_SIGNER_PRIVATE_KEY";

export function parseLmsrPayload(input: Uint8Array): LmsrPricingRequestPayload {
  const text = new TextDecoder().decode(input);
  const raw = JSON.parse(text) as Record<string, unknown>;
  return {
    marketId: String(raw.marketId ?? ""),
    outcomeIndex: Number(raw.outcomeIndex ?? 0),
    quantity: String(raw.quantity ?? "0"),
    bParameter: String(raw.bParameter ?? raw.b ?? "1"),
  };
}


/**
 * Deterministic nonce for DON consensus: uses CRE host randomSeed(mode 2).
 * Must not use Date.now(), Math.random(), or crypto.getRandomValues in workflow logic.
 */
function randomNonce(): bigint {
  const buf = new Uint8Array(32);
  if (typeof randomSeed === "function") {
    for (let i = 0; i < 8; i++) {
      const n = randomSeed(2) >>> 0;
      buf[i * 4] = n & 0xff;
      buf[i * 4 + 1] = (n >> 8) & 0xff;
      buf[i * 4 + 2] = (n >> 16) & 0xff;
      buf[i * 4 + 3] = (n >> 24) & 0xff;
    }
  } else {
    for (let i = 0; i < 32; i++) buf[i] = 0;
  }
  let hex = "0x";
  for (let i = 0; i < buf.length; i++) hex += buf[i].toString(16).padStart(2, "0");
  return BigInt(hex);
}

export interface LmsrPricingHandlerConfig {
  contracts?: ChainContractConfig;
  deadlineSeconds?: number;
}

export async function handleLmsrPricing(
  runtime: Runtime<LmsrPricingHandlerConfig>,
  payload: { input: Uint8Array }
)
// : Promise<LmsrPricingResponse> 
{
  const config = runtime.config?.contracts;
  if (!config) {
    runtime.log("lmsrPricing requires config.contracts");
    throw new Error("Missing config.contracts");
  }

  const body = parseLmsrPayload(payload.input);
  if (!body.marketId) throw new Error("Missing body.marketId");
  if (!body.quantity || body.quantity === "0") throw new Error("Missing or zero body.quantity");

  const questionId = ensureQuestionIdBytes32(body.marketId);
  const ctx = { runtime, config };

  const market = await getMarket(ctx, questionId, { useLatestBlock: true });
  if (market.outcomeSlotCount === 0) {
    throw new Error("Market not found or invalid");
  }
  if (body.outcomeIndex < 0 || body.outcomeIndex >= market.outcomeSlotCount) {
    throw new Error("Outcome index out of range");
  }

  const bParam = new Decimal(body.bParameter);
  if (bParam.lte(0)) {
    throw new Error("bParameter must be positive");
  }

  const qRaw: bigint[] = [];
  for (let i = 0; i < market.outcomeSlotCount; i++) {
    runtime.log(`market.conditionId: ${market.conditionId}`);
    const balance = getVaultBalanceForOutcome(ctx, market.conditionId, i);
    runtime.log(`balance: ${balance}`);
    qRaw.push(balance);
  }

  const q = qRaw.map((qi) => new Decimal(qi.toString()));
  const quantityDec = new Decimal(body.quantity);
  const costOutcomeWei = costToBuy(q, body.outcomeIndex, quantityDec, bParam);

  const outcomeDecimals = config.conventions?.outcomeTokenDecimals ?? 18;
  const usdcDecimals = config.conventions?.usdcDecimals ?? 6;
  const tradeCostUsdcBigInt = costToUsdcUnits(costOutcomeWei, outcomeDecimals, usdcDecimals);

  let nonce = randomNonce();
  const maxAttempts = 10;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!getNonceUsed(runtime, config, questionId, nonce)) break;
    nonce = randomNonce();
  }
  if (getNonceUsed(runtime, config, questionId, nonce)) {
    throw new Error("Could not generate unused nonce");
  }

  const deadlineSeconds = runtime.config?.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS;
  const deadline = BigInt(Math.floor(runtime.now().getTime() / 1000) + deadlineSeconds);

  const secret = runtime.getSecret({ id: DON_SIGNER_ID }).result();
  const privateKey = secret.value ?? "";
  if (!privateKey) {
    throw new Error("DON signer secret not configured (BACKEND_SIGNER_PRIVATE_KEY)");
  }

  const signed = signLMSRQuote(
    {
      questionId,
      outcomeIndex: body.outcomeIndex,
      buy: true,
      quantity: BigInt(body.quantity),
      tradeCostUsdc: tradeCostUsdcBigInt,
      nonce,
      deadline,
    },
    config,
    privateKey
  );

  runtime.log("LMSR quote signed successfully.");
  return {
    tradeCostUsdc: signed.tradeCostUsdc,
    donSignature: signed.signature,
    deadline: signed.deadline,
    nonce: signed.nonce,
  };
}
