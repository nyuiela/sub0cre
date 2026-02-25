/**
 * Sub0 (factory) read-only contract interactions and create(Market) write.
 * CRE uses: getMarket(questionId), predictionVault(), conditionalToken(), vault(); create(Market) for market creation.
 */

import { cre, getNetwork, prepareReportRequest, bytesToHex, TxStatus } from "@chainlink/cre-sdk";
import { encodeFunctionData, encodePacked, keccak256, zeroAddress } from "viem";
import type { Runtime } from "@chainlink/cre-sdk";
import type { Sub0Market, CreateMarketParams } from "../types/market";
import type { ChainContractConfig } from "../types/contracts";
import type { EvmContext } from "./evm";
import { SUB0_ABI } from "./abis";
import { callContract, decodeCallResult, buildCallData } from "./evm";

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

export async function getMarket(ctx: EvmContext, questionId: `0x${string}`): Promise<Sub0Market> {
  const data = buildCallData(SUB0_ABI, "getMarket", [questionId]);
  const reply = callContract(
    ctx.runtime,
    ctx.config.chainSelectorName,
    ctx.config.contracts.sub0 as `0x${string}`,
    data
  );
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
 * Encode Sub0.create(Market) call. conditionId, owner, createdAt are placeholders; contract sets them.
 */
export function encodeCreateMarket(params: CreateMarketParams): `0x${string}` {
  const marketTuple = [
    params.question,
    ZERO_BYTES32,
    params.oracle,
    zeroAddress,
    0n,
    BigInt(params.duration),
    params.outcomeSlotCount,
    params.oracleType,
    params.marketType,
  ];
  return encodeFunctionData({
    abi: SUB0_ABI,
    functionName: "create",
    args: [marketTuple],
  });
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

/**
 * Submit create(Market) onchain via CRE report. Platform only: uses env private key (must have GAME_CREATOR_ROLE for Public markets).
 * Returns transaction hash when the reply includes it. Logs write progress like CRE docs (consumer address, waiting, txHash, explorer URL).
 */
export function submitCreateMarket(
  runtime: Runtime<unknown>,
  config: ChainContractConfig,
  params: CreateMarketParams
): string {
  const receiverAddress = config.contracts.sub0;
  const gasLimit = config.gasLimit ?? DEFAULT_GAS_LIMIT;

  runtime.log(`Writing report to Sub0 consumer: ${receiverAddress}`);
  runtime.log(
    `Writing report to consumer contract - question: ${params.question}, oracle: ${params.oracle}, duration: ${params.duration}`
  );

  const hexPayload = encodeCreateMarket(params);
  const reportRequest = prepareReportRequest(hexPayload);
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: config.chainSelectorName,
    isTestnet: true,
  });
  if (!network) throw new Error(`Network not found: ${config.chainSelectorName}`);
  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);

  const reply = evmClient
    .writeReport(runtime, {
      receiver: receiverAddress,
      report: runtime.report(reportRequest).result(),
      gasConfig: { gasLimit },
    })
    .result();

  runtime.log("Waiting for write report response");

  const txHash =
    reply.txHash != null && reply.txHash.length > 0
      ? typeof reply.txHash === "string"
        ? reply.txHash
        : bytesToHex(reply.txHash)
      : "";

  if (reply.errorMessage != null && String(reply.errorMessage).trim().length > 0) {
    runtime.log(`Write report error: ${reply.errorMessage}`);
  }
  if (reply.txStatus !== undefined && reply.txStatus !== TxStatus.SUCCESS) {
    runtime.log(`Write report tx status: ${reply.txStatus}`);
  }
  if (txHash.length > 0) {
    const txUrl = blockExplorerTxUrl(config.chainSelectorName, txHash);
    runtime.log(`Write report transaction succeeded: ${txHash}`);
    runtime.log(`View transaction at ${txUrl}`);
    return txHash;
  }
  runtime.log("Write report completed but no transaction hash returned (e.g. dry run without --broadcast)");
  return "";
}
