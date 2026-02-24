/**
 * Execute confidential trade handler: fetch agent key from secrets, sign and submit executeTrade.
 * Used by standalone executeConfidentialTrade workflow. Not registered in main workflow because
 * signTypedData is async (viem/ethers) and CRE WASM engine hits "unreachable" with async handlers.
 */

import type { Runtime } from "@chainlink/cre-sdk";
import { signTypedData } from "viem/accounts";
import { getAddress, publicKeyToAddress, hexToBytes, type Hex } from "viem";
import { secp256k1 } from "@noble/curves/secp256k1";
import type { ChainContractConfig } from "../types/contracts";
import type { ConfidentialTradePayload, ExecuteConfidentialTradeResponse } from "../types/confidential";
import { getNonceUsed, signLMSRQuote, submitExecuteTrade } from "../lib/predictionVault";
import { getMarket } from "../lib/sub0";
import { getVaultBalanceForOutcome } from "../lib/ctf";

const AGENT_KEYS_NAMESPACE = "agent-keys";
const DON_SIGNER_NAMESPACE = "sub0";
const DON_SIGNER_ID = "BACKEND_SIGNER_PRIVATE_KEY";

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

export interface ExecuteConfidentialTradeHandlerConfig {
  contracts?: ChainContractConfig;
  agentKeysNamespace?: string;
}

export function parseExecuteConfidentialTradePayload(input: Uint8Array): ConfidentialTradePayload {
  const text = new TextDecoder().decode(input);
  const raw = JSON.parse(text) as Record<string, unknown>;
  return {
    agentId: String(raw.agentId ?? ""),
    marketId: String(raw.marketId ?? raw.questionId ?? ""),
    outcomeIndex: Number(raw.outcomeIndex ?? 0),
    buy: Boolean(raw.buy),
    quantity: String(raw.quantity ?? "0"),
    tradeCostUsdc: String(raw.tradeCostUsdc ?? "0"),
    nonce: String(raw.nonce ?? "0"),
    deadline: String(raw.deadline ?? "0"),
  };
}

function ensureQuestionId(marketId: string): `0x${string}` {
  const s = marketId.trim();
  if (s.startsWith("0x") && s.length === 66) return s as `0x${string}`;
  if (s.length === 64) return (`0x${s}` as `0x${string}`);
  throw new Error("Invalid marketId: expected 32-byte hex (64 or 66 chars)");
}

export async function handleExecuteConfidentialTrade(
  runtime: Runtime<ExecuteConfidentialTradeHandlerConfig>,
  payload: { input: Uint8Array }
): Promise<ExecuteConfidentialTradeResponse> {
  const config = runtime.config?.contracts;
  if (!config) {
    runtime.log("executeConfidentialTrade requires config.contracts");
    throw new Error("Missing config.contracts");
  }

  const body = parseExecuteConfidentialTradePayload(payload.input);
  if (!body.agentId) throw new Error("Missing body.agentId");
  const namespace = runtime.config?.agentKeysNamespace ?? AGENT_KEYS_NAMESPACE;

  const questionId = ensureQuestionId(body.marketId);

  const market = await getMarket({ runtime, config }, questionId);
  if (market.outcomeSlotCount === 0) {
    throw new Error("Market not found or invalid");
  }
  if (body.outcomeIndex >= market.outcomeSlotCount) {
    throw new Error("Outcome index out of range");
  }

  const nonce = BigInt(body.nonce);
  if (getNonceUsed(runtime, config, questionId, nonce)) {
    throw new Error("Nonce already used");
  }

  if (body.buy) {
    const balance = await getVaultBalanceForOutcome({ runtime, config }, market.conditionId, body.outcomeIndex);
    if (balance < BigInt(body.quantity)) {
      throw new Error("Insufficient vault balance for this outcome");
    }
  }

  const secret = runtime.getSecret({ id: body.agentId, namespace }).result();
  const privateKeyRaw = secret.value ?? "";
  if (!privateKeyRaw) {
    throw new Error("Agent key secret not found; ensure cre secrets create for this agentId");
  }
  const privateKey: Hex = privateKeyRaw.startsWith("0x") ? (privateKeyRaw as Hex) : (`0x${privateKeyRaw}` as Hex);

  const domain = {
    name: config.eip712.domainName,
    version: config.eip712.domainVersion,
    chainId: config.chainId,
    verifyingContract: config.contracts.predictionVault as Hex,
  };
  const message = {
    questionId,
    outcomeIndex: BigInt(body.outcomeIndex),
    buy: body.buy,
    quantity: BigInt(body.quantity),
    tradeCostUsdc: BigInt(body.tradeCostUsdc),
    nonce,
    deadline: BigInt(body.deadline),
  };

  const userSignature = await signTypedData({
    domain,
    types: LMSR_QUOTE_TYPES,
    primaryType: "LMSRQuote",
    message,
    privateKey,
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

  const donSignerSecret = runtime.getSecret({ id: DON_SIGNER_ID, namespace: DON_SIGNER_NAMESPACE }).result();
  const donSignerKey = donSignerSecret.value ?? "";
  if (!donSignerKey) {
    throw new Error("DON signer secret not configured (BACKEND_SIGNER_PRIVATE_KEY in namespace sub0)");
  }
  const donSigned = signLMSRQuote(
    {
      questionId,
      outcomeIndex: body.outcomeIndex,
      buy: body.buy,
      quantity: BigInt(body.quantity),
      tradeCostUsdc: BigInt(body.tradeCostUsdc),
      nonce,
      deadline: BigInt(body.deadline),
    },
    config,
    donSignerKey
  );
  const donSignature = donSigned.signature as Hex;

  const pubKey = secp256k1.getPublicKey(hexToBytes(privateKey), false);
  const user = getAddress(publicKeyToAddress(pubKey));

  const maxCostUsdc = BigInt(body.tradeCostUsdc);
  const txHash = submitExecuteTrade(runtime, config, quote, maxCostUsdc, user, donSignature, userSignature);
  runtime.log("Confidential trade submitted successfully.");
  return { txHash };
}
