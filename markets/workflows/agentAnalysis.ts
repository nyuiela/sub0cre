/**
 * Agent analysis workflow: fetch enqueued agent+market pairs from the backend,
 * dispatch LLM trading analysis via confidential HTTP, and submit orders.
 *
 * Replaces the BullMQ agent-worker.ts consumer that ran LLM analysis in the backend process.
 * Running in CRE TEE means the LLM call and resulting order decision are verifiable and confidential.
 *
 * Flow per agent+market pair:
 *   1. GET /api/internal/cre/enqueued-markets → list of { agentId, marketId }.
 *   2. POST /api/internal/cre/analyze → LLM decision { action, outcomeIndex, quantity }.
 *   3. If action is buy/sell: POST /api/orders with the decision.
 *   4. POST /api/internal/analysis-complete with outcome.
 *
 * Trigger: Cron (uses config.schedule). Also callable as HTTP action "agentAnalysis" or "agentAnalysisBatch".
 * x402: If config.x402Enabled, the analysis step charges agentId before LLM dispatch.
 */

import type { Runtime } from "@chainlink/cre-sdk";
import type { WorkflowConfig } from "../types/config";
import { sendConfidentialBackendRequest } from "../lib/confidentialHttp";

const ENQUEUED_MARKETS_PATH = "/api/internal/cre/enqueued-markets";
const ANALYZE_PATH = "/api/internal/cre/analyze";
const ORDERS_PATH = "/api/orders";
const ANALYSIS_COMPLETE_PATH = "/api/internal/analysis-complete";
const COMPLIANCE_CHECK_PATH = "/api/internal/compliance/check";

const MAX_PAIRS_PER_RUN = 20;

interface EnqueuedPair {
  agentId: string;
  marketId: string;
  chainKey?: string;
}

interface AnalysisDecision {
  action: "skip" | "buy" | "sell";
  outcomeIndex?: number;
  quantity?: string;
  reason?: string;
}

interface AnalysisBatchResult {
  status: string;
  processed: number;
  ordered: number;
  total: number;
  skipped: boolean;
}

function fetchEnqueuedPairs(
  runtime: Runtime<WorkflowConfig>
): EnqueuedPair[] {
  const config = runtime.config;
  const backendUrl = config.backendUrl?.trim() ?? "";
  if (!backendUrl) return [];

  const url = `${backendUrl.replace(/\/$/, "")}${ENQUEUED_MARKETS_PATH}?limit=${MAX_PAIRS_PER_RUN}&chainKey=main`;
  runtime.log(`[agent-analysis] Fetching enqueued pairs: ${url}`);

  const res = sendConfidentialBackendRequest(runtime, { url, method: "GET" });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const text = new TextDecoder().decode(res.body);
    runtime.log(`[agent-analysis] enqueued-markets failed: ${res.statusCode} ${text.slice(0, 200)}`);
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(res.body));
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? (parsed as EnqueuedPair[]) : [];
}

function requestLlmAnalysis(
  runtime: Runtime<WorkflowConfig>,
  agentId: string,
  marketId: string
): AnalysisDecision | null {
  const config = runtime.config;
  const backendUrl = config.backendUrl?.trim() ?? "";
  const url = `${backendUrl.replace(/\/$/, "")}${ANALYZE_PATH}`;

  const requestBody = new TextEncoder().encode(
    JSON.stringify({ agentId, marketId, chainKey: "main" })
  );

  runtime.log(`[agent-analysis] Requesting LLM analysis: agentId=${agentId} marketId=${marketId}`);
  const res = sendConfidentialBackendRequest(runtime, {
    url,
    method: "POST",
    body: requestBody,
  });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    const text = new TextDecoder().decode(res.body);
    runtime.log(`[agent-analysis] analyze failed: ${res.statusCode} ${text.slice(0, 200)}`);
    return null;
  }

  try {
    return JSON.parse(new TextDecoder().decode(res.body)) as AnalysisDecision;
  } catch {
    return null;
  }
}

function submitOrderDecision(
  runtime: Runtime<WorkflowConfig>,
  agentId: string,
  marketId: string,
  decision: AnalysisDecision
): boolean {
  if (decision.action === "skip" || decision.outcomeIndex == null || !decision.quantity) {
    runtime.log(`[agent-analysis] Skip — no order: agentId=${agentId} action=${decision.action}`);
    return false;
  }

  const config = runtime.config;
  const backendUrl = config.backendUrl?.trim() ?? "";
  const url = `${backendUrl.replace(/\/$/, "")}${ORDERS_PATH}`;

  const orderPayload = {
    agentId,
    marketId,
    outcomeIndex: decision.outcomeIndex,
    side: decision.action === "buy" ? "BID" : "ASK",
    quantity: decision.quantity,
    orderType: "MARKET",
    chainKey: "main",
  };

  const body = new TextEncoder().encode(JSON.stringify(orderPayload));
  runtime.log(`[agent-analysis] Submitting order: ${orderPayload.side} agentId=${agentId}`);

  const res = sendConfidentialBackendRequest(runtime, {
    url,
    method: "POST",
    body,
  });

  if (res.statusCode >= 200 && res.statusCode < 300) {
    runtime.log("[agent-analysis] Order submitted.");
    return true;
  }

  const text = new TextDecoder().decode(res.body);
  runtime.log(`[agent-analysis] Order submit failed: ${res.statusCode} ${text.slice(0, 200)}`);
  return false;
}

function postAnalysisComplete(
  runtime: Runtime<WorkflowConfig>,
  agentId: string,
  marketId: string,
  action: string,
  orderSubmitted: boolean
): void {
  const config = runtime.config;
  const backendUrl = config.backendUrl?.trim() ?? "";
  const url = `${backendUrl.replace(/\/$/, "")}${ANALYSIS_COMPLETE_PATH}`;

  const body = new TextEncoder().encode(
    JSON.stringify({
      agentId,
      marketId,
      action,
      orderSubmitted,
      source: "cre-markets-workflow",
    })
  );
  const res = sendConfidentialBackendRequest(runtime, { url, method: "POST", body });
  if (res.statusCode >= 200 && res.statusCode < 300) {
    runtime.log("[agent-analysis] analysis-complete posted.");
  } else {
    runtime.log(`[agent-analysis] analysis-complete returned ${res.statusCode}.`);
  }
}

function checkComplianceForPair(
  runtime: Runtime<WorkflowConfig>,
  walletAddress: string,
  marketId: string
): boolean {
  const config = runtime.config;
  if (!config.complianceEnabled) return true;
  const backendUrl = config.backendUrl?.trim() ?? "";
  if (!backendUrl) return true;

  const url = `${backendUrl.replace(/\/$/, "")}${COMPLIANCE_CHECK_PATH}`;
  const reqBody = new TextEncoder().encode(
    JSON.stringify({ walletAddress, action: "trade", marketId })
  );

  try {
    const res = sendConfidentialBackendRequest(runtime, { url, method: "POST", body: reqBody });
    if (res.statusCode === 200) {
      const parsed = JSON.parse(new TextDecoder().decode(res.body)) as { allowed?: boolean };
      return parsed.allowed !== false;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    runtime.log(`[agent-analysis] compliance check error: ${msg}; defaulting to allow`);
  }
  return true;
}

async function chargeX402IfEnabled(runtime: Runtime<WorkflowConfig>, label: string): Promise<void> {
  if (!runtime.config.x402Enabled) return;
  const backendUrl = runtime.config.backendUrl?.trim() ?? "";
  if (!backendUrl) return;
  const url = `${backendUrl.replace(/\/$/, "")}/api/internal/cre/x402-charge`;
  const body = new TextEncoder().encode(JSON.stringify({ workflow: label, amount: "0.0001" }));
  sendConfidentialBackendRequest(runtime, { url, method: "POST", body });
  runtime.log(`[x402] charge dispatched workflow=${label}`);
}

async function runBatch(runtime: Runtime<WorkflowConfig>): Promise<AnalysisBatchResult> {
  const config = runtime.config;
  if (!config.backendUrl?.trim()) {
    runtime.log("[agent-analysis] config.backendUrl not set; skip.");
    return { status: "ok", processed: 0, ordered: 0, total: 0, skipped: true };
  }
  await chargeX402IfEnabled(runtime, "agentAnalysis");

  const pairs = fetchEnqueuedPairs(runtime);
  if (pairs.length === 0) {
    runtime.log("[agent-analysis] No enqueued pairs.");
    return { status: "ok", processed: 0, ordered: 0, total: 0, skipped: false };
  }

  runtime.log(`[agent-analysis] Processing ${pairs.length} agent+market pair(s).`);
  let processed = 0;
  let ordered = 0;

  for (const pair of pairs) {
    if (!pair.agentId || !pair.marketId) continue;
    try {
      const walletAddress = pair.agentId;
      if (!checkComplianceForPair(runtime, walletAddress, pair.marketId)) {
        runtime.log(`[agent-analysis] compliance_blocked agentId=${pair.agentId}`);
        postAnalysisComplete(runtime, pair.agentId, pair.marketId, "skip", false);
        continue;
      }

      const decision = requestLlmAnalysis(runtime, pair.agentId, pair.marketId);
      if (!decision) continue;

      const submitted = submitOrderDecision(runtime, pair.agentId, pair.marketId, decision);
      postAnalysisComplete(runtime, pair.agentId, pair.marketId, decision.action, submitted);

      processed++;
      if (submitted) ordered++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      runtime.log(
        `[agent-analysis] pair agentId=${pair.agentId} marketId=${pair.marketId} error: ${msg}`
      );
    }
  }

  runtime.log(
    `[agent-analysis] Done. processed=${processed}/${pairs.length} ordered=${ordered}`
  );
  return { status: "ok", processed, ordered, total: pairs.length, skipped: false };
}

export async function handleAgentAnalysisCron(
  runtime: Runtime<WorkflowConfig>
): Promise<string> {
  const result = await runBatch(runtime);
  return JSON.stringify(result);
}

export async function handleAgentAnalysisHttp(
  runtime: Runtime<WorkflowConfig>,
  body: Record<string, unknown>
): Promise<Record<string, string>> {
  const action = body.action as string | undefined;

  if (action === "agentAnalysisBatch" || action === "runBatch") {
    const result = await runBatch(runtime);
    return {
      status: result.status,
      action: "agentAnalysisBatch",
      processed: String(result.processed),
      ordered: String(result.ordered),
      total: String(result.total),
    };
  }

  if (action === "agentAnalysis") {
    const agentId = typeof body.agentId === "string" ? body.agentId : "";
    const marketId = typeof body.marketId === "string" ? body.marketId : "";
    if (!agentId || !marketId) throw new Error("agentAnalysis requires agentId and marketId");

    const decision = requestLlmAnalysis(runtime, agentId, marketId);
    if (!decision) return { status: "error", action: "agentAnalysis", message: "analysis request failed" };

    const submitted = submitOrderDecision(runtime, agentId, marketId, decision);
    postAnalysisComplete(runtime, agentId, marketId, decision.action, submitted);

    return {
      status: "ok",
      action: "agentAnalysis",
      decisionAction: decision.action,
      orderSubmitted: String(submitted),
      reason: decision.reason ?? "",
    };
  }

  throw new Error("HTTP action must be one of: agentAnalysis, agentAnalysisBatch");
}
