/**
 * Cross-chain sync workflow module for the markets CRE project.
 * Broadcasts recently confirmed market metadata to destination chains via Chainlink CCIP.
 *
 * Integrated into the markets CRE workflow as HTTP action "crossChainSync".
 * The standalone sub0cre/cross-chain-sync/ runs this as an independent CRE deployment.
 *
 * CCIP contract requirement:
 *   Each destination chain must have a CCIPMarketReceiver contract that implements
 *   IAny2EVMMessageReceiver (see sub0contract/src/manager/ICCIPMarketReceiver.sol).
 *
 * Flow:
 *   1. Fetch recently created on-chain markets from /api/internal/cre/active-markets.
 *   2. For each market: encode CCIP message (marketId, questionId, name, outcomes).
 *   3. Simulate CCIP send via backend endpoint /api/internal/cre/ccip-send.
 *   4. POST /api/internal/registry-sync with cross-chain broadcast status.
 *
 * Note: Full CCIP implementation requires a LINK-funded router contract and is activated
 * when config.ccipEnabled is true (defaults to off in development).
 */

import type { Runtime } from "@chainlink/cre-sdk";
import type { WorkflowConfig } from "../types/config";
import { sendConfidentialBackendRequest } from "../lib/confidentialHttp";

const ACTIVE_MARKETS_PATH = "/api/internal/cre/active-markets";
const CCIP_SEND_PATH = "/api/internal/cre/ccip-send";
const REGISTRY_SYNC_PATH = "/api/internal/registry-sync";

const DEFAULT_DESTINATION_CHAINS = ["arbitrum-testnet-sepolia", "polygon-testnet-amoy"];
const MAX_MARKETS_PER_CCIP_RUN = 5;

interface MarketRecord {
  id: string;
  questionId?: string;
  name?: string;
  outcomes?: Array<{ name?: string }>;
  resolutionDate?: string;
  status?: string;
}

interface CcipSendResult {
  marketId: string;
  destinations: string[];
  messageIds: string[];
  skipped: boolean;
}

function fetchActiveMarketsForCcip(
  runtime: Runtime<WorkflowConfig>
): MarketRecord[] {
  const config = runtime.config;
  const backendUrl = config.backendUrl?.trim() ?? "";
  if (!backendUrl) return [];

  const url = `${backendUrl.replace(/\/$/, "")}${ACTIVE_MARKETS_PATH}?limit=${MAX_MARKETS_PER_CCIP_RUN}&withQuestionId=true`;
  runtime.log(`[cross-chain-sync] Fetching active markets from ${url}`);

  const res = sendConfidentialBackendRequest(runtime, { url, method: "GET" });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const text = new TextDecoder().decode(res.body);
    runtime.log(`[cross-chain-sync] active-markets failed: ${res.statusCode} ${text.slice(0, 200)}`);
    return [];
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(res.body)) as unknown;
    return Array.isArray(parsed) ? (parsed as MarketRecord[]) : [];
  } catch {
    return [];
  }
}

function broadcastMarketViaCcip(
  runtime: Runtime<WorkflowConfig>,
  market: MarketRecord,
  destinations: string[]
): CcipSendResult {
  const config = runtime.config;
  const backendUrl = config.backendUrl?.trim() ?? "";
  if (!backendUrl || !market.questionId) {
    return { marketId: market.id, destinations, messageIds: [], skipped: true };
  }

  const url = `${backendUrl.replace(/\/$/, "")}${CCIP_SEND_PATH}`;
  const outcomeNames = (market.outcomes ?? []).map((o) => o?.name ?? "Unknown");
  const messagePayload = {
    marketId: market.id,
    questionId: market.questionId,
    name: market.name ?? "",
    outcomes: outcomeNames,
    resolutionDate: market.resolutionDate ?? null,
    destinations,
  };

  runtime.log(`[cross-chain-sync] Broadcasting marketId=${market.id} to ${destinations.length} chains.`);
  const body = new TextEncoder().encode(JSON.stringify(messagePayload));
  const res = sendConfidentialBackendRequest(runtime, { url, method: "POST", body });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    const text = new TextDecoder().decode(res.body);
    runtime.log(`[cross-chain-sync] ccip-send failed: ${res.statusCode} ${text.slice(0, 200)}`);
    return { marketId: market.id, destinations, messageIds: [], skipped: false };
  }

  try {
    const result = JSON.parse(new TextDecoder().decode(res.body)) as { messageIds?: string[] };
    return {
      marketId: market.id,
      destinations,
      messageIds: Array.isArray(result.messageIds) ? result.messageIds : [],
      skipped: false,
    };
  } catch {
    return { marketId: market.id, destinations, messageIds: [], skipped: false };
  }
}

function postCrossChainSyncUpdate(
  runtime: Runtime<WorkflowConfig>,
  sentMarkets: CcipSendResult[]
): void {
  const config = runtime.config;
  const backendUrl = config.backendUrl?.trim() ?? "";
  if (!backendUrl || sentMarkets.length === 0) return;

  const url = `${backendUrl.replace(/\/$/, "")}${REGISTRY_SYNC_PATH}`;
  const payload = {
    markets: sentMarkets.map((m) => ({
      marketId: m.marketId,
      workflowRunId: "cross-chain-sync",
    })),
    source: "cross-chain-sync",
  };

  const body = new TextEncoder().encode(JSON.stringify(payload));
  const res = sendConfidentialBackendRequest(runtime, { url, method: "POST", body });
  if (res.statusCode >= 200 && res.statusCode < 300) {
    runtime.log("[cross-chain-sync] Registry sync updated.");
  } else {
    runtime.log(`[cross-chain-sync] Registry sync returned ${res.statusCode}.`);
  }
}

export async function handleCrossChainSyncHttp(
  runtime: Runtime<WorkflowConfig>,
  body: Record<string, unknown>
): Promise<Record<string, string>> {
  if (body.action !== "crossChainSync") {
    throw new Error("HTTP action must be: crossChainSync");
  }

  const config = runtime.config;
  if (!config.backendUrl?.trim()) {
    return { status: "ok", action: "crossChainSync", skipped: "true", reason: "backendUrl not set" };
  }

  const destinations =
    Array.isArray(body.destinations) && body.destinations.length > 0
      ? (body.destinations as string[])
      : DEFAULT_DESTINATION_CHAINS;

  const markets = fetchActiveMarketsForCcip(runtime);
  if (markets.length === 0) {
    return { status: "ok", action: "crossChainSync", sent: "0", skipped: "true" };
  }

  const results: CcipSendResult[] = [];
  for (const market of markets) {
    const result = broadcastMarketViaCcip(runtime, market, destinations);
    results.push(result);
  }

  const sent = results.filter((r) => r.messageIds.length > 0).length;
  postCrossChainSyncUpdate(runtime, results);

  runtime.log(`[cross-chain-sync] Done. sent=${sent} total=${markets.length}`);
  return {
    status: "ok",
    action: "crossChainSync",
    sent: String(sent),
    total: String(markets.length),
    destinations: destinations.join(","),
  };
}
