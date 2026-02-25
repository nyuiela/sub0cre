/**
 * Shared EVM client and call helpers for Sub0 contract reads.
 * Platform writes use prepareReportRequest + runtime.report in predictionVault.
 */

import {
  cre,
  encodeCallMsg,
  getNetwork,
  LAST_FINALIZED_BLOCK_NUMBER,
  LATEST_BLOCK_NUMBER,
  bytesToHex,
} from "@chainlink/cre-sdk";
import {
  type Address,
  decodeFunctionResult,
  encodeFunctionData,
  zeroAddress,
} from "viem";
import type { Runtime } from "@chainlink/cre-sdk";
import type { ChainContractConfig } from "../types/contracts";

export function getEVMClient(chainSelectorName: string) {
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName,
    isTestnet: true,
  });
  if (!network) {
    throw new Error(`Network not found for chainSelectorName: ${chainSelectorName}`);
  }
  return new cre.capabilities.EVMClient(network.chainSelector.selector);
}

export type BlockNumberOption = { absVal: string; sign: string };

export function callContract(
  runtime: Runtime<unknown>,
  chainSelectorName: string,
  to: Address,
  data: `0x${string}`,
  blockNumber: BlockNumberOption = LATEST_BLOCK_NUMBER
): { data: Uint8Array } {
  const evmClient = getEVMClient(chainSelectorName);
  const callMsg = encodeCallMsg({
    from: zeroAddress,
    to,
    data,
  });
  const reply = evmClient
    .callContract(runtime, {
      call: callMsg,
      blockNumber,
    })
    .result();
  return { data: reply.data };
}

export function decodeCallResult<T>(abi: readonly unknown[], functionName: string, data: Uint8Array): T {
  return decodeFunctionResult({
    abi,
    functionName,
    data: bytesToHex(data) as `0x${string}`,
  }) as T;
}

export function buildCallData(abi: readonly unknown[], functionName: string, args: unknown[]): `0x${string}` {
  return encodeFunctionData({
    abi,
    functionName,
    args,
  });
}

export type EvmContext = {
  runtime: Runtime<unknown>;
  config: ChainContractConfig;
};

export { LATEST_BLOCK_NUMBER, LAST_FINALIZED_BLOCK_NUMBER };
