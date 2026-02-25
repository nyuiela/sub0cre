/**
 * Sub0 CRE workflows: agent (quote/order), LMSR pricing, create agent key, platform (create market, seed), settlement.
 *
 * SIMULATE: Depends on trigger. Cron simulate runs settlement for due markets (backendUrl + agentSettlementReceiver required).
 * HTTP simulate requires body.action + action-specific payload; no automatic AI market creation unless you send action "createMarketsFromBackend".
 *
 * HTTP actions:
 * - createMarketsFromBackend: Fetches AI-generated markets from backend, creates each on-chain via Sub0, then POSTs to backend
 *   /api/internal/markets/onchain-created (stores market in DB). This is the flow that triggers AI market creation + DB storage.
 * - runSettlement: Body { marketId, questionId }. Runs backend deliberation, writes resolution to AgentSettlementReceiver, then
 *   POSTs /api/internal/settlement/resolved so backend sets market status to CLOSED.
 * - quote | order | lmsrPricing | createAgentKey | createMarket | getMarket | seed: see below.
 *
 * Cron: Fetches GET /api/internal/settlement/due, then for each market runs runSettlement (deliberation + writeReport + resolved).
 *
 * - quote | order: Signed LMSR quote for PredictionVault.executeTrade.
 * - createMarket: Sub0.create(Market). getMarket, seed: read market / seed liquidity.
 *
 * HTTP trigger: require body.apiKey when secret HTTP_API_KEY (namespace sub0) is set.
 */

import { CronCapability, HTTPCapability, handler, Runner, type Runtime } from "@chainlink/cre-sdk";
import type { WorkflowConfig } from "./types/config";
import { verifyApiKey } from "./lib/httpMiddleware";
import { handleQuoteSigning } from "./workflows/quoteSigning";
import { handleLmsrPricing } from "./workflows/lmsrPricing";
import { handleCreateAgentKey } from "./workflows/createAgentKey";
import { handleCreateMarket, handleGetMarket, handleSeedLiquidity, handlePlatformCron } from "./workflows/platformActions";
import { handleCreateMarketsFromBackend } from "./workflows/createMarketsFromBackend";
import { handleRunSettlement } from "./workflows/runSettlement";

const onCronTrigger = async (runtime: Runtime<WorkflowConfig>): Promise<string> => {
  return handlePlatformCron(runtime);
};

type HttpResult = Record<string, string>;

const onHTTPTrigger = async (
  runtime: Runtime<WorkflowConfig>,
  payload: { input: Uint8Array }
): Promise<HttpResult> => {
  const body = (() => {
    try {
      const text = new TextDecoder().decode(payload.input);
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();

  verifyApiKey(runtime, body);

  const action = body.action as string | undefined;
  if (action === "quote" || action === "order") {
    const signed = (await handleQuoteSigning(runtime, payload)) as Record<string, string>;
    return signed;
  }
  if (action === "lmsrPricing") {
    return { ...(await handleLmsrPricing(runtime, payload)) };
  }
  if (action === "createAgentKey") {
    return { ...handleCreateAgentKey(runtime, payload) };
  }
  if (action === "createMarket") {
    return await handleCreateMarket(runtime, payload);
  }
  if (action === "getMarket") {
    return await handleGetMarket(runtime, payload);
  }
  if (action === "seed") {
    return handleSeedLiquidity(runtime, payload);
  }
  if (action === "createMarketsFromBackend") {
    return await handleCreateMarketsFromBackend(runtime);
  }
  if (action === "runSettlement") {
    return await handleRunSettlement(runtime, payload);
  }

  runtime.log("HTTP action must be 'quote', 'order', 'lmsrPricing', 'createAgentKey', 'createMarket', 'seed', 'getMarket', 'createMarketsFromBackend', or 'runSettlement'.");
  throw new Error("Missing or invalid body.action: use 'quote', 'order', 'lmsrPricing', 'createAgentKey', 'createMarket', 'seed', 'getMarket', 'createMarketsFromBackend', or 'runSettlement'");
};

const initWorkflow = (config: WorkflowConfig) => {
  const cron = new CronCapability();
  const http = new HTTPCapability();

  return [
    handler(cron.trigger({ schedule: config.schedule }), onCronTrigger),
    handler(http.trigger({}), onHTTPTrigger),
  ];
};

export async function main() {
  const runner = await Runner.newRunner<WorkflowConfig>();
  await runner.run(initWorkflow);
}
