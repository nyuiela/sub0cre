/**
 * PredictionVault: read-only views and EIP-712 quote signing (agent).
 * Platform write: encodeSeedMarketLiquidity for runtime.report(writeReport).
 */

import {
  cre,
  getNetwork,
  prepareReportRequest,
  bytesToHex,
} from "@chainlink/cre-sdk";
import {
  type Address,
  decodeFunctionResult,
  encodeFunctionData,
  zeroAddress,
  type Hex,
} from "viem";
import type { Runtime } from "@chainlink/cre-sdk";
import { signTypedDataSync } from "./signTypedDataSync";
import type { ChainContractConfig } from "../types/contracts";
import type { LMSRQuoteParams, SignedQuoteResult } from "../types/quote";
import { PREDICTION_VAULT_ABI } from "./abis";
import { getEVMClient, callContract, decodeCallResult, buildCallData } from "./evm";

export function getConditionId(
  runtime: Runtime<unknown>,
  config: ChainContractConfig,
  questionId: `0x${string}`
): `0x${string}` {
  const data = buildCallData(PREDICTION_VAULT_ABI, "getConditionId", [questionId]);
  const reply = callContract(
    runtime,
    config.chainSelectorName,
    config.contracts.predictionVault as Address,
    data
  );
  const raw = decodeCallResult<[`0x${string}`]>(
    PREDICTION_VAULT_ABI,
    "getConditionId",
    reply.data
  );
  return raw[0];
}

export function getBackendSigner(
  runtime: Runtime<unknown>,
  config: ChainContractConfig
): `0x${string}` {
  const data = buildCallData(PREDICTION_VAULT_ABI, "backendSigner", []);
  const reply = callContract(
    runtime,
    config.chainSelectorName,
    config.contracts.predictionVault as Address,
    data
  );
  const raw = decodeCallResult<[`0x${string}`]>(
    PREDICTION_VAULT_ABI,
    "backendSigner",
    reply.data
  );
  return raw[0];
}

export function getNonceUsed(
  runtime: Runtime<unknown>,
  config: ChainContractConfig,
  questionId: `0x${string}`,
  nonce: bigint
): boolean {
  const data = buildCallData(PREDICTION_VAULT_ABI, "nonceUsed", [questionId, nonce]);
  const reply = callContract(
    runtime,
    config.chainSelectorName,
    config.contracts.predictionVault as Address,
    data
  );
  const raw = decodeCallResult<[boolean]>(PREDICTION_VAULT_ABI, "nonceUsed", reply.data);
  return raw[0];
}

/**
 * Sign EIP-712 LMSR quote for executeTrade. Agent path: use backend signer key from secrets.
 */
export function signLMSRQuote(
  params: LMSRQuoteParams,
  config: ChainContractConfig,
  privateKeyHex: string
): SignedQuoteResult {
  const domain = {
    name: config.eip712.domainName,
    version: config.eip712.domainVersion,
    chainId: config.chainId,
    verifyingContract: config.contracts.predictionVault as Address,
  };
  const types = {
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
  const message = {
    questionId: params.questionId,
    outcomeIndex: BigInt(params.outcomeIndex),
    buy: params.buy,
    quantity: params.quantity,
    tradeCostUsdc: params.tradeCostUsdc,
    nonce: params.nonce,
    deadline: params.deadline,
  };
  const key = privateKeyHex.startsWith("0x") ? (privateKeyHex as Hex) : (`0x${privateKeyHex}` as Hex);
  const signature = signTypedDataSync({
    domain,
    types,
    primaryType: "LMSRQuote",
    message,
    privateKey: key,
  });
  return {
    questionId: params.questionId,
    outcomeIndex: params.outcomeIndex,
    buy: params.buy,
    quantity: params.quantity.toString(),
    tradeCostUsdc: params.tradeCostUsdc.toString(),
    nonce: params.nonce.toString(),
    deadline: params.deadline.toString(),
    signature,
  };
}

/**
 * Encode executeTrade for agent/confidential write.
 * Contract signature: (questionId, outcomeIndex, buy, quantity, tradeCostUsdc, maxCostUsdc, nonce, deadline, user, donSignature, userSignature).
 */
export function encodeExecuteTrade(
  quote: {
    questionId: `0x${string}`;
    outcomeIndex: bigint;
    buy: boolean;
    quantity: bigint;
    tradeCostUsdc: bigint;
    nonce: bigint;
    deadline: bigint;
  },
  maxCostUsdc: bigint,
  user: `0x${string}`,
  donSignature: `0x${string}`,
  userSignature: `0x${string}`
): `0x${string}` {
  return encodeFunctionData({
    abi: PREDICTION_VAULT_ABI,
    functionName: "executeTrade",
    args: [
      quote.questionId,
      quote.outcomeIndex,
      quote.buy,
      quote.quantity,
      quote.tradeCostUsdc,
      maxCostUsdc,
      quote.nonce,
      quote.deadline,
      user,
      donSignature as Hex,
      userSignature as Hex,
    ],
  });
}

/**
 * Encode seedMarketLiquidity(questionId, amountUsdc) for platform write.
 * Caller uses: evmClient.writeReport(runtime, prepareReportRequest(hexPayload)).result()
 * with CRE_ETH_PRIVATE_KEY (owner of PredictionVault).
 */
export function encodeSeedMarketLiquidity(
  questionId: `0x${string}`,
  amountUsdc: bigint
): `0x${string}` {
  return encodeFunctionData({
    abi: PREDICTION_VAULT_ABI,
    functionName: "seedMarketLiquidity",
    args: [questionId, amountUsdc],
  });
}

/**
 * Submit seedMarketLiquidity as onchain write via CRE report.
 * Platform only: requires env private key to be PredictionVault owner.
 * Returns transaction hash when the reply includes it.
 */
export function submitSeedMarketLiquidity(
  runtime: Runtime<unknown>,
  config: ChainContractConfig,
  questionId: `0x${string}`,
  amountUsdc: bigint
): string {
  const hexPayload = encodeSeedMarketLiquidity(questionId, amountUsdc);
  const reportRequest = prepareReportRequest(hexPayload);
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: config.chainSelectorName,
    isTestnet: true,
  });
  if (!network) throw new Error(`Network not found: ${config.chainSelectorName}`);
  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);
  const receiverHex = config.contracts.predictionVault.replace(/^0x/, "");
  const receiver = new Uint8Array(20);
  for (let i = 0; i < 20; i++) receiver[i] = parseInt(receiverHex.slice(i * 2, i * 2 + 2), 16);
  const reply = evmClient
    .writeReport(runtime, {
      receiver,
      report: runtime.report(reportRequest).result(),
      $report: true,
    })
    .result();
  if (reply.txHash != null && reply.txHash.length > 0) {
    return typeof reply.txHash === "string" ? reply.txHash : bytesToHex(reply.txHash);
  }
  return "";
}

/**
 * Submit executeTrade as onchain write via CRE report.
 * Contract expects: user (trader), donSignature (backend/DON), userSignature (trader/agent).
 */
export function submitExecuteTrade(
  runtime: Runtime<unknown>,
  config: ChainContractConfig,
  quote: {
    questionId: `0x${string}`;
    outcomeIndex: bigint;
    buy: boolean;
    quantity: bigint;
    tradeCostUsdc: bigint;
    nonce: bigint;
    deadline: bigint;
  },
  maxCostUsdc: bigint,
  user: `0x${string}`,
  donSignature: `0x${string}`,
  userSignature: `0x${string}`
): string {
  const hexPayload = encodeExecuteTrade(quote, maxCostUsdc, user, donSignature, userSignature);
  const reportRequest = prepareReportRequest(hexPayload);
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: config.chainSelectorName,
    isTestnet: true,
  });
  if (!network) throw new Error(`Network not found: ${config.chainSelectorName}`);
  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);
  const receiverHex = config.contracts.predictionVault.replace(/^0x/, "");
  const receiver = new Uint8Array(20);
  for (let i = 0; i < 20; i++) receiver[i] = parseInt(receiverHex.slice(i * 2, i * 2 + 2), 16);
  const reply = evmClient
    .writeReport(runtime, {
      receiver,
      report: runtime.report(reportRequest).result(),
      $report: true,
    })
    .result();
  if (reply.txHash != null && reply.txHash.length > 0) {
    return typeof reply.txHash === "string" ? reply.txHash : bytesToHex(reply.txHash);
  }
  return "";
}
