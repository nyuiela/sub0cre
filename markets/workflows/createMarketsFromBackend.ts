/**
 * Fetches agent-generated market payloads from the backend, creates each on-chain via Sub0,
 * then calls the backend onchain-created callback with questionId, txHash, and agentSource.
 * Trigger: HTTP action "createMarketsFromBackend". When the backend sends body.apiKey (same as
 * backend API_KEY), we use it for backend requests so no vault/getSecret is required.
 */

import type { Runtime } from "@chainlink/cre-sdk";
import type { WorkflowConfig } from "../types/config";
import { sendConfidentialBackendRequest } from "../lib/confidentialHttp";
import { handleCreateMarket } from "./platformActions";

const DEFAULT_AGENT_MARKETS_PATH = "/api/internal/agent-markets";
const DEFAULT_ONCHAIN_CREATED_PATH = "/api/internal/markets/onchain-created";
/** Request count from backend when using GET (per-source: backend may return count * 2 or count * 3). */
const DEFAULT_COUNT = 4;
/** CRE PerWorkflow.HTTPAction.CallLimit is 5: 1 GET + up to 4 single callbacks. When using payload.markets we use one batch callback so no HTTP limit. */
const MAX_MARKETS_PER_RUN = 4;
/** When backend sends markets in the request body we use one batch callback; cap per run to avoid execution timeout. */
const MAX_MARKETS_PER_RUN_BATCH = 50;

interface BackendMarketPayload {
  action?: string;
  question: string;
  oracle: string;
  duration: number;
  outcomeSlotCount: number;
  oracleType: number;
  marketType: number;
  creatorAddress: string;
  agentSource?: "gemini" | "grok" | "openwebui";
  amountUsdc?: string;
}

/** Optional trigger payload; apiKey is sent by the backend and used for backend internal routes. When markets is set, CRE skips GET and uses one batch callback. */
export interface CreateMarketsFromBackendPayload {
  action?: string;
  apiKey?: string;
  /** When set, use these market payloads instead of fetching from backend; then POST all results in one batch callback. */
  markets?: BackendMarketPayload[];
}

function toCallbackItem(
  payload: BackendMarketPayload,
  questionId: string,
  createMarketTxHash: string,
  seedTxHash?: string
): Record<string, unknown> {
  const item: Record<string, unknown> = {
    questionId,
    createMarketTxHash,
    question: payload.question,
    oracle: payload.oracle,
    creatorAddress: payload.creatorAddress,
    duration: Number(payload.duration),
    outcomeSlotCount: Number(payload.outcomeSlotCount),
    oracleType: Number(payload.oracleType),
    marketType: Number(payload.marketType),
    agentSource: payload.agentSource ?? undefined,
  };
  if (seedTxHash?.trim()) item.seedTxHash = seedTxHash.trim();
  return item;
}

export async function handleCreateMarketsFromBackend(
  runtime: Runtime<WorkflowConfig>,
  payload?: CreateMarketsFromBackendPayload
): Promise<Record<string, unknown>> {
  const config = runtime.config;
  const backendUrl = config.backendUrl?.trim();
  if (!backendUrl) {
    throw new Error("createMarketsFromBackend requires config.backendUrl");
  }
  if (!config.contracts) {
    throw new Error("createMarketsFromBackend requires config.contracts");
  }

  const onchainCreatedPath = config.backendOnchainCreatedPath?.trim() ?? DEFAULT_ONCHAIN_CREATED_PATH;
  const agentMarketsPath = config.backendAgentMarketsPath?.trim() ?? DEFAULT_AGENT_MARKETS_PATH;
  const useNoAuthCrePaths = agentMarketsPath.includes("/api/cre/");
  const backendApiKey = useNoAuthCrePaths ? "" : (payload?.apiKey?.trim() ?? "");

  let data: BackendMarketPayload[] = [];
  const useBatchCallback = Array.isArray(payload?.markets) && payload.markets.length > 0;

  if (useBatchCallback) {
    data = payload!.markets!.slice(0, MAX_MARKETS_PER_RUN_BATCH);
    runtime.log(`Using ${data.length} markets from request body; will use one batch callback.`);
  } else {
    const getUrl = `${backendUrl.replace(/\/$/, "")}${agentMarketsPath}?count=${DEFAULT_COUNT}`;
    const requestOptions = {
      url: getUrl,
      method: "GET" as const,
      ...(useNoAuthCrePaths ? { noAuth: true } : backendApiKey ? { apiKey: backendApiKey } : {}),
    };
    runtime.log(useNoAuthCrePaths ? "Fetching agent markets (no-auth CRE endpoint)." : "Fetching agent markets (confidential HTTP).");
    const getRes = sendConfidentialBackendRequest(runtime, requestOptions);
    if (getRes.statusCode < 200 || getRes.statusCode >= 300) {
      const bodyText = new TextDecoder().decode(getRes.body);
      throw new Error(`Backend agent-markets failed: ${getRes.statusCode} ${bodyText}`);
    }
    const getBody = new TextDecoder().decode(getRes.body);
    try {
      const parsed = JSON.parse(getBody) as { data?: BackendMarketPayload[] };
      data = Array.isArray(parsed?.data) ? parsed.data : [];
    } catch {
      throw new Error("Backend agent-markets response is not valid JSON with data array");
    }
  }

  if (data.length === 0) {
    runtime.log("No agent markets to create.");
    return { status: "ok", result: "createMarketsFromBackend", created: "0", errors: "0" };
  }

  const toCreate = useBatchCallback ? data : data.slice(0, MAX_MARKETS_PER_RUN);
  if (!useBatchCallback && data.length > MAX_MARKETS_PER_RUN) {
    runtime.log(`CRE HTTP limit: processing ${toCreate.length} of ${data.length} markets this run.`);
  }
  runtime.log(`Creating ${toCreate.length} markets on-chain.`);
  const batchResults: Record<string, unknown>[] = [];
  let errors = 0;

  for (let i = 0; i < toCreate.length; i++) {
    const item = toCreate[i];
    if (!item?.question?.trim()) {
      errors++;
      continue;
    }
    try {
      const input = new TextEncoder().encode(JSON.stringify(item));
      const result = await handleCreateMarket(runtime, { input });
      const questionId = result.questionId;
      const createMarketTxHash = result.createMarketTxHash ?? "";
      const seedTxHash = result.seedTxHash ?? "";
      if (!questionId) {
        errors++;
        continue;
      }
      batchResults.push(toCallbackItem(item, questionId, createMarketTxHash, seedTxHash));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      runtime.log(`Create market failed for "${item.question?.slice(0, 40)}...": ${msg}`);
      errors++;
    }
  }

  if (useBatchCallback && batchResults.length > 0) {
    const batchPath = onchainCreatedPath.replace(/\/onchain-created$/, "/onchain-created-batch");
    const postUrl = `${backendUrl.replace(/\/$/, "")}${batchPath}`;
    const postRes = sendConfidentialBackendRequest(runtime, {
      url: postUrl,
      method: "POST",
      body: new TextEncoder().encode(JSON.stringify({ markets: batchResults })),
      ...(useNoAuthCrePaths ? { noAuth: true } : backendApiKey ? { apiKey: backendApiKey } : {}),
    });
    if (postRes.statusCode < 200 || postRes.statusCode >= 300) {
      const bodyText = new TextDecoder().decode(postRes.body);
      runtime.log(`Batch callback failed: ${postRes.statusCode} ${bodyText}`);
    }
  } else if (!useBatchCallback) {
    const postUrl = `${backendUrl.replace(/\/$/, "")}${onchainCreatedPath}`;
    for (const callbackBody of batchResults) {
      const postRes = sendConfidentialBackendRequest(runtime, {
        url: postUrl,
        method: "POST",
        body: new TextEncoder().encode(JSON.stringify(callbackBody)),
        ...(useNoAuthCrePaths ? { noAuth: true } : backendApiKey ? { apiKey: backendApiKey } : {}),
      });
      if (postRes.statusCode < 200 || postRes.statusCode >= 300) {
        runtime.log(`Onchain-created callback failed for ${(callbackBody as { questionId?: string }).questionId}: ${postRes.statusCode}`);
        errors++;
      }
    }
  }

  const created = batchResults.length;
  const marketResults = batchResults.map((r) => ({
    questionId: (r as { questionId?: string }).questionId,
    createMarketTxHash: (r as { createMarketTxHash?: string }).createMarketTxHash,
    seedTxHash: (r as { seedTxHash?: string }).seedTxHash ?? undefined,
  }));
  return {
    status: "ok",
    result: "createMarketsFromBackend",
    created: String(created),
    errors: String(errors),
    total: String(data.length),
    markets: marketResults,
  };
}
