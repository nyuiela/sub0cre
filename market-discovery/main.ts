/**
 * market-discovery: autonomous CRE workflow that fetches pending agent-proposed markets from the
 * backend, creates them on-chain via PredictionVault, and notifies the backend cache.
 *
 * Replaces: sub0server trigger-all.service.ts discovery loop + cre-market-cron.ts cron.
 *
 * Trigger: Cron (configurable schedule, default every 5 min).
 * HTTP trigger also supported for manual runs (action: "run" | "status").
 *
 * Steps:
 *   1. Fetch draft markets from backend (/api/cre/agent-markets).
 *   2. For each draft: call existing markets/main.ts createMarketsFromBackend action.
 *   3. POST /api/internal/registry-sync with { markets: [{ marketId, txHash, questionId }] }.
 */

import { CronCapability, HTTPCapability, handler, Runner, type Runtime } from "@chainlink/cre-sdk";
import { marketDiscoveryConfigSchema } from "./lib/configSchema";
import { verifyApiKey } from "./lib/httpMiddleware";
import { sendBackendRequest } from "./lib/confidentialHttp";
import type { MarketDiscoveryConfig } from "./types/config";

const AGENT_MARKETS_PATH = "/api/cre/agent-markets";
const REGISTRY_SYNC_PATH = "/api/internal/registry-sync";
const ONCHAIN_CREATED_PATH = "/api/cre/markets/onchain-created";

interface DraftMarket {
  marketId: string;
  question?: string;
  outcomes?: string[];
  endTime?: number;
  resolver?: string;
}

function fetchDraftMarkets(
  runtime: Runtime<MarketDiscoveryConfig>
): DraftMarket[] {
  const config = runtime.config;
  const base = config.backendUrl.replace(/\/$/, "");
  const url = `${base}${AGENT_MARKETS_PATH}?limit=${config.maxMarketsPerRun ?? 10}`;

  runtime.log(`[discovery] Fetching draft markets from ${url}`);
  const res = sendBackendRequest(runtime, { url, method: "GET", noAuth: true });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    const bodyText = new TextDecoder().decode(res.body);
    throw new Error(`Failed to fetch draft markets: ${res.statusCode} ${bodyText.slice(0, 200)}`);
  }

  const parsed = JSON.parse(new TextDecoder().decode(res.body)) as unknown;
  if (!Array.isArray(parsed)) {
    runtime.log("[discovery] No draft markets returned (empty array or unexpected shape).");
    return [];
  }
  return parsed as DraftMarket[];
}

function postOnchainCreated(
  runtime: Runtime<MarketDiscoveryConfig>,
  results: Array<{ marketId: string; questionId?: string; txHash?: string }>
): void {
  const config = runtime.config;
  const base = config.backendUrl.replace(/\/$/, "");
  const url = `${base}${ONCHAIN_CREATED_PATH}`;

  const body = new TextEncoder().encode(JSON.stringify({ markets: results }));
  runtime.log(`[discovery] Notifying backend onchain-created for ${results.length} markets.`);
  const res = sendBackendRequest(runtime, { url, method: "POST", body });
  if (res.statusCode >= 200 && res.statusCode < 300) {
    runtime.log("[discovery] onchain-created callback succeeded.");
  } else {
    runtime.log(`[discovery] onchain-created callback returned ${res.statusCode}; cache may be stale.`);
  }
}

function postRegistrySync(
  runtime: Runtime<MarketDiscoveryConfig>,
  markets: Array<{ marketId: string; questionId?: string; txHash?: string }>
): void {
  const config = runtime.config;
  const base = config.backendUrl.replace(/\/$/, "");
  const url = `${base}${REGISTRY_SYNC_PATH}`;
  const body = new TextEncoder().encode(JSON.stringify({ markets, source: "market-discovery" }));

  runtime.log(`[discovery] Posting registry-sync for ${markets.length} markets.`);
  const res = sendBackendRequest(runtime, { url, method: "POST", body });
  if (res.statusCode >= 200 && res.statusCode < 300) {
    runtime.log("[discovery] registry-sync succeeded.");
  } else {
    runtime.log(`[discovery] registry-sync returned ${res.statusCode}.`);
  }
}

async function runDiscovery(runtime: Runtime<MarketDiscoveryConfig>): Promise<string> {
  runtime.log("[market-discovery] Cron triggered. Starting discovery run.");

  let drafts: DraftMarket[];
  try {
    drafts = fetchDraftMarkets(runtime);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    runtime.log(`[discovery] fetchDraftMarkets error: ${msg}`);
    return JSON.stringify({ status: "error", step: "fetchDraftMarkets", message: msg });
  }

  if (drafts.length === 0) {
    runtime.log("[discovery] No draft markets to create. Done.");
    return JSON.stringify({ status: "ok", created: 0 });
  }

  runtime.log(`[discovery] ${drafts.length} draft markets to process.`);

  const created: Array<{ marketId: string; questionId?: string; txHash?: string }> = [];

  for (const draft of drafts) {
    try {
      runtime.log(`[discovery] Processing marketId=${draft.marketId}`);

      const callPayload = {
        action: "createMarketsFromBackend",
        markets: [draft],
        broadcast: true,
      };
      const config = runtime.config;
      const base = config.backendUrl.replace(/\/$/, "");
      const creHttpUrl = `${base}/api/cre/trigger`;

      const body = new TextEncoder().encode(JSON.stringify(callPayload));
      const res = sendBackendRequest(runtime, { url: creHttpUrl, method: "POST", body });

      if (res.statusCode >= 200 && res.statusCode < 300) {
        const resultText = new TextDecoder().decode(res.body);
        const parsed = JSON.parse(resultText) as Record<string, unknown>;
        created.push({
          marketId: draft.marketId,
          questionId: typeof parsed.questionId === "string" ? parsed.questionId : undefined,
          txHash: typeof parsed.txHash === "string" ? parsed.txHash : undefined,
        });
        runtime.log(`[discovery] marketId=${draft.marketId} created on-chain.`);
      } else {
        runtime.log(`[discovery] marketId=${draft.marketId} creation returned ${res.statusCode}; skipping.`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      runtime.log(`[discovery] marketId=${draft.marketId} error: ${msg}`);
    }
  }

  if (created.length > 0) {
    postOnchainCreated(runtime, created);
    postRegistrySync(runtime, created);
  }

  runtime.log(`[market-discovery] Done. created=${created.length}/${drafts.length}`);
  return JSON.stringify({ status: "ok", created: created.length, total: drafts.length });
}

const onCronTrigger = async (runtime: Runtime<MarketDiscoveryConfig>): Promise<string> => {
  return runDiscovery(runtime);
};

const onHTTPTrigger = async (
  runtime: Runtime<MarketDiscoveryConfig>,
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
  if (action === "run") {
    const result = await runDiscovery(runtime);
    return { status: "ok", result };
  }
  if (action === "status") {
    return { status: "ok", workflow: "market-discovery", schedule: runtime.config.schedule };
  }

  throw new Error("HTTP action must be one of: run, status");
};

const initWorkflow = (
  config: MarketDiscoveryConfig,
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
  const runner = await Runner.newRunner<MarketDiscoveryConfig>({
    configSchema: marketDiscoveryConfigSchema as never,
  });
  await runner.run(initWorkflow);
}
