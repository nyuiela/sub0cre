/**
 * Sub0 CRE workflows: agent (quote/order), LMSR pricing, create agent key, platform (create market, seed).
 *
 * HTTP trigger: require body.apiKey when secret HTTP_API_KEY (namespace sub0) is set.
 *
 * - quote | order: Signed LMSR quote for PredictionVault.executeTrade (sync EIP-712 sign).
 * - lmsrPricing: DON computes LMSR cost from on-chain q, signs quote (dual-signature relayer).
 * - createAgentKey: Generate agent wallet in enclave (sync, no ethers), return address only.
 * - createMarket: Sub0.create(Market). Optional amountUsdc + creatorAddress run seed workflow after create.
 * - getMarket: Read market by questionId (payload.questionId). Returns market fields.
 * - seed: PredictionVault.seedMarketLiquidity(questionId, amountUsdc).
 *
 * executeConfidentialTrade remains standalone (async signing); use executeConfidentialTrade.ts.
 *
 * Triggers: Cron (schedule), HTTP (action: quote | order | lmsrPricing | createAgentKey | createMarket | getMarket | seed).
 */

import { CronCapability, HTTPCapability, handler, Runner, type Runtime } from "@chainlink/cre-sdk";
import type { WorkflowConfig } from "./types/config";
import { verifyApiKey } from "./lib/httpMiddleware";
import { handleQuoteSigning } from "./workflows/quoteSigning";
import { handleLmsrPricing } from "./workflows/lmsrPricing";
import { handleCreateAgentKey } from "./workflows/createAgentKey";
import { handleCreateMarket, handleGetMarket, handleSeedLiquidity, handlePlatformCron } from "./workflows/platformActions";

const onCronTrigger = (runtime: Runtime<WorkflowConfig>): string => {
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

  runtime.log("HTTP action must be 'quote', 'order', 'lmsrPricing', 'createAgentKey', 'createMarket', 'getMarket', or 'seed'.");
  throw new Error("Missing or invalid body.action: use 'quote', 'order', 'lmsrPricing', 'createAgentKey', 'createMarket', 'getMarket', or 'seed'");
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
