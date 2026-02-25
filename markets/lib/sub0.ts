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
  encodeFunctionData,
  encodePacked,
  getFunctionSelector,
  keccak256,
  parseAbiParameters,
  zeroAddress,
} from "viem";
import type { Runtime } from "@chainlink/cre-sdk";
import type { Sub0Market, CreateMarketParams } from "../types/market";
import type { ChainContractConfig } from "../types/contracts";
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

/** ABI parameters for create(Market) tuple - matches Sub0.Market (sub0.json). Used with encodeAbiParameters like CRE bootcamp. */
const CREATE_MARKET_PARAMS = parseAbiParameters(
  "(string question, bytes32 conditionId, address oracle, address owner, uint256 createdAt, uint256 duration, uint256 outcomeSlotCount, uint8 oracleType, uint8 marketType)"
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
 * Encode Sub0.create(Market) call. Uses encodeAbiParameters (CRE bootcamp style); prepends function selector so forwarder receives full calldata.
 * conditionId, owner, createdAt are placeholders; contract sets them.
 */
export function encodeCreateMarket(params: CreateMarketParams): `0x${string}` {
  const marketTuple = {
    question: params.question,
    conditionId: ZERO_BYTES32,
    oracle: params.oracle,
    owner: "0xf0830060f836B8d54bF02049E5905F619487989e" as `0x${string}`,
    createdAt: 0n,
    duration: BigInt(params.duration),
    outcomeSlotCount: BigInt(params.outcomeSlotCount),
    oracleType: params.oracleType,
    marketType: params.marketType,
  };

  // ✅ THE ALTERNATIVE FIX: Let viem do the heavy lifting
  // return encodeFunctionData({
  //   abi: SUB0_ABI,
  //   functionName: "create",
  //   args: [marketTuple],
  // });
  return encodeAbiParameters(CREATE_MARKET_PARAMS, [marketTuple]);
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

/**
 * Submit create(Market) onchain via CRE report. Platform only: uses env private key (must have GAME_CREATOR_ROLE for Public markets).
 * Matches Chainlink CRE bootcamp pattern: report (encodedPayload/evm) + writeReport (receiver, gasConfig). Step logs align with bootcamp for debugging.
 * Note: The reporter (forwarder) tx can succeed even when the inner Sub0.create call reverts. We check receiverContractExecutionStatus when set;
 * the createMarket workflow also verifies the market exists after write (getMarket + retry) and throws if not found.
 */
export function submitCreateMarket(
  runtime: Runtime<unknown>,
  config: ChainContractConfig,
  params: CreateMarketParams
): string {
  runtime.log("[Step 1] Encoding create(Market) calldata...");
  const hexPayload = encodeCreateMarket(params);
  runtime.log(`[Step 1] Calldata length: ${hexPayload.length} chars (0x prefix + selector + args)`);

  runtime.log("[Step 2] Resolving network and EVM client...");
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: config.chainSelectorName,
    isTestnet: true,
  });
  if (!network) {
    throw new Error(`Network not found: ${config.chainSelectorName}`);
  }
  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);
  const receiverAddress =
    config.contracts.sub0.startsWith("0x") ? config.contracts.sub0 : `0x${config.contracts.sub0}`;
  runtime.log(`[Step 2] Chain: ${config.chainSelectorName}, receiver (Sub0): ${receiverAddress}`);

  runtime.log("[Step 3] Generating signed CRE report (evm encoder, ecdsa, keccak256)...");
  const reportResponse = runtime
    .report({
      encodedPayload: hexToBase64(hexPayload),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result();
  runtime.log("[Step 3] Report generated.");

  runtime.log(`[Step 4] Writing report to contract (writeReport), gasLimit: ${DEFAULT_WRITE_GAS_LIMIT}...`);
  const writeResult = evmClient
    .writeReport(runtime, {
      receiver: receiverAddress,
      report: reportResponse,
      gasConfig: { gasLimit: DEFAULT_WRITE_GAS_LIMIT },
    })
    .result();

  runtime.log(
    `[Step 5] writeReport returned txStatus=${writeResult.txStatus}, receiverStatus=${writeResult.receiverContractExecutionStatus ?? "undefined"}, hasTxHash=${writeResult.txHash != null && writeResult.txHash.length > 0}`
  );

  if (writeResult.txStatus !== TxStatus.SUCCESS) {
    throw new Error(
      `Create market transaction failed with status: ${writeResult.txStatus}`
    );
  }
  if (writeResult.receiverContractExecutionStatus === RECEIVER_EXECUTION_REVERTED) {
    throw new Error(
      "Create market: forwarder tx succeeded but Sub0 contract reverted. Check role (GAME_CREATOR_ROLE) and calldata."
    );
  }
  const rawHash = writeResult.txHash;
  const txHash =
    rawHash != null && rawHash.length > 0
      ? typeof rawHash === "string"
        ? rawHash
        : bytesToHex(rawHash)
      : bytesToHex(new Uint8Array(32));
  runtime.log(`[Step 6] Done. txHash: ${txHash}`);
  return txHash;
}
