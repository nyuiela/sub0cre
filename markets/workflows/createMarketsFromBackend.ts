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
/** Max markets per run: CRE simulator allows 5 HTTP calls (1 GET + N POSTs), so N <= 4. */
const DEFAULT_COUNT = 4;

interface BackendMarketPayload {
  action?: string;
  question: string;
  oracle: string;
  duration: number;
  outcomeSlotCount: number;
  oracleType: number;
  marketType: number;
  creatorAddress: string;
  agentSource?: "gemini" | "grok";
  amountUsdc?: string;
}

/** Optional trigger payload; apiKey is sent by the backend and used for backend internal routes. */
export interface CreateMarketsFromBackendPayload {
  action?: string;
  apiKey?: string;
}

export async function handleCreateMarketsFromBackend(
  runtime: Runtime<WorkflowConfig>,
  payload?: CreateMarketsFromBackendPayload
): Promise<Record<string, string>> {
  const config = runtime.config;
  const backendUrl = config.backendUrl?.trim();
  if (!backendUrl) {
    throw new Error("createMarketsFromBackend requires config.backendUrl");
  }
  if (!config.contracts) {
    throw new Error("createMarketsFromBackend requires config.contracts");
  }

  const agentMarketsPath = config.backendAgentMarketsPath?.trim() ?? DEFAULT_AGENT_MARKETS_PATH;
  const onchainCreatedPath = config.backendOnchainCreatedPath?.trim() ?? DEFAULT_ONCHAIN_CREATED_PATH;
  const useNoAuthCrePaths = agentMarketsPath.includes("/api/cre/");
  const backendApiKey = useNoAuthCrePaths ? "" : (payload?.apiKey?.trim() ?? "");

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
  let data: BackendMarketPayload[] = [];
  try {
    const parsed = JSON.parse(getBody) as { data?: BackendMarketPayload[] };
    data = Array.isArray(parsed?.data) ? parsed.data : [];
  } catch {
    throw new Error("Backend agent-markets response is not valid JSON with data array");
  }

  if (data.length === 0) {
    runtime.log("No agent markets returned.");
    return { status: "ok", result: "createMarketsFromBackend", created: "0", errors: "0" };
  }

  runtime.log(`Creating ${data.length} markets on-chain and notifying backend.`);
  let created = 0;
  let errors = 0;
  const postUrl = `${backendUrl.replace(/\/$/, "")}${onchainCreatedPath}`;

  for (let i = 0; i < data.length; i++) {
    const payload = data[i];
    if (!payload?.question?.trim()) {
      errors++;
      continue;
    }
    try {
      const input = new TextEncoder().encode(JSON.stringify(payload));
      const result = await handleCreateMarket(runtime, { input });
      const questionId = result.questionId;
      const createMarketTxHash = result.createMarketTxHash ?? "";
      if (!questionId) {
        errors++;
        continue;
      }
      const callbackBody = {
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
      const postRes = sendConfidentialBackendRequest(runtime, {
        url: postUrl,
        method: "POST",
        body: new TextEncoder().encode(JSON.stringify(callbackBody)),
        ...(useNoAuthCrePaths ? { noAuth: true } : backendApiKey ? { apiKey: backendApiKey } : {}),
      });
      if (postRes.statusCode >= 200 && postRes.statusCode < 300) {
        created++;
      } else {
        runtime.log(`Onchain-created callback failed for ${questionId}: ${postRes.statusCode}`);
        errors++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      runtime.log(`Create market failed for "${payload.question?.slice(0, 40)}...": ${msg}`);
      errors++;
    }
  }

  return {
    status: "ok",
    result: "createMarketsFromBackend",
    created: String(created),
    errors: String(errors),
    total: String(data.length),
  };
}
