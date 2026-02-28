/**
 * Quote/buy/sell: sign LMSR quote for PredictionVault.executeTrade.
 * Supports single trade (userSignature) or batch (trades[]). When user sig(s) provided, CRE adds DON
 * signature and submits via writeReport (one report per trade). Otherwise returns DON-signed quote only.
 */

import type { Runtime } from "@chainlink/cre-sdk";
import type { Hex } from "viem";
import { recoverTypedDataAddress, zeroAddress } from "viem";
import type { WorkflowConfig } from "../types/config";
import type { BatchTradeItem } from "../types/quote";
import { signDONQuote, getNonceUsed, submitExecuteTrade } from "../lib/predictionVault";
import { getMarket, ensureQuestionIdBytes32 } from "../lib/sub0";
import { getVaultBalanceForOutcome } from "../lib/ctf";

const SECRET_ID = "BACKEND_SIGNER_PRIVATE_KEY";

/** UserTrade: USER_TRADE_TYPEHASH. User signs (marketId, outcomeIndex, buy, quantity, maxCostUsdc, nonce, deadline). */
const USER_TRADE_TYPES = {
  UserTrade: [
    { name: "marketId", type: "bytes32" },
    { name: "outcomeIndex", type: "uint256" },
    { name: "buy", type: "bool" },
    { name: "quantity", type: "uint256" },
    { name: "maxCostUsdc", type: "uint256" },
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
  /** User-signed max cost; must be >= tradeCostUsdc. Defaults to tradeCostUsdc if omitted. */
  maxCostUsdc?: string;
  nonce: string;
  deadline: string;
  /** When set, CRE recovers user from UserTrade sig, signs DONQuote, and submits executeTrade. Returns txHash. */
  userSignature?: string;
  /** Order book batch: multiple signatures, users, quantities. One writeReport per item. Shared: questionId, conditionId, outcomeIndex, buy. */
  trades?: BatchTradeItem[];
}

function normalizeSignature(sig: unknown): string | undefined {
  if (typeof sig !== "string" || sig.trim().length === 0) return undefined;
  const s = sig.trim();
  return s.startsWith("0x") ? s : `0x${s}`;
}

/** Convert string to integer string for BigInt. Decimals (e.g. "22.6") are expanded by 10^decimals; no decimals = truncate. */
function toIntegerString(s: string, decimals?: number): string {
  const t = String(s ?? "").trim();
  if (!t) return "0";
  if (!t.includes(".")) return t;
  if (decimals === undefined || decimals <= 0) {
    const part = t.split(".")[0];
    return part ?? "0";
  }
  const [whole = "0", frac = ""] = t.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return (BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(padded || "0")).toString();
}

const USDC_DECIMALS = 6;

function parseTradeItem(raw: unknown): BatchTradeItem | null {
  if (raw == null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const userSignature = normalizeSignature(o.userSignature);
  if (!userSignature) return null;
  const tradeCostUsdc = String(o.tradeCostUsdc ?? "0");
  return {
    userSignature,
    quantity: String(o.quantity ?? "0"),
    tradeCostUsdc,
    maxCostUsdc: o.maxCostUsdc != null ? String(o.maxCostUsdc) : undefined,
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
  const tradeCostUsdc = String(raw.tradeCostUsdc ?? "0");
  return {
    questionId: String(raw.questionId ?? ""),
    conditionId: (raw.conditionId != null ? String(raw.conditionId) : "") as `0x${string}`,
    outcomeIndex: Number(raw.outcomeIndex ?? 0),
    buy: Boolean(raw.buy),
    quantity: String(raw.quantity ?? "0"),
    tradeCostUsdc,
    maxCostUsdc: raw.maxCostUsdc != null ? String(raw.maxCostUsdc) : undefined,
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
  // if (market.outcomeSlotCount === 0) {
  //   throw new Error("Market not found or invalid");
  // }
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
          if (balance < BigInt(toIntegerString(item.quantity))) {
            errors.push(`trade[${i}]: insufficient vault balance`);
            continue;
          }
        }
        // const qStr = toIntegerString(item.quantity);
        // const costStr = toIntegerString(item.tradeCostUsdc, USDC_DECIMALS);
        // const maxCostStr = toIntegerString(item.maxCostUsdc ?? item.tradeCostUsdc, USDC_DECIMALS);
        const deadlineBig = BigInt(item.deadline);
        const quantityBig = item.quantity;
        const tradeCostBig = item.tradeCostUsdc;
        const maxCostBig = Number(item.maxCostUsdc);
        runtime.log(`quantityBig: ${quantityBig}`);
        runtime.log(`tradeCostBig: ${tradeCostBig}`);
        runtime.log(`maxCostBig: ${maxCostBig}`);
        const userTradeMessage = {
          marketId: questionId,
          outcomeIndex: BigInt(body.outcomeIndex),
          buy: body.buy,
          quantity: quantityBig,
          maxCostUsdc: maxCostBig,
          nonce,
          deadline: deadlineBig,
        };
        const user = await recoverTypedDataAddress({
          domain,
          types: USER_TRADE_TYPES,
          primaryType: "UserTrade",
          message: userTradeMessage,
          signature: item.userSignature as Hex,
        });
        runtime.log(`user: ${user}`);
        if (user === "0xf0830060f836B8d54bF02049E5905F619487989e") return;
        if (!user || typeof user !== "string" || !user.startsWith("0x")) {
          errors.push(`trade[${i}]: failed to recover user address from UserTrade signature`);
          continue;
        }
        const donSignature = signDONQuote(
          {
            questionId,
            outcomeIndex: body.outcomeIndex,
            buy: body.buy,
            quantity: quantityBig,
            tradeCostUsdc: tradeCostBig,
            user,
            nonce,
            deadline: deadlineBig,
          },
          contracts,
          privateKey
        );
        const quote = {
          questionId,
          outcomeIndex: BigInt(body.outcomeIndex),
          buy: body.buy,
          quantity: quantityBig,
          tradeCostUsdc: tradeCostBig,
          nonce,
          deadline: deadlineBig,
        };
        const txHash = submitExecuteTrade(
          runtime,
          contracts,
          quote,
          maxCostBig,
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
  // if (body.buy) {
  // const balance = getVaultBalanceForOutcome(ctx, body.conditionId as `0x${string}`, body.outcomeIndex);
  // if (balance < BigInt(body.quantity)) {
  //   throw new Error("Insufficient vault balance for this outcome");
  // }
  // }

  const qStr = toIntegerString(body.quantity);
  const costStr = toIntegerString(body.tradeCostUsdc, USDC_DECIMALS);
  const maxCostStr = toIntegerString(body.maxCostUsdc ?? body.tradeCostUsdc, USDC_DECIMALS);
  const quantityBig = BigInt(qStr);
  const tradeCostBig = BigInt(costStr);
  const maxCostBig = BigInt(maxCostStr);
  const deadlineBig = BigInt(body.deadline);
  const domain = {
    name: contracts.eip712.domainName,
    version: contracts.eip712.domainVersion,
    chainId: contracts.chainId,
    verifyingContract: contracts.contracts.predictionVault as Hex,
  };

  if (body.userSignature) {
    const userTradeMessage = {
      marketId: questionId,
      outcomeIndex: BigInt(body.outcomeIndex),
      buy: body.buy,
      quantity: quantityBig,
      maxCostUsdc: maxCostBig,
      nonce,
      deadline: deadlineBig,
    };
    const user = await recoverTypedDataAddress({
      domain,
      types: USER_TRADE_TYPES,
      primaryType: "UserTrade",
      message: userTradeMessage,
      signature: body.userSignature as Hex,
    });
    if (!user || typeof user !== "string" || !user.startsWith("0x")) {
      throw new Error("Failed to recover user address from UserTrade signature");
    }
    runtime.log(`User address: ${user}`);
    const donSignature = signDONQuote(
      {
        questionId,
        outcomeIndex: body.outcomeIndex,
        buy: body.buy,
        quantity: quantityBig,
        tradeCostUsdc: tradeCostBig,
        user,
        nonce,
        deadline: deadlineBig,
      },
      contracts,
      privateKey
    );
    runtime.log(`DON signature: ${donSignature}`);
    const quote = {
      questionId,
      outcomeIndex: BigInt(body.outcomeIndex),
      buy: body.buy,
      quantity: quantityBig,
      tradeCostUsdc: tradeCostBig,
      nonce,
      deadline: deadlineBig,
    };
    const txHash = submitExecuteTrade(
      runtime,
      contracts,
      quote,
      maxCostBig,
      user,
      donSignature,
      body.userSignature as Hex
    );
    runtime.log("Execute trade submitted via writeReport (user + DON signatures).");
    return { txHash };
  }

  runtime.log("Quote signed successfully (DON only; send userSignature to execute via writeReport).");
  const donSignature = signDONQuote(
    {
      questionId,
      outcomeIndex: body.outcomeIndex,
      buy: body.buy,
      quantity: quantityBig,
      tradeCostUsdc: tradeCostBig,
      user: zeroAddress,
      nonce,
      deadline: deadlineBig,
    },
    contracts,
    privateKey
  );
  return {
    questionId,
    outcomeIndex: body.outcomeIndex,
    buy: body.buy,
    quantity: qStr,
    tradeCostUsdc: costStr,
    nonce: body.nonce,
    deadline: body.deadline,
    signature: donSignature,
  };
}
