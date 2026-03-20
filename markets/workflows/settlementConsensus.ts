/**
 * Settlement consensus: verifiable two-LLM deliberation running inside the CRE TEE.
 * Replaces backend settlement-deliberation.service.ts which ran LLMs inside the backend process.
 *
 * Runs in the CRE TEE: both LLM calls and the resulting on-chain write are verifiable.
 * If both agents agree → writes resolution report to AgentSettlementReceiver on-chain.
 * If they disagree → POSTs to /api/internal/escalate for human/fallback resolution.
 *
 * Deliberation protocol:
 *   1. Fetch market context from /api/internal/settlement/context/{marketId}.
 *   2. Call LLM-1 (primary): POST /api/internal/cre/deliberate-primary with context.
 *   3. Call LLM-2 (cross-check): POST /api/internal/cre/deliberate-crosscheck with context + LLM-1 opinion.
 *   4. Compare payouts arrays. Consensus = same winner (max payout index match).
 *   5. On consensus: write settlement report on-chain via handleRunSettlement.
 *   6. On no consensus: POST /api/internal/escalate.
 *
 * Trigger: Cron (schedule in config). Also callable as HTTP action "settlementConsensus".
 */

import type { Runtime } from "@chainlink/cre-sdk";
import type { WorkflowConfig } from "../types/config";
import { sendConfidentialBackendRequest } from "../lib/confidentialHttp";
import { handleRunSettlement } from "./runSettlement";

const SETTLEMENT_DUE_PATH = "/api/internal/settlement/due";
const SETTLEMENT_CONTEXT_PATH = "/api/internal/settlement/context";
const DELIBERATE_PRIMARY_PATH = "/api/internal/cre/deliberate-primary";
const DELIBERATE_CROSSCHECK_PATH = "/api/internal/cre/deliberate-crosscheck";
const ESCALATE_PATH = "/api/internal/escalate";

const MAX_MARKETS_PER_CONSENSUS_RUN = 5;

interface DueMarket {
  id: string;
  name: string;
  conditionId: string;
  resolutionDate: string;
  status: string;
  settlementRules?: string | null;
}

interface AgentVerdict {
  payouts: string[];
  rationale?: string;
  winnerIndex?: number;
}

interface ConsensusResult {
  consensus: boolean;
  payouts: string[] | null;
  primaryVerdict: AgentVerdict | null;
  crosscheckVerdict: AgentVerdict | null;
}

function fetchDueMarkets(runtime: Runtime<WorkflowConfig>): DueMarket[] {
  const config = runtime.config;
  const backendUrl = config.backendUrl?.trim() ?? "";
  if (!backendUrl) return [];

  const url = `${backendUrl.replace(/\/$/, "")}${SETTLEMENT_DUE_PATH}?limit=${MAX_MARKETS_PER_CONSENSUS_RUN}`;
  runtime.log("[settlement-consensus] Fetching due markets.");

  const res = sendConfidentialBackendRequest(runtime, { url, method: "GET" });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const text = new TextDecoder().decode(res.body);
    runtime.log(`[settlement-consensus] due list failed ${res.statusCode} ${text.slice(0, 200)}`);
    return [];
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(res.body)) as { data?: DueMarket[] };
    return Array.isArray(parsed?.data) ? parsed.data : [];
  } catch {
    return [];
  }
}

function fetchMarketContext(
  runtime: Runtime<WorkflowConfig>,
  marketId: string
): Record<string, unknown> | null {
  const config = runtime.config;
  const backendUrl = config.backendUrl?.trim() ?? "";
  const url = `${backendUrl.replace(/\/$/, "")}${SETTLEMENT_CONTEXT_PATH}/${marketId}`;

  const res = sendConfidentialBackendRequest(runtime, { url, method: "GET" });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    runtime.log(`[settlement-consensus] context fetch failed ${res.statusCode} for ${marketId}`);
    return null;
  }

  try {
    return JSON.parse(new TextDecoder().decode(res.body)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function callDeliberateAgent(
  runtime: Runtime<WorkflowConfig>,
  path: string,
  context: Record<string, unknown>,
  priorOpinion?: AgentVerdict | null
): AgentVerdict | null {
  const config = runtime.config;
  const backendUrl = config.backendUrl?.trim() ?? "";
  const url = `${backendUrl.replace(/\/$/, "")}${path}`;

  const reqBody: Record<string, unknown> = { context };
  if (priorOpinion != null) reqBody.priorOpinion = priorOpinion;

  const body = new TextEncoder().encode(JSON.stringify(reqBody));
  const res = sendConfidentialBackendRequest(runtime, { url, method: "POST", body });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    const text = new TextDecoder().decode(res.body);
    runtime.log(`[settlement-consensus] deliberate agent failed ${res.statusCode}: ${text.slice(0, 200)}`);
    return null;
  }

  try {
    return JSON.parse(new TextDecoder().decode(res.body)) as AgentVerdict;
  } catch {
    return null;
  }
}

function checkConsensus(
  v1: AgentVerdict,
  v2: AgentVerdict
): ConsensusResult {
  if (!Array.isArray(v1.payouts) || !Array.isArray(v2.payouts)) {
    return { consensus: false, payouts: null, primaryVerdict: v1, crosscheckVerdict: v2 };
  }
  if (v1.payouts.length !== v2.payouts.length) {
    return { consensus: false, payouts: null, primaryVerdict: v1, crosscheckVerdict: v2 };
  }

  const winnerIdx1 = v1.payouts.reduce(
    (max, val, i) => (Number(val) > Number(v1.payouts[max]) ? i : max),
    0
  );
  const winnerIdx2 = v2.payouts.reduce(
    (max, val, i) => (Number(val) > Number(v2.payouts[max]) ? i : max),
    0
  );

  const consensus = winnerIdx1 === winnerIdx2;
  return {
    consensus,
    payouts: consensus ? v1.payouts : null,
    primaryVerdict: v1,
    crosscheckVerdict: v2,
  };
}

function postEscalate(
  runtime: Runtime<WorkflowConfig>,
  marketId: string,
  questionId: string,
  reason: string
): void {
  const config = runtime.config;
  const backendUrl = config.backendUrl?.trim() ?? "";
  const url = `${backendUrl.replace(/\/$/, "")}${ESCALATE_PATH}`;

  const body = new TextEncoder().encode(
    JSON.stringify({ marketId, questionId, reason, source: "settlement-consensus" })
  );
  const res = sendConfidentialBackendRequest(runtime, { url, method: "POST", body });
  if (res.statusCode >= 200 && res.statusCode < 300) {
    runtime.log(`[settlement-consensus] Escalated marketId=${marketId}.`);
  } else {
    runtime.log(`[settlement-consensus] Escalate returned ${res.statusCode}.`);
  }
}

async function runConsensusForMarket(
  runtime: Runtime<WorkflowConfig>,
  market: DueMarket
): Promise<"resolved" | "escalated" | "skipped"> {
  runtime.log(`[settlement-consensus] Processing marketId=${market.id}`);

  const context = fetchMarketContext(runtime, market.id);
  if (!context) {
    runtime.log(`[settlement-consensus] No context for marketId=${market.id}; skip.`);
    return "skipped";
  }

  const verdict1 = callDeliberateAgent(runtime, DELIBERATE_PRIMARY_PATH, context, null);
  if (!verdict1) {
    postEscalate(runtime, market.id, market.conditionId, "primary_agent_failed");
    return "escalated";
  }
  runtime.log(`[settlement-consensus] Primary verdict: winnerIndex=${verdict1.winnerIndex}`);

  const verdict2 = callDeliberateAgent(runtime, DELIBERATE_CROSSCHECK_PATH, context, verdict1);
  if (!verdict2) {
    postEscalate(runtime, market.id, market.conditionId, "crosscheck_agent_failed");
    return "escalated";
  }
  runtime.log(`[settlement-consensus] Crosscheck verdict: winnerIndex=${verdict2.winnerIndex}`);

  const { consensus, payouts } = checkConsensus(verdict1, verdict2);

  if (!consensus || !payouts) {
    runtime.log(`[settlement-consensus] No consensus for marketId=${market.id}; escalating.`);
    postEscalate(runtime, market.id, market.conditionId, "no_consensus");
    return "escalated";
  }

  runtime.log(`[settlement-consensus] Consensus reached for marketId=${market.id}; writing report.`);

  const settlePayload = new TextEncoder().encode(
    JSON.stringify({ marketId: market.id, questionId: market.conditionId, payouts })
  );

  const result = await handleRunSettlement(runtime, { input: settlePayload });
  if (result.canResolve === "true") {
    runtime.log(`[settlement-consensus] Resolved marketId=${market.id} txHash=${result.txHash}`);
    return "resolved";
  }

  runtime.log(`[settlement-consensus] writeReport returned canResolve=false for marketId=${market.id}`);
  postEscalate(runtime, market.id, market.conditionId, "write_report_failed");
  return "escalated";
}

export async function handleSettlementConsensusCron(
  runtime: Runtime<WorkflowConfig>
): Promise<string> {
  const config = runtime.config;
  if (!config.backendUrl?.trim() || !config.contracts?.contracts?.agentSettlementReceiver) {
    runtime.log("[settlement-consensus] backendUrl or agentSettlementReceiver not configured; skip.");
    return JSON.stringify({ status: "ok", resolved: 0, escalated: 0, skipped: true });
  }

  if (config.x402Enabled) {
    const x402Url = `${config.backendUrl.replace(/\/$/, "")}/api/internal/cre/x402-charge`;
    const x402Body = new TextEncoder().encode(JSON.stringify({ workflow: "settlementConsensus", amount: "0.0002" }));
    sendConfidentialBackendRequest(runtime, { url: x402Url, method: "POST", body: x402Body });
    runtime.log("[x402] charge dispatched workflow=settlementConsensus");
  }

  const markets = fetchDueMarkets(runtime);
  if (markets.length === 0) {
    runtime.log("[settlement-consensus] No due markets.");
    return JSON.stringify({ status: "ok", resolved: 0, escalated: 0, skipped: false });
  }

  let resolved = 0;
  let escalated = 0;

  for (const m of markets) {
    if (!m?.id || !m?.conditionId) continue;
    try {
      const outcome = await runConsensusForMarket(runtime, m);
      if (outcome === "resolved") resolved++;
      else if (outcome === "escalated") escalated++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      runtime.log(`[settlement-consensus] Error for marketId=${m.id}: ${msg}`);
      escalated++;
    }
  }

  runtime.log(
    `[settlement-consensus] Done. resolved=${resolved} escalated=${escalated} total=${markets.length}`
  );
  return JSON.stringify({
    status: "ok",
    resolved,
    escalated,
    total: markets.length,
    skipped: false,
  });
}

export async function handleSettlementConsensusHttp(
  runtime: Runtime<WorkflowConfig>,
  body: Record<string, unknown>
): Promise<Record<string, string>> {
  if (body.action === "settlementConsensus") {
    const result = JSON.parse(await handleSettlementConsensusCron(runtime)) as Record<
      string,
      unknown
    >;
    return {
      status: String(result.status ?? "ok"),
      action: "settlementConsensus",
      resolved: String(result.resolved ?? 0),
      escalated: String(result.escalated ?? 0),
      total: String(result.total ?? 0),
    };
  }
  throw new Error("HTTP action must be: settlementConsensus");
}
