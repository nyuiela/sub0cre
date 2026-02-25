/**
 * Agent workflow: sign LMSR quote for PredictionVault.executeTrade.
 * Trigger: HTTP. Backend/AI sends quote params; CRE returns signed quote (EIP-712).
 * Uses backend signer private key from secrets (encrypted/injected).
 */

import type { Runtime } from "@chainlink/cre-sdk";
import type { WorkflowConfig } from "../types/config";
import type { LMSRQuoteParams } from "../types/quote";
import { signLMSRQuote, getNonceUsed } from "../lib/predictionVault";
import { getMarket, ensureQuestionIdBytes32 } from "../lib/sub0";
import { getVaultBalanceForOutcome } from "../lib/ctf";

const SECRET_ID = "BACKEND_SIGNER_PRIVATE_KEY";

export interface QuoteRequestPayload {
  questionId: string;
  conditionId: string;
  outcomeIndex: number;
  buy: boolean;
  quantity: string;
  tradeCostUsdc: string;
  nonce: string;
  deadline: string;
}

function parsePayload(input: Uint8Array): QuoteRequestPayload {
  const text = new TextDecoder().decode(input);
  const raw = JSON.parse(text) as Record<string, unknown>;
  return {
    questionId: String(raw.questionId ?? ""),
    conditionId: raw.conditionId as `0x${string}`,
    outcomeIndex: Number(raw.outcomeIndex ?? 0),
    buy: Boolean(raw.buy),
    quantity: String(raw.quantity ?? "0"),
    tradeCostUsdc: String(raw.tradeCostUsdc ?? "0"),
    nonce: String(raw.nonce ?? "0"),
    deadline: String(raw.deadline ?? "0"),
  };
}

export async function handleQuoteSigning(runtime: Runtime<WorkflowConfig>, payload: { input: Uint8Array })
// : Promise<unknown>
{
  const config = runtime.config;
  const contracts = config.contracts;
  if (!contracts) {
    runtime.log("Quote signing requires config.contracts (chainId, contracts, eip712).");
    throw new Error("Missing config.contracts for quote signing");
  }
  runtime.log(`collectionId: ${payload.input}`);
  const body = parsePayload(payload.input);
  runtime.log(`body: ${JSON.stringify(body)}`);
  if (!body.questionId?.trim()) {
    throw new Error("questionId is required (32-byte hex)");
  }
  const questionId = ensureQuestionIdBytes32(body.questionId);

  const ctx = { runtime, config: contracts };

  const market = await getMarket(ctx, questionId, { useLatestBlock: true });
  if (market.outcomeSlotCount === 0) {
    throw new Error("Market not found or invalid");
  }
  if (body.outcomeIndex >= market.outcomeSlotCount) {
    throw new Error("Outcome index out of range");
  }

  const nonce = BigInt(body.nonce);
  if (getNonceUsed(runtime, contracts, questionId, nonce)) {
    throw new Error("Nonce already used");
  }

  if (body.buy) {
    const balance = getVaultBalanceForOutcome(ctx, body.conditionId as `0x${string}`, body.outcomeIndex);
    if (balance < BigInt(body.quantity)) {
      throw new Error("Insufficient vault balance for this outcome");
    }
  }

  const secret = runtime.getSecret({ id: SECRET_ID }).result();
  const privateKey = secret.value ?? "";
  if (!privateKey) {
    throw new Error("Backend signer secret not configured");
  }

  const params: LMSRQuoteParams = {
    questionId,
    outcomeIndex: body.outcomeIndex,
    buy: body.buy,
    quantity: BigInt(body.quantity),
    tradeCostUsdc: BigInt(body.tradeCostUsdc),
    nonce,
    deadline: BigInt(body.deadline),
  };

  const signed = signLMSRQuote(params, contracts, privateKey);
  runtime.log("Quote signed successfully.");
  return signed;
}
