/**
 * Market discovery cron: automatically fetch draft markets from the backend and create them on-chain.
 * Replaces the trigger-all.service.ts discovery loop that was running as a BullMQ cron in the backend.
 *
 * Flow:
 *   1. Fetch agent-generated draft markets from /api/internal/agent-markets.
 *   2. Create each on-chain via PredictionVault.
 *   3. POST results to /api/internal/markets/onchain-created (or batch endpoint).
 *   4. Notify /api/internal/registry-sync so the Prisma cache stays current.
 *
 * Trigger: Cron (schedule in config). Also callable as HTTP action "marketDiscovery".
 * Limits: Creates at most MAX_DISCOVERY_PER_RUN markets per execution to stay within CRE HTTP call budget.
 */

import type { Runtime } from "@chainlink/cre-sdk";
import type { WorkflowConfig } from "../types/config";
import { sendConfidentialBackendRequest } from "../lib/confidentialHttp";
import { handleCreateMarketsFromBackend } from "./createMarketsFromBackend";

const AGENT_MARKETS_PATH = "/api/internal/agent-markets";
const REGISTRY_SYNC_PATH = "/api/internal/registry-sync";

/** Maximum markets to create per cron execution. Keeps CRE HTTP call budget within limit. */
const MAX_DISCOVERY_PER_RUN = 4;

interface DiscoveryMarketPayload {
  question: string;
  oracle: string;
  duration: number;
  outcomeSlotCount: number;
  oracleType: number;
  marketType: number;
  creatorAddress: string;
  agentSource?: string;
  amountUsdc?: string;
  marketId?: string;
}

interface DiscoveryRunResult {
  status: string;
  created: number;
  errors: number;
  skipped: boolean;
  markets: Array<{ questionId: string; createMarketTxHash: string }>;
}

function fetchDraftMarketsForDiscovery(
  runtime: Runtime<WorkflowConfig>
): DiscoveryMarketPayload[] {
  const config = runtime.config;
  const backendUrl = config.backendUrl?.trim() ?? "";
  if (!backendUrl) return [];

  const url = `${backendUrl.replace(/\/$/, "")}${AGENT_MARKETS_PATH}?count=${MAX_DISCOVERY_PER_RUN}`;
  runtime.log(`[market-discovery] Fetching draft markets from ${url}`);

  const res = sendConfidentialBackendRequest(runtime, { url, method: "GET" });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const text = new TextDecoder().decode(res.body);
    runtime.log(`[market-discovery] agent-markets failed: ${res.statusCode} ${text.slice(0, 200)}`);
    return [];
  }

  const body = new TextDecoder().decode(res.body);
  let parsed: { data?: DiscoveryMarketPayload[] };
  try {
    parsed = JSON.parse(body) as { data?: DiscoveryMarketPayload[] };
  } catch {
    runtime.log("[market-discovery] agent-markets response is not valid JSON");
    return [];
  }

  return Array.isArray(parsed?.data) ? parsed.data : [];
}

function notifyRegistrySync(
  runtime: Runtime<WorkflowConfig>,
  markets: Array<{ questionId: string; createMarketTxHash: string }>
): void {
  if (markets.length === 0) return;

  const config = runtime.config;
  const backendUrl = config.backendUrl?.trim() ?? "";
  if (!backendUrl) return;

  const url = `${backendUrl.replace(/\/$/, "")}${REGISTRY_SYNC_PATH}`;
  const syncPayload = {
    markets: markets.map((m) => ({
      marketId: "",
      questionId: m.questionId,
      txHash: m.createMarketTxHash,
      workflowRunId: "market-discovery-cron",
    })),
    source: "market-discovery",
  };

  const body = new TextEncoder().encode(JSON.stringify(syncPayload));
  runtime.log(`[market-discovery] Notifying registry-sync for ${markets.length} market(s).`);

  const res = sendConfidentialBackendRequest(runtime, {
    url,
    method: "POST",
    body,
  });
  if (res.statusCode >= 200 && res.statusCode < 300) {
    runtime.log("[market-discovery] Registry-sync notified.");
  } else {
    runtime.log(`[market-discovery] Registry-sync returned ${res.statusCode}.`);
  }
}

export async function handleMarketDiscoveryCron(
  runtime: Runtime<WorkflowConfig>
): Promise<DiscoveryRunResult> {
  const config = runtime.config;
  if (!config.backendUrl?.trim()) {
    runtime.log("[market-discovery] config.backendUrl not set; skip.");
    return { status: "ok", created: 0, errors: 0, skipped: true, markets: [] };
  }
  if (!config.contracts) {
    runtime.log("[market-discovery] config.contracts not set; skip.");
    return { status: "ok", created: 0, errors: 0, skipped: true, markets: [] };
  }

  if (config.x402Enabled) {
    const x402Url = `${config.backendUrl.replace(/\/$/, "")}/api/internal/cre/x402-charge`;
    const x402Body = new TextEncoder().encode(JSON.stringify({ workflow: "marketDiscovery", amount: "0.0001" }));
    sendConfidentialBackendRequest(runtime, { url: x402Url, method: "POST", body: x402Body });
    runtime.log("[x402] charge dispatched workflow=marketDiscovery");
  }

  const drafts = fetchDraftMarketsForDiscovery(runtime);
  if (drafts.length === 0) {
    runtime.log("[market-discovery] No draft markets to discover.");
    return { status: "ok", created: 0, errors: 0, skipped: false, markets: [] };
  }

  runtime.log(`[market-discovery] Creating ${drafts.length} draft market(s) on-chain.`);

  const createResult = await handleCreateMarketsFromBackend(runtime, {
    markets: drafts.map((draft) => ({
      question: draft.question,
      oracle: draft.oracle,
      duration: draft.duration,
      outcomeSlotCount: draft.outcomeSlotCount,
      oracleType: draft.oracleType,
      marketType: draft.marketType,
      creatorAddress: draft.creatorAddress,
    })),
  });

  const created = Number(createResult.created ?? "0");
  const errors = Number(createResult.errors ?? "0");
  const resultMarkets = Array.isArray(createResult.markets)
    ? (createResult.markets as Array<{ questionId: string; createMarketTxHash: string }>)
    : [];

  if (resultMarkets.length > 0) {
    notifyRegistrySync(runtime, resultMarkets);
  }

  runtime.log(
    `[market-discovery] Done. created=${created} errors=${errors} total=${drafts.length}`
  );
  return { status: "ok", created, errors, skipped: false, markets: resultMarkets };
}

export async function handleMarketDiscoveryHttp(
  runtime: Runtime<WorkflowConfig>,
  payload: { input: Uint8Array }
): Promise<Record<string, string>> {
  const body = (() => {
    try {
      return JSON.parse(new TextDecoder().decode(payload.input)) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();

  const dryRun = body.dryRun === true;
  if (dryRun) {
    const drafts = fetchDraftMarketsForDiscovery(runtime);
    return {
      status: "ok",
      action: "marketDiscovery",
      dryRun: "true",
      found: String(drafts.length),
    };
  }

  const result = await handleMarketDiscoveryCron(runtime);
  return {
    status: result.status,
    action: "marketDiscovery",
    created: String(result.created),
    errors: String(result.errors),
    skipped: String(result.skipped),
    markets: JSON.stringify(result.markets),
  };
}
