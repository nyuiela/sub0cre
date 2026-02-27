/**
 * Quote/buy/sell: sign LMSR quote for PredictionVault.executeTrade.
 * Supports single trade (userSignature) or batch (trades[]). When user sig(s) provided, CRE adds DON
 * signature and submits via writeReport (one report per trade). Otherwise returns DON-signed quote only.
 */

import type { Runtime } from "@chainlink/cre-sdk";
import type { Hex } from "viem";
import { recoverTypedDataAddress } from "viem";
import type { WorkflowConfig } from "../types/config";
import type { LMSRQuoteParams, BatchTradeItem } from "../types/quote";
import { signLMSRQuote, getNonceUsed, submitExecuteTrade } from "../lib/predictionVault";
import { getMarket, ensureQuestionIdBytes32 } from "../lib/sub0";
import { getVaultBalanceForOutcome } from "../lib/ctf";

const SECRET_ID = "BACKEND_SIGNER_PRIVATE_KEY";

const LMSR_QUOTE_TYPES = {
  LMSRQuote: [
    { name: "questionId", type: "bytes32" },
    { name: "outcomeIndex", type: "uint256" },
    { name: "buy", type: "bool" },
    { name: "quantity", type: "uint256" },
    { name: "tradeCostUsdc", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

export interface QuoteRequestPayload {
  questionId: string;
  conditionId: string;
  outcomeIndex: number;
  buy: boolean;
  quantity: string;
  tradeCostUsdc: string;
  nonce: string;
  deadline: string;
  /** When set, CRE recovers user address, adds DON signature, and submits executeTrade via writeReport. Returns txHash. */
  userSignature?: string;
  /** Order book batch: multiple signatures, users, quantities. One writeReport per item. Shared: questionId, conditionId, outcomeIndex, buy. */
  trades?: BatchTradeItem[];
}

function normalizeSignature(sig: unknown): string | undefined {
  if (typeof sig !== "string" || sig.trim().length === 0) return undefined;
  const s = sig.trim();
  return s.startsWith("0x") ? s : `0x${s}`;
}

function parseTradeItem(raw: unknown): BatchTradeItem | null {
  if (raw == null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const userSignature = normalizeSignature(o.userSignature);
  if (!userSignature) return null;
  return {
    userSignature,
    quantity: String(o.quantity ?? "0"),
    tradeCostUsdc: String(o.tradeCostUsdc ?? "0"),
    nonce: String(o.nonce ?? "0"),
    deadline: String(o.deadline ?? "0"),
  };
}

function parsePayload(input: Uint8Array): QuoteRequestPayload {
  const text = new TextDecoder().decode(input);
  const raw = JSON.parse(text) as Record<string, unknown>;
  const tradesRaw = raw.trades;
  const trades: BatchTradeItem[] = [];
  if (Array.isArray(tradesRaw)) {
    for (const item of tradesRaw) {
      const t = parseTradeItem(item);
      if (t) trades.push(t);
    }
  }
  const userSig = raw.userSignature;
  return {
    questionId: String(raw.questionId ?? ""),
    conditionId: (raw.conditionId != null ? String(raw.conditionId) : "") as `0x${string}`,
    outcomeIndex: Number(raw.outcomeIndex ?? 0),
    buy: Boolean(raw.buy),
    quantity: String(raw.quantity ?? "0"),
    tradeCostUsdc: String(raw.tradeCostUsdc ?? "0"),
    nonce: String(raw.nonce ?? "0"),
    deadline: String(raw.deadline ?? "0"),
    userSignature: normalizeSignature(userSig) ?? undefined,
    trades: trades.length > 0 ? trades : undefined,
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

  const secret = runtime.getSecret({ id: SECRET_ID }).result();
  const privateKey = secret.value ?? "";
  if (!privateKey) {
    throw new Error("Backend signer secret not configured");
  }

  if (body.trades != null && body.trades.length > 0) {
    const txHashes: string[] = [];
    const errors: string[] = [];
    const domain = {
      name: contracts.eip712.domainName,
      version: contracts.eip712.domainVersion,
      chainId: contracts.chainId,
      verifyingContract: contracts.contracts.predictionVault as Hex,
    };
    for (let i = 0; i < body.trades.length; i++) {
      const item = body.trades[i]!;
      try {
        const nonce = BigInt(item.nonce);
        if (getNonceUsed(runtime, contracts, questionId, nonce)) {
          errors.push(`trade[${i}]: nonce already used`);
          continue;
        }
        if (body.buy) {
          const balance = getVaultBalanceForOutcome(ctx, body.conditionId as `0x${string}`, body.outcomeIndex);
          if (balance < BigInt(item.quantity)) {
            errors.push(`trade[${i}]: insufficient vault balance`);
            continue;
          }
        }
        const params: LMSRQuoteParams = {
          questionId,
          outcomeIndex: body.outcomeIndex,
          buy: body.buy,
          quantity: BigInt(item.quantity),
          tradeCostUsdc: BigInt(item.tradeCostUsdc),
          nonce,
          deadline: BigInt(item.deadline),
        };
        const signed = signLMSRQuote(params, contracts, privateKey);
        const donSignature = signed.signature as Hex;
        const message = {
          questionId,
          outcomeIndex: BigInt(body.outcomeIndex),
          buy: body.buy,
          quantity: params.quantity,
          tradeCostUsdc: params.tradeCostUsdc,
          nonce,
          deadline: params.deadline,
        };
        const user = await recoverTypedDataAddress({
          domain,
          types: LMSR_QUOTE_TYPES,
          primaryType: "LMSRQuote",
          message,
          signature: item.userSignature as Hex,
        });
        const quote = {
          questionId,
          outcomeIndex: BigInt(body.outcomeIndex),
          buy: body.buy,
          quantity: BigInt(item.quantity),
          tradeCostUsdc: BigInt(item.tradeCostUsdc),
          nonce,
          deadline: BigInt(item.deadline),
        };
        const txHash = submitExecuteTrade(
          runtime,
          contracts,
          quote,
          BigInt(item.tradeCostUsdc),
          user,
          donSignature,
          item.userSignature as Hex
        );
        txHashes.push(txHash);
      } catch (err) {
        errors.push(`trade[${i}]: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    runtime.log(`Batch execute: ${txHashes.length} submitted, ${errors.length} errors.`);
    return { txHashes, ...(errors.length > 0 ? { errors } : {}) };
  }

  const nonce = BigInt(body.nonce);
  if (getNonceUsed(runtime, contracts, questionId, nonce)) {
    throw new Error("Nonce already used");
  }
  if (body.buy) {
    const balance = getVaultBalanceForOutcome(ctx, body.conditionId as `0x${string}`, body.outcomeIndex);
    // if (balance < BigInt(body.quantity)) {
    //   throw new Error("Insufficient vault balance for this outcome");
    // }
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
  const donSignature = signed.signature as Hex;

  if (body.userSignature) {
    const domain = {
      name: contracts.eip712.domainName,
      version: contracts.eip712.domainVersion,
      chainId: contracts.chainId,
      verifyingContract: contracts.contracts.predictionVault as Hex,
    };
    const message = {
      questionId,
      outcomeIndex: BigInt(body.outcomeIndex),
      buy: body.buy,
      quantity: params.quantity,
      tradeCostUsdc: params.tradeCostUsdc,
      nonce,
      deadline: params.deadline,
    };
    const user = await recoverTypedDataAddress({
      domain,
      types: LMSR_QUOTE_TYPES,
      primaryType: "LMSRQuote",
      message,
      signature: body.userSignature as Hex,
    });
    const quote = {
      questionId,
      outcomeIndex: BigInt(body.outcomeIndex),
      buy: body.buy,
      quantity: BigInt(body.quantity),
      tradeCostUsdc: BigInt(body.tradeCostUsdc),
      nonce,
      deadline: BigInt(body.deadline),
    };
    const maxCostUsdc = BigInt(body.tradeCostUsdc);
    const txHash = submitExecuteTrade(
      runtime,
      contracts,
      quote,
      maxCostUsdc,
      user,
      donSignature,
      body.userSignature as Hex
    );
    runtime.log("Execute trade submitted via writeReport (user + DON signatures).");
    return { txHash };
  }

  runtime.log("Quote signed successfully (DON only; send userSignature to execute via writeReport).");
  return signed;
}
