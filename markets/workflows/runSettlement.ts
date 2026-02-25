/**
 * Settlement workflow: call backend to run two-agent deliberation, then write resolution report to AgentSettlementReceiver.
 * Trigger: HTTP action "runSettlement" with body { marketId, questionId }.
 * Uses Confidential HTTP for backend calls (API key from vault only).
 */

import {
  cre,
  getNetwork,
  bytesToHex,
  hexToBase64,
  TxStatus,
} from "@chainlink/cre-sdk";
import { encodeAbiParameters, parseAbiParameters, getFunctionSelector } from "viem";
import type { Runtime } from "@chainlink/cre-sdk";
import type { WorkflowConfig } from "../types/config";
import { sendConfidentialBackendRequest } from "../lib/confidentialHttp";

const SETTLEMENT_RUN_PATH = "/api/internal/settlement/run";
const SETTLEMENT_RESOLVED_PATH = "/api/internal/settlement/resolved";
const DEFAULT_WRITE_GAS_LIMIT = "400000";
const RECEIVER_EXECUTION_REVERTED = 1;

const SETTLEMENT_REPORT_PARAMS = parseAbiParameters("bytes32, uint256[]");

function encodeSettlementReport(questionId: `0x${string}`, payouts: string[]): `0x${string}` {
  const questionIdBytes32 = questionId.length === 66 ? questionId : (`0x${questionId.replace(/^0x/, "").padStart(64, "0")}` as `0x${string}`);
  const payoutsBigInt = payouts.map((p) => BigInt(p));
  return encodeAbiParameters(SETTLEMENT_REPORT_PARAMS, [questionIdBytes32, payoutsBigInt]);
}

export interface RunSettlementPayload {
  marketId: string;
  questionId: string;
}

export async function handleRunSettlement(
  runtime: Runtime<WorkflowConfig>,
  payload: { input: Uint8Array }
): Promise<Record<string, string>> {
  const config = runtime.config;
  const backendUrl = config.backendUrl?.trim();
  if (!backendUrl) {
    throw new Error("runSettlement requires config.backendUrl");
  }
  const contracts = config.contracts;
  if (!contracts?.contracts?.agentSettlementReceiver) {
    throw new Error("runSettlement requires config.contracts.agentSettlementReceiver");
  }

  const text = new TextDecoder().decode(payload.input);
  const body = JSON.parse(text) as Record<string, unknown>;
  const marketId = String(body.marketId ?? "").trim();
  const questionIdRaw = String(body.questionId ?? "").trim();
  const questionId = questionIdRaw.startsWith("0x") ? (questionIdRaw as `0x${string}`) : (`0x${questionIdRaw}` as `0x${string}`);
  if (!marketId || !questionIdRaw) {
    throw new Error("runSettlement body must include marketId and questionId (onchain bytes32 hex)");
  }

  const runUrl = `${backendUrl.replace(/\/$/, "")}${SETTLEMENT_RUN_PATH}`;
  runtime.log("Calling backend settlement run (confidential HTTP).");

  const runBody = new TextEncoder().encode(JSON.stringify({ marketId, questionId: questionIdRaw }));
  const res = sendConfidentialBackendRequest(runtime, {
    url: runUrl,
    method: "POST",
    body: runBody,
  });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    const bodyText = new TextDecoder().decode(res.body);
    throw new Error(`Backend settlement run failed: ${res.statusCode} ${bodyText}`);
  }

  const resBody = JSON.parse(new TextDecoder().decode(res.body)) as {
    canResolve?: boolean;
    questionId?: string;
    payouts?: string[] | null;
    outcomeArray?: number[] | null;
    consensus?: boolean;
  };

  if (!resBody.canResolve || !Array.isArray(resBody.payouts) || resBody.payouts.length === 0) {
    runtime.log(`Settlement no consensus or no payouts: canResolve=${resBody.canResolve}, consensus=${resBody.consensus}`);
    return {
      status: "ok",
      result: "runSettlement",
      canResolve: "false",
      reason: resBody.canResolve === false ? "no_consensus_or_invalid" : "no_payouts",
    };
  }

  const receiverAddress = contracts.contracts.agentSettlementReceiver.startsWith("0x")
    ? (contracts.contracts.agentSettlementReceiver as `0x${string}`)
    : (`0x${contracts.contracts.agentSettlementReceiver}` as `0x${string}`);

  runtime.log("[Step 1] Encoding settlement report (questionId, payouts)...");
  const tuplePayload = encodeSettlementReport(questionId, resBody.payouts);
  const selector = getFunctionSelector("resolve(bytes32,uint256[])");
  const fullPayload = (`0x${selector.slice(2)}${tuplePayload.slice(2)}`) as `0x${string}`;
  runtime.log(`[Step 1] Report length: ${fullPayload.length} chars`);

  runtime.log("[Step 2] Resolving network and EVM client...");
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: contracts.chainSelectorName,
    isTestnet: true,
  });
  if (!network) {
    throw new Error(`Network not found: ${contracts.chainSelectorName}`);
  }
  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);
  runtime.log(`[Step 2] Chain: ${contracts.chainSelectorName}, receiver: ${receiverAddress}`);

  runtime.log("[Step 3] Generating signed CRE report (evm encoder)...");
  const reportResponse = runtime
    .report({
      encodedPayload: hexToBase64(fullPayload),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result();
  runtime.log("[Step 3] Report generated.");

  runtime.log(`[Step 4] Writing report to AgentSettlementReceiver, gasLimit: ${DEFAULT_WRITE_GAS_LIMIT}...`);
  const writeResult = evmClient
    .writeReport(runtime, {
      receiver: receiverAddress,
      report: reportResponse,
      gasConfig: { gasLimit: DEFAULT_WRITE_GAS_LIMIT },
    })
    .result();

  runtime.log(
    `[Step 5] writeReport txStatus=${writeResult.txStatus}, receiverStatus=${writeResult.receiverContractExecutionStatus ?? "undefined"}`
  );

  if (writeResult.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`Settlement writeReport failed with status: ${writeResult.txStatus}`);
  }
  if (writeResult.receiverContractExecutionStatus === RECEIVER_EXECUTION_REVERTED) {
    throw new Error("Settlement: forwarder tx succeeded but receiver reverted. Check questionId and oracle.");
  }
  const rawHash = writeResult.txHash;
  const txHash =
    rawHash != null && rawHash.length > 0
      ? typeof rawHash === "string"
        ? rawHash
        : bytesToHex(rawHash)
      : "";

  const resolvedUrl = `${backendUrl.replace(/\/$/, "")}${SETTLEMENT_RESOLVED_PATH}`;
  runtime.log("[Step 6] Notifying backend market resolved (confidential HTTP).");
  try {
    const resolvedBody = new TextEncoder().encode(
      JSON.stringify({ marketId, questionId: questionIdRaw, txHash })
    );
    const resolvedRes = sendConfidentialBackendRequest(runtime, {
      url: resolvedUrl,
      method: "POST",
      body: resolvedBody,
    });
    if (resolvedRes?.statusCode >= 200 && resolvedRes.statusCode < 300) {
      runtime.log("[Step 6] Backend marked market RESOLVED.");
    } else {
      runtime.log(
        `[Step 6] Backend resolved callback returned ${resolvedRes?.statusCode ?? "?"}; market may still be OPEN in DB.`
      );
    }
  } catch (err) {
    runtime.log(`[Step 6] Backend resolved callback failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    status: "ok",
    result: "runSettlement",
    canResolve: "true",
    questionId: questionIdRaw,
    txHash,
  };
}
