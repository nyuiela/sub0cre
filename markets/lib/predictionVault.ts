/**
 * PredictionVault: read-only views, EIP-712 quote signing, and CRE report writes.
 * Per cre.contract.md: report = prefix (1 byte) + abi.encode(payload). 0x00 = execute trade, 0x01 = seed liquidity.
 */

import {
  cre,
  getNetwork,
  bytesToHex,
  hexToBase64,
  TxStatus,
} from "@chainlink/cre-sdk";
import {
  type Address,
  concat,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbiParameters,
  zeroAddress,
  type Hex,
} from "viem";
import type { Runtime } from "@chainlink/cre-sdk";
import { signTypedDataSync } from "./signTypedDataSync";
import type { ChainContractConfig } from "../types/contracts";
import type { LMSRQuoteParams, SignedQuoteResult } from "../types/quote";
import type { PredictionVaultExecuteTradePayload } from "../types/cre";
import { PREDICTION_VAULT_CRE_ACTION } from "../types/cre";
import { PREDICTION_VAULT_ABI } from "./abis";
import { getEVMClient, callContract, decodeCallResult, buildCallData } from "./evm";

const DEFAULT_WRITE_GAS_LIMIT = "500000";
const RECEIVER_EXECUTION_REVERTED = 1;
const EXECUTE_TRADE_PARAMS = parseAbiParameters(
  "bytes32 questionId, uint256 outcomeIndex, bool buy, uint256 quantity, uint256 tradeCostUsdc, uint256 maxCostUsdc, uint256 nonce, uint256 deadline, address user, bytes donSignature, bytes userSignature"
);
const SEED_LIQUIDITY_PARAMS = parseAbiParameters("bytes32 questionId, uint256 amountUsdc");

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
 * Encode PredictionVault CRE execute trade report: 0x00 || abi.encode(...). Used by submitExecuteTrade.
 */
export function encodePredictionVaultReportExecuteTrade(p: PredictionVaultExecuteTradePayload): `0x${string}` {
  const encoded = encodeAbiParameters(EXECUTE_TRADE_PARAMS, [
    p.questionId,
    p.outcomeIndex,
    p.buy,
    p.quantity,
    p.tradeCostUsdc,
    p.maxCostUsdc,
    p.nonce,
    p.deadline,
    p.user,
    p.donSignature as Hex,
    p.userSignature as Hex,
  ]);
  return concat([`0x${PREDICTION_VAULT_CRE_ACTION.EXECUTE_TRADE.toString(16).padStart(2, "0")}` as `0x${string}`, encoded]);
}

/**
 * Encode PredictionVault CRE seed liquidity report: 0x01 || abi.encode(questionId, amountUsdc).
 */
export function encodePredictionVaultReportSeedLiquidity(
  questionId: `0x${string}`,
  amountUsdc: bigint
): `0x${string}` {
  const encoded = encodeAbiParameters(SEED_LIQUIDITY_PARAMS, [questionId, amountUsdc]);
  return concat([`0x${PREDICTION_VAULT_CRE_ACTION.SEED_LIQUIDITY.toString(16).padStart(2, "0")}` as `0x${string}`, encoded]);
}

/** Write a PredictionVault CRE report onchain. Shared by executeTrade and seedLiquidity. */
function writePredictionVaultReport(
  runtime: Runtime<unknown>,
  config: ChainContractConfig,
  hexPayload: `0x${string}`,
  label: string
): string {
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: config.chainSelectorName,
    isTestnet: true,
  });
  if (!network) throw new Error(`Network not found: ${config.chainSelectorName}`);
  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);
  const receiverAddress = config.contracts.predictionVault.startsWith("0x")
    ? config.contracts.predictionVault
    : `0x${config.contracts.predictionVault}`;

  const reportResponse = runtime
    .report({
      encodedPayload: hexToBase64(hexPayload),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result();

  const writeResult = evmClient
    .writeReport(runtime, {
      receiver: receiverAddress,
      report: reportResponse,
      gasConfig: { gasLimit: DEFAULT_WRITE_GAS_LIMIT },
    })
    .result();

  if (writeResult.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`${label}: transaction failed with status: ${writeResult.txStatus}`);
  }
  if (writeResult.receiverContractExecutionStatus === RECEIVER_EXECUTION_REVERTED) {
    throw new Error(`${label}: forwarder tx succeeded but PredictionVault reverted.`);
  }
  const rawHash = writeResult.txHash;
  return rawHash != null && rawHash.length > 0
    ? typeof rawHash === "string"
      ? rawHash
      : bytesToHex(rawHash)
    : bytesToHex(new Uint8Array(32));
}

/**
 * Encode executeTrade (legacy selector-based). Use encodePredictionVaultReportExecuteTrade for CRE.
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
 * Submit seedMarketLiquidity via CRE report (0x01 || abi.encode(questionId, amountUsdc)).
 * Platform only: forwarder must be PredictionVault owner and have approved USDC.
 */
export function submitSeedMarketLiquidity(
  runtime: Runtime<unknown>,
  config: ChainContractConfig,
  questionId: `0x${string}`,
  amountUsdc: bigint
): string {
  const hexPayload = encodePredictionVaultReportSeedLiquidity(questionId, amountUsdc);
  return writePredictionVaultReport(runtime, config, hexPayload, "Seed liquidity");
}

/**
 * Submit executeTrade via CRE report (0x00 || abi.encode(...)). Dual-signature: DON + user.
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
  const payload: PredictionVaultExecuteTradePayload = {
    questionId: quote.questionId,
    outcomeIndex: quote.outcomeIndex,
    buy: quote.buy,
    quantity: quote.quantity,
    tradeCostUsdc: quote.tradeCostUsdc,
    maxCostUsdc,
    nonce: quote.nonce,
    deadline: quote.deadline,
    user,
    donSignature,
    userSignature,
  };
  const hexPayload = encodePredictionVaultReportExecuteTrade(payload);
  return writePredictionVaultReport(runtime, config, hexPayload, "Execute trade");
}
