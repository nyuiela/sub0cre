/**
 * agent-analysis: autonomous CRE workflow that fetches active agent+market pairs from the backend,
 * requests LLM trading decisions via confidential HTTP, and submits orders to the backend.
 *
 * Replaces: sub0server agent-worker.ts BullMQ consumer + agent-trading-analysis.service.ts local LLM calls.
 *
 * Triggers:
 *   - Cron: runs every 15 min to process all active agent+market pairs.
 *   - HTTP: action "runAnalysis" for single agent/market pair, "status" for health check.
 *
 * Steps per agent+market pair:
 *   1. Fetch enqueued markets for agent from backend (/api/internal/cre/enqueued-markets).
 *   2. For each market: fetch market context + agent context from backend.
 *   3. Request LLM trading decision via confidential HTTP (/api/internal/cre/analyze).
 *   4. POST order to /api/orders with the decision (if action is buy/sell).
 *   5. POST /api/internal/analysis-complete with result.
 */

import { CronCapability, HTTPCapability, handler, Runner, type Runtime } from "@chainlink/cre-sdk";
import { agentAnalysisConfigSchema } from "./lib/configSchema";
import { verifyApiKey } from "./lib/httpMiddleware";
import { sendBackendRequest } from "./lib/confidentialHttp";
import type { AgentAnalysisConfig } from "./types/config";

const ENQUEUED_MARKETS_PATH = "/api/internal/cre/enqueued-markets";
const ANALYZE_PATH = "/api/internal/cre/analyze";
const ORDERS_PATH = "/api/orders";
const ANALYSIS_COMPLETE_PATH = "/api/internal/analysis-complete";

interface EnqueuedAgentMarket {
  agentId: string;
  marketId: string;
  chainKey: string;
}

interface AnalysisResult {
  action: "skip" | "buy" | "sell";
  outcomeIndex?: number;
  quantity?: string;
  reason?: string;
}

function fetchEnqueuedMarkets(
  runtime: Runtime<AgentAnalysisConfig>
): EnqueuedAgentMarket[] {
  const config = runtime.config;
  const base = config.backendUrl.replace(/\/$/, "");
  const limit = config.maxAgentsPerRun ?? 20;
  const url = `${base}${ENQUEUED_MARKETS_PATH}?limit=${limit}&chainKey=main`;

  runtime.log(`[agent-analysis] Fetching enqueued markets from ${url}`);
  const res = sendBackendRequest(runtime, { url, method: "GET" });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    const text = new TextDecoder().decode(res.body);
    throw new Error(`fetchEnqueuedMarkets failed: ${res.statusCode} ${text.slice(0, 200)}`);
  }

  const parsed = JSON.parse(new TextDecoder().decode(res.body)) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed as EnqueuedAgentMarket[];
}

function requestAnalysis(
  runtime: Runtime<AgentAnalysisConfig>,
  agentId: string,
  marketId: string
): AnalysisResult | null {
  const config = runtime.config;
  const base = config.backendUrl.replace(/\/$/, "");
  const url = `${base}${ANALYZE_PATH}`;

  const body = new TextEncoder().encode(
    JSON.stringify({
      agentId,
      marketId,
      chainKey: "main",
      geminiModel: config.geminiModel ?? "gemini-2.0-flash",
      grokModel: config.grokModel,
    })
  );

  runtime.log(`[agent-analysis] Requesting analysis: agentId=${agentId} marketId=${marketId}`);
  const res = sendBackendRequest(runtime, { url, method: "POST", body });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    const text = new TextDecoder().decode(res.body);
    runtime.log(`[agent-analysis] Analysis request failed: ${res.statusCode} ${text.slice(0, 200)}`);
    return null;
  }

  return JSON.parse(new TextDecoder().decode(res.body)) as AnalysisResult;
}

function submitOrder(
  runtime: Runtime<AgentAnalysisConfig>,
  agentId: string,
  marketId: string,
  decision: AnalysisResult
): boolean {
  if (decision.action === "skip" || decision.outcomeIndex == null || !decision.quantity) {
    runtime.log(`[agent-analysis] Skip trade: agentId=${agentId} action=${decision.action}`);
    return false;
  }

  const config = runtime.config;
  const base = config.backendUrl.replace(/\/$/, "");
  const url = `${base}${ORDERS_PATH}`;

  const orderPayload = {
    agentId,
    marketId,
    outcomeIndex: decision.outcomeIndex,
    side: decision.action === "buy" ? "BID" : "ASK",
    quantity: decision.quantity,
    orderType: "MARKET",
    chainKey: "main",
  };

  runtime.log(
    `[agent-analysis] Submitting order: agentId=${agentId} marketId=${marketId} side=${orderPayload.side}`
  );
  const body = new TextEncoder().encode(JSON.stringify(orderPayload));
  const res = sendBackendRequest(runtime, { url, method: "POST", body });

  if (res.statusCode >= 200 && res.statusCode < 300) {
    runtime.log(`[agent-analysis] Order submitted successfully.`);
    return true;
  }

  const text = new TextDecoder().decode(res.body);
  runtime.log(`[agent-analysis] Order submission failed: ${res.statusCode} ${text.slice(0, 200)}`);
  return false;
}

function postAnalysisComplete(
  runtime: Runtime<AgentAnalysisConfig>,
  agentId: string,
  marketId: string,
  action: string,
  orderSubmitted: boolean
): void {
  const config = runtime.config;
  const base = config.backendUrl.replace(/\/$/, "");
  const url = `${base}${ANALYSIS_COMPLETE_PATH}`;

  const body = new TextEncoder().encode(
    JSON.stringify({ agentId, marketId, action, orderSubmitted, source: "cre-agent-analysis" })
  );
  const res = sendBackendRequest(runtime, { url, method: "POST", body });
  if (res.statusCode >= 200 && res.statusCode < 300) {
    runtime.log(`[agent-analysis] analysis-complete posted.`);
  } else {
    runtime.log(`[agent-analysis] analysis-complete returned ${res.statusCode}.`);
  }
}

async function runAnalysisBatch(runtime: Runtime<AgentAnalysisConfig>): Promise<string> {
  runtime.log("[agent-analysis] Cron triggered. Starting analysis batch.");

  let pairs: EnqueuedAgentMarket[];
  try {
    pairs = fetchEnqueuedMarkets(runtime);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    runtime.log(`[agent-analysis] fetchEnqueuedMarkets error: ${msg}`);
    return JSON.stringify({ status: "error", step: "fetchEnqueuedMarkets", message: msg });
  }

  if (pairs.length === 0) {
    runtime.log("[agent-analysis] No enqueued markets. Done.");
    return JSON.stringify({ status: "ok", processed: 0 });
  }

  runtime.log(`[agent-analysis] ${pairs.length} agent+market pairs to process.`);

  let processed = 0;
  let ordered = 0;

  for (const pair of pairs) {
    try {
      const decision = requestAnalysis(runtime, pair.agentId, pair.marketId);
      if (!decision) continue;

      const orderSubmitted = submitOrder(runtime, pair.agentId, pair.marketId, decision);
      postAnalysisComplete(runtime, pair.agentId, pair.marketId, decision.action, orderSubmitted);

      processed++;
      if (orderSubmitted) ordered++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      runtime.log(`[agent-analysis] pair agentId=${pair.agentId} marketId=${pair.marketId} error: ${msg}`);
    }
  }

  runtime.log(`[agent-analysis] Done. processed=${processed}/${pairs.length} ordered=${ordered}`);
  return JSON.stringify({ status: "ok", processed, ordered, total: pairs.length });
}

const onCronTrigger = async (runtime: Runtime<AgentAnalysisConfig>): Promise<string> => {
  return runAnalysisBatch(runtime);
};

const onHTTPTrigger = async (
  runtime: Runtime<AgentAnalysisConfig>,
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

  if (action === "runAnalysis") {
    const agentId = typeof body.agentId === "string" ? body.agentId : "";
    const marketId = typeof body.marketId === "string" ? body.marketId : "";
    if (!agentId || !marketId) throw new Error("runAnalysis requires agentId and marketId");

    const decision = requestAnalysis(runtime, agentId, marketId);
    if (!decision) return { status: "ok", action: "error", message: "analysis request failed" };

    const orderSubmitted = submitOrder(runtime, agentId, marketId, decision);
    postAnalysisComplete(runtime, agentId, marketId, decision.action, orderSubmitted);

    return {
      status: "ok",
      action: decision.action,
      orderSubmitted: String(orderSubmitted),
      reason: decision.reason ?? "",
    };
  }

  if (action === "runBatch") {
    const result = await runAnalysisBatch(runtime);
    return { status: "ok", result };
  }

  if (action === "status") {
    return { status: "ok", workflow: "agent-analysis", schedule: runtime.config.schedule };
  }

  throw new Error("HTTP action must be one of: runAnalysis, runBatch, status");
};

const initWorkflow = (
  config: AgentAnalysisConfig,
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
  const runner = await Runner.newRunner<AgentAnalysisConfig>({
    configSchema: agentAnalysisConfigSchema as never,
  });
  await runner.run(initWorkflow);
}
