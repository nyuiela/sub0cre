/**
 * Sub0 CRE workflows: agent (quote/order), LMSR pricing, create agent key, platform (create market, seed).
 *
 * HTTP trigger: require body.apiKey when secret HTTP_API_KEY (namespace sub0) is set.
 *
 * - quote | order: Signed LMSR quote for PredictionVault.executeTrade (sync EIP-712 sign).
 * - lmsrPricing: DON computes LMSR cost from on-chain q, signs quote (dual-signature relayer).
 * - createAgentKey: Generate agent wallet in enclave (sync, no ethers), return address only.
 * - createMarket: Sub0 CRE 0x00. getMarket: read by questionId.
 * - seed: PredictionVault CRE 0x01. resolveMarket, stake, redeem: Sub0 CRE 0x01–0x03.
 * - approveErc20, approveConditionalToken: sign with agent or backend key; return signed tx for broadcast.
 * - createMarketsFromBackend: fetch agent markets from backend, create on-chain, POST onchain-created.
 * - runSettlement: body { marketId, questionId }; deliberation + writeReport + POST resolved.
 *
 * When config.backendUrl is set, quote, order, buy, sell, lmsrPricing, stake, redeem, and
 * executeConfidentialTrade POST their result to backend /api/cre/<action> (e.g. /api/cre/quote).
 *
 * Triggers: Cron (schedule), HTTP (action: quote | order | buy | sell | lmsrPricing | createAgentKey | createMarket | getMarket | seed | resolveMarket | stake | redeem | approveErc20 | approveConditionalToken | createMarketsFromBackend | runSettlement | executeConfidentialTrade).
 */

import { CronCapability, HTTPCapability, handler, Runner, ConfidentialHTTPClient, type Runtime } from "@chainlink/cre-sdk";
import type { WorkflowConfig } from "./types/config";
import { workflowConfigSchema } from "./lib/configSchema";
import { verifyApiKey } from "./lib/httpMiddleware";
import { handleQuoteSigning } from "./workflows/quoteSigning";
import { handleLmsrPricing } from "./workflows/lmsrPricing";
import { handleCreateAgentKey } from "./workflows/createAgentKey";
import {
  handleCreateMarket,
  handleGetMarket,
  handleSeedLiquidity,
  handleResolveMarket,
  handleStake,
  handleRedeem,
  handlePlatformCron,
} from "./workflows/platformActions";
import { handleApproveErc20, handleApproveConditionalToken } from "./workflows/approveWorkflows";
import { handleCreateMarketsFromBackend } from "./workflows/createMarketsFromBackend";
import { handleRunSettlement } from "./workflows/runSettlement";
import { handleExecuteConfidentialTrade } from "./workflows/executeConfidentialTrade";
import { postCreResultToBackend } from "./lib/creBackendPost";

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
  const client = new ConfidentialHTTPClient();
  const config = runtime.config;

  verifyApiKey(runtime, body);

  const action = body.action as string | undefined;
  if (action === "quote" || action === "order") {
    const signed = (await handleQuoteSigning(runtime, payload)) as unknown as Record<string, string>;
    postCreResultToBackend(runtime, client, config, "/api/cre/quote", signed);
    return signed;
  }
  if (action === "buy") {
    const buyPayload = { input: new TextEncoder().encode(JSON.stringify({ ...body, buy: true })) };
    const signed = (await handleQuoteSigning(runtime, buyPayload)) as unknown as Record<string, string>;
    postCreResultToBackend(runtime, client, config, "/api/cre/buy", signed);
    return signed;
  }
  if (action === "sell") {
    const sellPayload = { input: new TextEncoder().encode(JSON.stringify({ ...body, buy: false })) };
    const signed = (await handleQuoteSigning(runtime, sellPayload)) as unknown as Record<string, string>;
    postCreResultToBackend(runtime, client, config, "/api/cre/sell", signed);
    return signed;
  }
  if (action === "lmsrPricing") {
    const result = await handleLmsrPricing(runtime, payload);
    postCreResultToBackend(runtime, client, config, "/api/cre/lmsr-pricing", result);
    return { ...result };
  }
  if (action === "createAgentKey") {
    return { ...(await handleCreateAgentKey(runtime, client, payload)) };
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
  if (action === "resolveMarket") {
    return handleResolveMarket(runtime, payload);
  }
  if (action === "stake") {
    const result = handleStake(runtime, payload);
    postCreResultToBackend(runtime, client, config, "/api/cre/stake", result);
    return result;
  }
  if (action === "redeem") {
    const result = handleRedeem(runtime, payload);
    postCreResultToBackend(runtime, client, config, "/api/cre/redeem", result);
    return result;
  }
  if (action === "executeConfidentialTrade" || action === "execute-confidential-trade") {
    const result = await handleExecuteConfidentialTrade(runtime, payload);
    postCreResultToBackend(runtime, client, config, "/api/cre/execute-confidential-trade", result);
    return { ...result };
  }
  if (action === "approveErc20") {
    return (await handleApproveErc20(runtime, payload)) as unknown as HttpResult;
  }
  if (action === "approveConditionalToken") {
    return (await handleApproveConditionalToken(runtime, payload)) as unknown as HttpResult;
  }
  if (action === "createMarketsFromBackend") {
    const createPayload = {
      action: typeof body.action === "string" ? body.action : undefined,
      apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
      markets: Array.isArray(body.markets) ? body.markets : undefined,
    };
    return (await handleCreateMarketsFromBackend(runtime, createPayload)) as unknown as HttpResult;
  }
  if (action === "runSettlement") {
    return (await handleRunSettlement(runtime, payload)) as unknown as HttpResult;
  }

  runtime.log(
    "HTTP action must be one of: quote, order, buy, sell, lmsrPricing, createAgentKey, createMarket, getMarket, seed, resolveMarket, stake, redeem, approveErc20, approveConditionalToken, createMarketsFromBackend, runSettlement, executeConfidentialTrade."
  );
  throw new Error("Missing or invalid body.action");
};

const initWorkflow = (
  config: WorkflowConfig,
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
  const runner = await Runner.newRunner<WorkflowConfig>({
    configSchema: workflowConfigSchema as never,
  });
  await runner.run(initWorkflow);
}
