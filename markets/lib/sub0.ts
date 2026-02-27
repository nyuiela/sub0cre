/**
 * Sub0 (factory) read-only contract interactions and create(Market) write.
 * CRE uses: getMarket(questionId), predictionVault(), conditionalToken(), vault(); create(Market) for market creation.
 * Report + writeReport pattern matches Chainlink example (encodedPayload, encoderName evm, writeReport with receiver + gasConfig).
 */

import {
  cre,
  getNetwork,
  bytesToHex,
  hexToBase64,
  TxStatus,
} from "@chainlink/cre-sdk";
import {
  concat,
  encodeAbiParameters,
  encodePacked,
  keccak256,
  parseAbiParameters,
} from "viem";
import type { Runtime } from "@chainlink/cre-sdk";
import type { Sub0Market, CreateMarketParams } from "../types/market";
import type { ChainContractConfig } from "../types/contracts";
import type { Sub0ResolvePayload, Sub0StakePayload, Sub0RedeemPayload } from "../types/cre";
import { SUB0_CRE_ACTION } from "../types/cre";
import type { EvmContext } from "./evm";
import { SUB0_ABI } from "./abis";
import {
  callContract,
  decodeCallResult,
  buildCallData,
  LATEST_BLOCK_NUMBER,
  LAST_FINALIZED_BLOCK_NUMBER,
} from "./evm";

/** Default gas limit for writeReport (forwarder + receiver call). */
const DEFAULT_WRITE_GAS_LIMIT = "600000";

/** Receiver contract execution reverted (proto enum value). */
const RECEIVER_EXECUTION_REVERTED = 1;

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** Single-byte CRE action prefix (avoids number-to-hex ambiguity for 0x00). */
function crePrefixByte(action: number): `0x${string}` {
  return bytesToHex(new Uint8Array([action])) as `0x${string}`;
}

/** Default market when getMarket returns empty (e.g. not yet created or call reverted in sim/broadcast). */
const EMPTY_MARKET: Sub0Market = {
  question: "",
  conditionId: ZERO_BYTES32,
  oracle: ZERO_ADDRESS,
  owner: ZERO_ADDRESS,
  createdAt: 0n,
  duration: 0n,
  outcomeSlotCount: 0,
  oracleType: 0,
  marketType: 0,
};

/** True when market is the default empty (not found). Reporter tx can succeed even when inner Sub0.create reverts; use this to verify. */
export function isMarketEmpty(market: Sub0Market): boolean {
  return (
    (market.conditionId === ZERO_BYTES32 || !market.conditionId) &&
    (market.question === "" || !market.question?.trim())
  );
}

/** Ensure string is a 32-byte hex (0x + 64 hex chars). Use before passing to EIP-712 or contract calls. */
export function ensureQuestionIdBytes32(value: string): `0x${string}` {
  const s = typeof value === "string" ? value.trim() : "";
  const hex = s.startsWith("0x") ? s : `0x${s}`;
  if (hex.length !== 66 || !/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("questionId must be 32-byte hex (0x + 64 hex chars)");
  }
  return hex as `0x${string}`;
}

/** ABI parameters for create(Market) tuple - matches Sub0.Market (sub0.json). CRE report = 0x00 || abi.encode(Market). */
const CREATE_MARKET_PARAMS = parseAbiParameters(
  "(string question, bytes32 conditionId, address oracle, address owner, uint256 createdAt, uint256 duration, uint256 outcomeSlotCount, uint8 oracleType, uint8 marketType)"
);
const RESOLVE_PARAMS = parseAbiParameters("bytes32 questionId, uint256[] payouts, address oracle");
const STAKE_PARAMS = parseAbiParameters(
  "bytes32 questionId, bytes32 parentCollectionId, uint256[] partition, address token, uint256 amount, address owner"
);
const REDEEM_PARAMS = parseAbiParameters(
  "bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets, address token, address owner, uint256 deadline, uint256 nonce, bytes signature"
);

export interface GetMarketOptions {
  /** When true, read at latest block (use after create so the new market is visible). Default false = last finalized block. */
  useLatestBlock?: boolean;
}

/**
 * Read market by questionId. Use useLatestBlock: true when calling right after create so the read sees the just-mined tx
 * (otherwise last-finalized block can be 1-2 blocks behind and returns empty).
 */
export async function getMarket(
  ctx: EvmContext,
  questionId: `0x${string}`,
  options?: GetMarketOptions
): Promise<Sub0Market> {
  const data = buildCallData(SUB0_ABI, "getMarket", [questionId]);
  const blockNumber =
    options?.useLatestBlock === true ? LATEST_BLOCK_NUMBER : LAST_FINALIZED_BLOCK_NUMBER;
  const reply = callContract(
    ctx.runtime,
    ctx.config.chainSelectorName,
    ctx.config.contracts.sub0 as `0x${string}`,
    data,
    blockNumber
  );
  const hexData =
    reply.data.length === 0 ? "0x" : (bytesToHex(reply.data) as `0x${string}`);
  if (hexData === "0x" || hexData === "0x0") {
    return EMPTY_MARKET;
  }
  try {
    const m = decodeCallResult<Sub0Market>(SUB0_ABI, "getMarket", reply.data);
    return {
      question: m.question,
      conditionId: m.conditionId,
      oracle: m.oracle,
      owner: m.owner,
      createdAt: m.createdAt,
      duration: m.duration,
      outcomeSlotCount: Number(m.outcomeSlotCount),
      oracleType: m.oracleType,
      marketType: m.marketType,
    };
  } catch {
    return EMPTY_MARKET;
  }
}

export function getPredictionVaultAddress(ctx: EvmContext): `0x${string}` {
  const data = buildCallData(SUB0_ABI, "predictionVault", []);
  const reply = callContract(
    ctx.runtime,
    ctx.config.chainSelectorName,
    ctx.config.contracts.sub0 as `0x${string}`,
    data
  );
  const raw = decodeCallResult<[`0x${string}`]>(SUB0_ABI, "predictionVault", reply.data);
  return raw[0];
}

export function getConditionalTokenAddress(ctx: EvmContext): `0x${string}` {
  const data = buildCallData(SUB0_ABI, "conditionalToken", []);
  const reply = callContract(
    ctx.runtime,
    ctx.config.chainSelectorName,
    ctx.config.contracts.sub0 as `0x${string}`,
    data
  );
  const raw = decodeCallResult<[`0x${string}`]>(SUB0_ABI, "conditionalToken", reply.data);
  return raw[0];
}

export function getVaultAddress(ctx: EvmContext): `0x${string}` {
  const data = buildCallData(SUB0_ABI, "vault", []);
  const reply = callContract(
    ctx.runtime,
    ctx.config.chainSelectorName,
    ctx.config.contracts.sub0 as `0x${string}`,
    data
  );
  const raw = decodeCallResult<[`0x${string}`]>(SUB0_ABI, "vault", reply.data);
  return raw[0];
}

/**
 * Encode Sub0 CRE create report. Per cre.contract.md: report = 0x00 || abi.encode(Market).
 * conditionId, owner, createdAt are placeholders; contract sets them.
 */
export function encodeCreateMarket(params: CreateMarketParams): `0x${string}` {
  const marketTuple = {
    question: params.question,
    conditionId: ZERO_BYTES32,
    oracle: params.oracle,
    owner: params.owner,
    createdAt: 0n,
    duration: BigInt(params.duration),
    outcomeSlotCount: BigInt(params.outcomeSlotCount),
    oracleType: params.oracleType,
    marketType: params.marketType,
  };
  const payload = encodeAbiParameters(CREATE_MARKET_PARAMS, [marketTuple]);
  return concat([crePrefixByte(SUB0_CRE_ACTION.CREATE), payload]);
}

/** Encode Sub0 CRE resolve report: 0x01 || abi.encode(questionId, payouts, oracle). */
export function encodeSub0ReportResolve(payload: Sub0ResolvePayload): `0x${string}` {
  const encoded = encodeAbiParameters(RESOLVE_PARAMS, [
    payload.questionId,
    [...payload.payouts],
    payload.oracle,
  ]);
  return concat([crePrefixByte(SUB0_CRE_ACTION.RESOLVE), encoded]);
}

/** Encode Sub0 CRE stake report: 0x02 || abi.encode(questionId, parentCollectionId, partition, token, amount, owner). */
export function encodeSub0ReportStake(payload: Sub0StakePayload): `0x${string}` {
  const encoded = encodeAbiParameters(STAKE_PARAMS, [
    payload.questionId,
    payload.parentCollectionId,
    [...payload.partition],
    payload.token,
    payload.amount,
    payload.owner,
  ]);
  return concat([crePrefixByte(SUB0_CRE_ACTION.STAKE), encoded]);
}

/** Encode Sub0 CRE redeem report: 0x03 || abi.encode(parentCollectionId, conditionId, indexSets, token, owner, deadline, nonce, signature). */
export function encodeSub0ReportRedeem(payload: Sub0RedeemPayload): `0x${string}` {
  const encoded = encodeAbiParameters(REDEEM_PARAMS, [
    payload.parentCollectionId,
    payload.conditionId,
    [...payload.indexSets],
    payload.token,
    payload.owner,
    payload.deadline,
    payload.nonce,
    payload.signature,
  ]);
  return concat([crePrefixByte(SUB0_CRE_ACTION.REDEEM), encoded]);
}

/**
 * Compute questionId as Sub0 does: keccak256(abi.encodePacked(question, creator, oracle)).
 */
export function computeQuestionId(
  question: string,
  creator: `0x${string}`,
  oracle: `0x${string}`
): `0x${string}` {
  const packed = encodePacked(
    ["string", "address", "address"],
    [question, creator, oracle]
  );
  return keccak256(packed);
}

const DEFAULT_GAS_LIMIT = "500000";

function blockExplorerTxUrl(chainSelectorName: string, txHash: string): string {
  if (chainSelectorName === "ethereum-testnet-sepolia-base-1") {
    return `https://sepolia.basescan.org/tx/${txHash}`;
  }
  return `https://etherscan.io/tx/${txHash}`;
}


// function blockExplorerTxUrl(chainSelectorName: string, txHash: string): string {
//   if (chainSelectorName === "ethereum-testnet-sepolia-base-1") {
//     return `https://sepolia.basescan.org/tx/${txHash}`;
//   }
//   return `https://etherscan.io/tx/${txHash}`;
// }

/**
 * Write a Sub0 CRE report onchain. Shared by create, resolve, stake, redeem.
 * Receiver is Sub0; report = prefix (1 byte) + abi.encode(payload) per cre.contract.md.
 */
export function writeSub0Report(
  runtime: Runtime<unknown>,
  config: ChainContractConfig,
  hexPayload: `0x${string}`,
  label: string
): string {
  const gasLimit = config.gasLimit ?? DEFAULT_GAS_LIMIT;
  const receiverAddress = config.contracts.sub0.startsWith("0x")
    ? (config.contracts.sub0 as `0x${string}`)
    : (`0x${config.contracts.sub0}` as `0x${string}`);

  runtime.log(`Writing report to Sub0 consumer: ${receiverAddress}`);
  // runtime.log(
  //   `Writing report to consumer contract - question: ${params.question}, oracle: ${params.oracle}, duration: ${params.duration}`
  // );

  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: config.chainSelectorName,
    isTestnet: true,
  });
  if (!network) throw new Error(`Network not found: ${config.chainSelectorName}`);
  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);

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
    throw new Error(`${label}: forwarder tx succeeded but Sub0 reverted. Check params and roles.`);
  }
  const rawHash = writeResult.txHash;
  if (rawHash != null && rawHash.length > 0) {
    return typeof rawHash === "string" ? rawHash : bytesToHex(rawHash);
  }
  runtime.log(
    `${label}: no txHash returned (simulate without --broadcast skips chain write; use broadcast: true in trigger or cre workflow simulate --broadcast for real tx hash).`
  );
  return "";
}

/**
 * Submit create(Market) onchain via CRE report. Per cre.contract.md: report = 0x00 || abi.encode(Market).
 * Platform only: uses env private key (must have GAME_CREATOR_ROLE for Public markets).
 */
export function submitCreateMarket(
  runtime: Runtime<unknown>,
  config: ChainContractConfig,
  params: CreateMarketParams
): string {
  const hexPayload = encodeCreateMarket(params);
  runtime.log(`[Create] CRE report built: prefix 0x00 + abi.encode(Market), total ${(hexPayload.length - 2) / 2} bytes`);
  return writeSub0Report(runtime, config, hexPayload, "Create market");
}

/** Submit Sub0 resolve via CRE report (0x01 || abi.encode(questionId, payouts, oracle)). Oracle must match market. */
export function submitResolveMarket(
  runtime: Runtime<unknown>,
  config: ChainContractConfig,
  payload: Sub0ResolvePayload
): string {
  const hexPayload = encodeSub0ReportResolve(payload);
  return writeSub0Report(runtime, config, hexPayload, "Resolve market");
}

/** Submit Sub0 stake via CRE report (0x02 || abi.encode(...)). */
export function submitStake(
  runtime: Runtime<unknown>,
  config: ChainContractConfig,
  payload: Sub0StakePayload
): string {
  const hexPayload = encodeSub0ReportStake(payload);
  return writeSub0Report(runtime, config, hexPayload, "Stake");
}

/** Submit Sub0 redeem via CRE report (0x03 || abi.encode(...)). Owner must have signed EIP-712 Redeem. */
export function submitRedeem(
  runtime: Runtime<unknown>,
  config: ChainContractConfig,
  payload: Sub0RedeemPayload
): string {
  const hexPayload = encodeSub0ReportRedeem(payload);
  return writeSub0Report(runtime, config, hexPayload, "Redeem");
}
