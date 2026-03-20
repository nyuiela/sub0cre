/**
 * settlement-consensus: CRE workflow that runs two-agent LLM deliberation inside the TEE,
 * encodes the consensus outcome, writes the resolution report to AgentSettlementReceiver on-chain,
 * and notifies the backend cache.
 *
 * Replaces: sub0server settlement-deliberation.service.ts + settlement-internal.routes.ts.
 *
 * Trigger: HTTP action "runSettlement" (body: { marketId, questionId }).
 * The existing markets/main.ts runSettlement handler calls the backend's settlement/run endpoint
 * which now delegates the deliberation step to this workflow via confidential HTTP.
 *
 * Steps:
 *   1. POST /api/internal/settlement/deliberate — backend gathers market data, returns context.
 *   2. POST /api/internal/settlement/agent1 — Research LLM gives opinion (confidential HTTP).
 *   3. POST /api/internal/settlement/agent2 — Review LLM reviews agent1 opinion (confidential HTTP).
 *   4. Consensus check: if outcomeArrays match → proceed; else escalate.
 *   5. Encode settlement report + EVM write to AgentSettlementReceiver.
 *   6. POST /api/internal/settlement/resolved or /api/internal/escalate.
 */

import {
  cre,
  getNetwork,
  bytesToHex,
  hexToBase64,
  TxStatus,
  CronCapability,
  HTTPCapability,
  handler,
  Runner,
  type Runtime,
} from "@chainlink/cre-sdk";
import { encodeAbiParameters, parseAbiParameters, getFunctionSelector } from "viem";
import { settlementConsensusConfigSchema } from "./lib/configSchema";
import { verifyApiKey } from "./lib/httpMiddleware";
import { sendBackendRequest } from "./lib/confidentialHttp";
import type { SettlementConsensusConfig } from "./types/config";

const DELIBERATE_PATH = "/api/internal/settlement/deliberate";
const AGENT1_PATH = "/api/internal/settlement/agent1";
const AGENT2_PATH = "/api/internal/settlement/agent2";
const RESOLVED_PATH = "/api/internal/settlement/resolved";
const ESCALATE_PATH = "/api/internal/escalate";

const SETTLEMENT_REPORT_PARAMS = parseAbiParameters("bytes32, uint256[]");
const DEFAULT_GAS_LIMIT = "1500000";
const RECEIVER_REVERTED = 1;

interface DeliberateContext {
  question: string;
  outcomes: string[];
  rules?: string;
  questionId: string;
}

interface AgentVerdict {
  outcomeArray: number[];
  outcomeString: string;
  reason?: string;
}

function encodeReport(questionId: `0x${string}`, payouts: number[]): `0x${string}` {
  const qid = questionId.length === 66
    ? questionId
    : (`0x${questionId.replace(/^0x/, "").padStart(64, "0")}` as `0x${string}`);
  const payoutsBigInt = payouts.map((p) => BigInt(p));
  return encodeAbiParameters(SETTLEMENT_REPORT_PARAMS, [qid, payoutsBigInt]);
}

function fetchDeliberateContext(
  runtime: Runtime<SettlementConsensusConfig>,
  marketId: string,
  questionId: string
): DeliberateContext {
  const config = runtime.config;
  const base = config.backendUrl.replace(/\/$/, "");
  const url = `${base}${DELIBERATE_PATH}`;
  const body = new TextEncoder().encode(JSON.stringify({ marketId, questionId }));

  runtime.log(`[settlement-consensus] Fetching deliberate context for marketId=${marketId}`);
  const res = sendBackendRequest(runtime, { url, method: "POST", body });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const text = new TextDecoder().decode(res.body);
    throw new Error(`deliberate context failed: ${res.statusCode} ${text.slice(0, 200)}`);
  }
  return JSON.parse(new TextDecoder().decode(res.body)) as DeliberateContext;
}

function requestAgentVerdict(
  runtime: Runtime<SettlementConsensusConfig>,
  path: string,
  context: DeliberateContext,
  otherOpinion?: string
): AgentVerdict {
  const config = runtime.config;
  const base = config.backendUrl.replace(/\/$/, "");
  const url = `${base}${path}`;
  const body = new TextEncoder().encode(JSON.stringify({ ...context, otherOpinion }));

  runtime.log(`[settlement-consensus] Requesting agent verdict from ${path}`);
  const res = sendBackendRequest(runtime, { url, method: "POST", body });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const text = new TextDecoder().decode(res.body);
    throw new Error(`agent verdict from ${path} failed: ${res.statusCode} ${text.slice(0, 200)}`);
  }
  return JSON.parse(new TextDecoder().decode(res.body)) as AgentVerdict;
}

function arraysEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function writeSettlementReport(
  runtime: Runtime<SettlementConsensusConfig>,
  questionId: `0x${string}`,
  payouts: number[]
): string {
  const config = runtime.config;
  const contracts = config.contracts;
  if (!contracts?.contracts?.agentSettlementReceiver) {
    throw new Error("settlement-consensus requires config.contracts.agentSettlementReceiver");
  }

  const receiverAddress = contracts.contracts.agentSettlementReceiver.startsWith("0x")
    ? (contracts.contracts.agentSettlementReceiver as `0x${string}`)
    : (`0x${contracts.contracts.agentSettlementReceiver}` as `0x${string}`);

  runtime.log("[settlement-consensus] Encoding report...");
  const tuplePayload = encodeReport(questionId, payouts);
  const selector = getFunctionSelector("resolve(bytes32,uint256[])");
  const fullPayload = (`0x${selector.slice(2)}${tuplePayload.slice(2)}`) as `0x${string}`;

  runtime.log("[settlement-consensus] Resolving network...");
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: contracts.chainSelectorName,
    isTestnet: true,
  });
  if (!network) throw new Error(`Network not found: ${contracts.chainSelectorName}`);

  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);
  runtime.log("[settlement-consensus] Generating signed CRE report...");
  const reportResponse = runtime
    .report({
      encodedPayload: hexToBase64(fullPayload),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result();

  const gasLimit = contracts.gasLimit ?? DEFAULT_GAS_LIMIT;
  runtime.log(`[settlement-consensus] Writing report to AgentSettlementReceiver (gasLimit=${gasLimit})...`);
  const writeResult = evmClient
    .writeReport(runtime, {
      receiver: receiverAddress,
      report: reportResponse,
      gasConfig: { gasLimit },
    })
    .result();

  if (writeResult.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`writeReport failed with status: ${writeResult.txStatus}`);
  }
  if (writeResult.receiverContractExecutionStatus === RECEIVER_REVERTED) {
    throw new Error("writeReport: tx succeeded but receiver reverted. Check questionId and oracle.");
  }

  const rawHash = writeResult.txHash;
  return rawHash != null && rawHash.length > 0
    ? typeof rawHash === "string" ? rawHash : bytesToHex(rawHash)
    : "";
}

async function runSettlementConsensus(
  runtime: Runtime<SettlementConsensusConfig>,
  marketId: string,
  questionIdRaw: string
): Promise<Record<string, string>> {
  const questionId = questionIdRaw.startsWith("0x")
    ? (questionIdRaw as `0x${string}`)
    : (`0x${questionIdRaw}` as `0x${string}`);

  runtime.log(`[settlement-consensus] Starting for marketId=${marketId}`);

  const context = fetchDeliberateContext(runtime, marketId, questionIdRaw);

  runtime.log("[settlement-consensus] Requesting Research Agent (agent1) opinion...");
  const agent1 = requestAgentVerdict(runtime, AGENT1_PATH, context);

  runtime.log("[settlement-consensus] Requesting Review Agent (agent2) opinion...");
  const agent2 = requestAgentVerdict(
    runtime,
    AGENT2_PATH,
    context,
    JSON.stringify(agent1)
  );

  const consensus = arraysEqual(agent1.outcomeArray, agent2.outcomeArray);
  runtime.log(
    `[settlement-consensus] agent1=${JSON.stringify(agent1.outcomeArray)} agent2=${JSON.stringify(agent2.outcomeArray)} consensus=${consensus}`
  );

  if (!consensus) {
    runtime.log("[settlement-consensus] No consensus. Escalating to backend.");
    const base = runtime.config.backendUrl.replace(/\/$/, "");
    const escalateUrl = `${base}${ESCALATE_PATH}`;
    const body = new TextEncoder().encode(
      JSON.stringify({
        marketId,
        questionId: questionIdRaw,
        agent1Opinion: agent1,
        agent2Opinion: agent2,
        reason: "agents_disagree",
      })
    );
    const res = sendBackendRequest(runtime, { url: escalateUrl, method: "POST", body });
    runtime.log(`[settlement-consensus] escalate callback returned ${res.statusCode}`);
    return { status: "escalated", marketId, questionId: questionIdRaw, consensus: "false" };
  }

  runtime.log("[settlement-consensus] Consensus reached. Writing report on-chain...");
  let txHash: string;
  try {
    txHash = writeSettlementReport(runtime, questionId, agent1.outcomeArray);
    runtime.log(`[settlement-consensus] Report written. txHash=${txHash}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    runtime.log(`[settlement-consensus] writeReport error: ${msg}`);
    throw err;
  }

  const base = runtime.config.backendUrl.replace(/\/$/, "");
  const resolvedUrl = `${base}${RESOLVED_PATH}`;
  const resolvedBody = new TextEncoder().encode(
    JSON.stringify({ marketId, questionId: questionIdRaw, txHash, payouts: agent1.outcomeArray })
  );
  const resolvedRes = sendBackendRequest(runtime, { url: resolvedUrl, method: "POST", body: resolvedBody });
  runtime.log(`[settlement-consensus] resolved callback returned ${resolvedRes.statusCode}`);

  return { status: "ok", marketId, questionId: questionIdRaw, txHash, consensus: "true" };
}

const onCronTrigger = async (runtime: Runtime<SettlementConsensusConfig>): Promise<string> => {
  return JSON.stringify({ status: "ok", workflow: "settlement-consensus", note: "use HTTP trigger with action=runSettlement" });
};

const onHTTPTrigger = async (
  runtime: Runtime<SettlementConsensusConfig>,
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

  if (action === "runSettlement") {
    const marketId = typeof body.marketId === "string" ? body.marketId.trim() : "";
    const questionId = typeof body.questionId === "string" ? body.questionId.trim() : "";
    if (!marketId || !questionId) {
      throw new Error("runSettlement requires marketId and questionId");
    }
    return runSettlementConsensus(runtime, marketId, questionId);
  }

  if (action === "status") {
    return { status: "ok", workflow: "settlement-consensus" };
  }

  throw new Error("HTTP action must be one of: runSettlement, status");
};

const initWorkflow = (
  config: SettlementConsensusConfig,
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
  const runner = await Runner.newRunner<SettlementConsensusConfig>({
    configSchema: settlementConsensusConfigSchema as never,
  });
  await runner.run(initWorkflow);
}
