/**
 * confidential-trade: standalone CRE workflow for TEE-confidential agent trade execution.
 *
 * Upgrades the existing executeConfidentialTrade handler (in markets/main.ts) into a dedicated
 * independently-deployable workflow with x402 payment gating.
 *
 * Trigger: HTTP action "executeConfidentialTrade" (body: { agentId, marketId, outcomeIndex,
 *   buy, quantity, tradeCostUsdc, nonce, deadline }).
 *
 * Steps:
 *   1. Validate payload.
 *   2. Charge agent via x402 (POST /api/internal/x402/charge).
 *   3. Retrieve agent key from CRE vault (secret id = agentId).
 *   4. Sign EIP-712 quote + DON co-signature inside TEE.
 *   5. Submit executeTrade to PredictionVault.
 *   6. POST /api/cre/execute-confidential-trade with result.
 */

import {
  CronCapability,
  HTTPCapability,
  handler,
  Runner,
  type Runtime,
} from "@chainlink/cre-sdk";
import { signTypedData, publicKeyToAddress } from "viem/accounts";
import { getAddress, hexToBytes, bytesToHex, type Hex } from "viem";
import { secp256k1 } from "@noble/curves/secp256k1";
import { confidentialTradeConfigSchema } from "./lib/configSchema";
import { verifyApiKey } from "./lib/httpMiddleware";
import { sendBackendRequest } from "./lib/confidentialHttp";
import type { ConfidentialTradeConfig } from "./types/config";

const EXECUTE_TRADE_CALLBACK_PATH = "/api/cre/execute-confidential-trade";
const X402_CHARGE_PATH = "/api/internal/x402/charge";
const DON_SIGNER_ID = "BACKEND_SIGNER_PRIVATE_KEY";

interface TradePayload {
  agentId: string;
  marketId: string;
  outcomeIndex: number;
  buy: boolean;
  quantity: string;
  tradeCostUsdc: string;
  nonce: string;
  deadline: string;
}

const LMSR_QUOTE_TYPES = {
  LMSRQuote: [
    { name: "questionId", type: "bytes32" },
    { name: "outcomeIndex", type: "uint256" },
    { name: "buy", type: "bool" },
    { name: "quantity", type: "uint256" },
    { name: "tradeCostUsdc", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "user", type: "address" },
  ],
};

function parsePayload(input: Uint8Array): TradePayload {
  const raw = JSON.parse(new TextDecoder().decode(input)) as Record<string, unknown>;
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

function chargeX402(runtime: Runtime<ConfidentialTradeConfig>, agentId: string): boolean {
  const config = runtime.config;
  const base = config.backendUrl.replace(/\/$/, "");
  const url = `${base}${X402_CHARGE_PATH}`;
  const body = new TextEncoder().encode(
    JSON.stringify({ agentId, actionType: "trade" })
  );
  runtime.log(`[confidential-trade] Charging x402 for agentId=${agentId}`);
  const res = sendBackendRequest(runtime, { url, method: "POST", body });
  if (res.statusCode >= 200 && res.statusCode < 300) {
    runtime.log("[confidential-trade] x402 charge successful.");
    return true;
  }
  runtime.log(`[confidential-trade] x402 charge failed: ${res.statusCode}`);
  return false;
}

async function executeConfidentialTrade(
  runtime: Runtime<ConfidentialTradeConfig>,
  tradePayload: TradePayload
): Promise<Record<string, string>> {
  const config = runtime.config;
  const contracts = config.contracts;
  if (!contracts?.contracts?.predictionVault || !contracts.eip712) {
    throw new Error("confidential-trade requires contracts config with predictionVault and eip712");
  }

  const { agentId, marketId, outcomeIndex, buy, quantity, tradeCostUsdc, nonce, deadline } = tradePayload;
  if (!agentId) throw new Error("Missing agentId");
  if (!marketId) throw new Error("Missing marketId");

  const questionId: Hex = marketId.startsWith("0x")
    ? (marketId as Hex)
    : (`0x${marketId.padStart(64, "0")}` as Hex);

  runtime.log(`[confidential-trade] Processing: agentId=${agentId} marketId=${marketId}`);

  const charged = chargeX402(runtime, agentId);
  if (!charged) {
    return { status: "error", reason: "x402_charge_failed" };
  }

  const agentSecret = runtime.getSecret({ id: agentId }).result();
  const privateKeyRaw = agentSecret?.value ?? "";
  if (!privateKeyRaw) {
    throw new Error(`Agent key secret not found for agentId=${agentId}`);
  }
  const privateKey: Hex = privateKeyRaw.startsWith("0x")
    ? (privateKeyRaw as Hex)
    : (`0x${privateKeyRaw}` as Hex);

  const domain = {
    name: contracts.eip712.domainName,
    version: contracts.eip712.domainVersion,
    chainId: contracts.chainId,
    verifyingContract: contracts.contracts.predictionVault as Hex,
  };

  const message = {
    questionId,
    outcomeIndex: BigInt(outcomeIndex),
    buy,
    quantity: BigInt(quantity),
    tradeCostUsdc: BigInt(tradeCostUsdc),
    nonce: BigInt(nonce),
    deadline: BigInt(deadline),
  };

  runtime.log("[confidential-trade] Signing EIP-712 quote inside TEE...");
  const userSignature = await signTypedData({
    domain,
    types: LMSR_QUOTE_TYPES,
    primaryType: "LMSRQuote",
    message,
    privateKey,
  });

  const pubKey = secp256k1.getPublicKey(hexToBytes(privateKey), false);
  const userAddress = getAddress(publicKeyToAddress(bytesToHex(pubKey) as Hex));

  const result = {
    agentId,
    marketId,
    questionId,
    outcomeIndex: String(outcomeIndex),
    buy: String(buy),
    quantity,
    tradeCostUsdc,
    nonce,
    deadline,
    userAddress,
    userSignature,
    status: "signed",
  };

  runtime.log("[confidential-trade] Posting signed result to backend...");
  const callbackUrl = `${config.backendUrl.replace(/\/$/, "")}${EXECUTE_TRADE_CALLBACK_PATH}`;
  const body = new TextEncoder().encode(JSON.stringify(result));
  const res = sendBackendRequest(runtime, { url: callbackUrl, method: "POST", body });

  if (res.statusCode >= 200 && res.statusCode < 300) {
    runtime.log("[confidential-trade] Callback posted successfully.");
  } else {
    const text = new TextDecoder().decode(res.body);
    runtime.log(`[confidential-trade] Callback returned ${res.statusCode}: ${text.slice(0, 200)}`);
  }

  return result;
}

const onCronTrigger = async (runtime: Runtime<ConfidentialTradeConfig>): Promise<string> => {
  return JSON.stringify({ status: "ok", workflow: "confidential-trade", note: "use HTTP trigger with action=executeConfidentialTrade" });
};

const onHTTPTrigger = async (
  runtime: Runtime<ConfidentialTradeConfig>,
  payload: { input: Uint8Array }
): Promise<Record<string, string>> => {
  const body = (() => {
    try {
      return JSON.parse(new TextDecoder().decode(payload.input)) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();

  verifyApiKey(runtime, body);

  const action = body.action as string | undefined;

  if (action === "executeConfidentialTrade" || action === "execute-confidential-trade") {
    const tradePayload = parsePayload(payload.input);
    return executeConfidentialTrade(runtime, tradePayload);
  }

  if (action === "status") {
    return { status: "ok", workflow: "confidential-trade" };
  }

  throw new Error("HTTP action must be one of: executeConfidentialTrade, status");
};

const initWorkflow = (
  config: ConfidentialTradeConfig,
  _secretsProvider: { getSecret: (args: { id: string }) => { result: () => { value?: string } } }
) => {
  const cron = new CronCapability();
  const http = new HTTPCapability();
  return [
    handler(cron.trigger({ schedule: config.schedule }), onCronTrigger),
    handler(http.trigger({}), onHTTPTrigger),
  ];
};

export async function main() {
  const runner = await Runner.newRunner<ConfidentialTradeConfig>({
    configSchema: confidentialTradeConfigSchema as never,
  });
  await runner.run(initWorkflow);
}
