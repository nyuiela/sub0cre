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

/**
 * Delay before each createMarket (except the first) to reduce nonce/gas clashes.
 * Nonce is not controlled by us: CRE SDK's writeReport uses the signer (CRE_ETH_PRIVATE_KEY) and
 * fetches nonce from RPC internally. We cannot inject Viem createNonceManager or manual nonce here
 * because the tx is built and sent inside the CRE capability, not in our code. So we only:
 * - Space sends (INTER_CREATE_DELAY_MS) so the previous tx has time to be broadcast/mined.
 * - Optionally wait after a successful send (POST_CREATE_WAIT_MS) so the next send sees updated nonce.
 */
const INTER_CREATE_DELAY_MS = 8_000;
/** After a successful createMarket, wait this long before the next so the tx can be mined and nonce increments on chain. */
const POST_CREATE_WAIT_MS = 15_000;

/** Blocking delay; CRE workflow runtime may not have setTimeout. */
function delayMs(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin */
  }
}

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
  /** Backend market id; echoed in callback so backend can update draft by id. */
  marketId?: string;
}

/** Optional trigger payload; apiKey is sent by the backend and used for backend internal routes. When markets is set, CRE skips GET and uses one batch callback. */
export interface CreateMarketsFromBackendPayload {
  action?: string;
  apiKey?: string;
  /** When set, use these market payloads instead of fetching from backend; then POST all results in one batch callback. */
  markets?: BackendMarketPayload[];
}

/** Build callback payload for onchain-created. Create-market only; no seeding. Includes marketId when provided for draft-update flow. */
function toCallbackItem(
  payload: BackendMarketPayload,
  questionId: string,
  createMarketTxHash: string
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    questionId,
    createMarketTxHash,
    question: payload.question,
    oracle: payload.oracle,
    creatorAddress: payload.creatorAddress,
    duration: Number(payload.duration),
    outcomeSlotCount: Number(payload.outcomeSlotCount),
    oracleType: Number(payload.oracleType),
    marketType: Number(payload.marketType),
  };
  if (payload.marketId != null && payload.marketId !== "") {
    out.marketId = payload.marketId;
  }
  return out;
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
  const useBatchCallback = Array.isArray(payload?.markets) && (payload?.markets?.length ?? 0) > 0;

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
  const failedMarkets: { question: string; reason: string; index?: number }[] = [];
  let errors = 0;

  for (let i = 0; i < toCreate.length; i++) {
    if (i > 0) {
      runtime.log(`Waiting ${INTER_CREATE_DELAY_MS}ms before next create (spacing txs to avoid nonce/gas conflicts).`);
      delayMs(INTER_CREATE_DELAY_MS);
    }
    const item = toCreate[i];
    if (!item?.question?.trim()) {
      errors++;
      failedMarkets.push({
        question: (item?.question as string)?.slice(0, 80) ?? "",
        reason: "question empty or missing",
        index: i,
      });
      continue;
    }
    try {
      const input = new TextEncoder().encode(JSON.stringify(item));
      const result = await handleCreateMarket(runtime, { input });
      const questionId = result.questionId;
      const createMarketTxHash = result.createMarketTxHash ?? "";
      if (!questionId) {
        errors++;
        failedMarkets.push({
          question: String(item.question).slice(0, 80),
          reason: "no questionId in result",
          index: i,
        });
        continue;
      }
      batchResults.push(toCallbackItem(item, questionId, createMarketTxHash));
      if (i < toCreate.length - 1) {
        runtime.log(`Waiting ${POST_CREATE_WAIT_MS}ms for tx to be mined before next create.`);
        delayMs(POST_CREATE_WAIT_MS);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      runtime.log(`Create market failed for "${String(item.question).slice(0, 40)}...": ${msg}`);
      failedMarkets.push({
        question: String(item.question).slice(0, 80),
        reason: msg,
        index: i,
      });
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
    questionId: (r as { questionId?: string }).questionId ?? "",
    createMarketTxHash: (r as { createMarketTxHash?: string }).createMarketTxHash ?? "",
  }));
  if (failedMarkets.length > 0) {
    runtime.log(`Create market failures (${failedMarkets.length}): ${JSON.stringify(failedMarkets)}`);
  }
  return {
    status: "ok",
    result: "createMarketsFromBackend",
    created: String(created),
    errors: String(errors),
    total: String(data.length),
    markets: marketResults,
    failedMarkets,
  };
}
