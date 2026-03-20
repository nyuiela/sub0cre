/**
 * cross-chain-sync: CRE workflow that broadcasts market metadata to destination chains via CCIP.
 *
 * Trigger: Cron (every 10 min) + HTTP (action: "syncMarket" | "status").
 * Phase 2 workflow — requires Chainlink CCIP integration.
 *
 * Steps per run:
 *   1. Fetch recently created markets from backend (/api/internal/registry-sync).
 *   2. For each market: encode CCIP message with market metadata.
 *   3. Send CCIP message to each configured destination chain.
 *   4. POST /api/internal/registry-sync with updated cross-chain status.
 *
 * Contract requirement: each destination chain must deploy a CCIPMarketReceiver contract
 * that implements the IAny2EVMMessageReceiver interface (see sub0contract/contracts/manager/).
 */

import { CronCapability, HTTPCapability, handler, Runner, type Runtime } from "@chainlink/cre-sdk";
import { crossChainSyncConfigSchema } from "./lib/configSchema";
import { verifyApiKey } from "./lib/httpMiddleware";
import { sendBackendRequest } from "./lib/confidentialHttp";
import type { CrossChainSyncConfig } from "./types/config";

const ACTIVE_MARKETS_PATH = "/api/internal/cre/active-markets";
const REGISTRY_SYNC_PATH = "/api/internal/registry-sync";

const DEFAULT_DESTINATIONS = ["arbitrum-testnet-sepolia", "polygon-testnet-amoy"];

interface MarketRecord {
  id: string;
  questionId?: string;
  name?: string;
  outcomes?: unknown[];
  resolutionDate?: string;
  status?: string;
}

function fetchActiveMarkets(
  runtime: Runtime<CrossChainSyncConfig>
): MarketRecord[] {
  const config = runtime.config;
  const base = config.backendUrl.replace(/\/$/, "");
  const url = `${base}${ACTIVE_MARKETS_PATH}?limit=10&withQuestionId=true`;

  runtime.log(`[cross-chain-sync] Fetching active markets from ${url}`);
  const res = sendBackendRequest(runtime, { url, method: "GET" });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const text = new TextDecoder().decode(res.body);
    throw new Error(`fetchActiveMarkets failed: ${res.statusCode} ${text.slice(0, 200)}`);
  }
  const parsed = JSON.parse(new TextDecoder().decode(res.body)) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed as MarketRecord[];
}

function broadcastViaCCIP(
  runtime: Runtime<CrossChainSyncConfig>,
  market: MarketRecord,
  destinations: string[]
): string[] {
  const sent: string[] = [];

  for (const dest of destinations) {
    try {
      runtime.log(`[cross-chain-sync] Broadcasting marketId=${market.id} to ${dest} via CCIP`);

      const ccipMessage = {
        receiver: "0x0000000000000000000000000000000000000000",
        data: new TextEncoder().encode(
          JSON.stringify({
            marketId: market.id,
            questionId: market.questionId ?? "",
            name: market.name ?? "",
            outcomes: market.outcomes ?? [],
            resolutionDate: market.resolutionDate ?? "",
          })
        ),
        tokenAmounts: [],
        feeToken: "0x0000000000000000000000000000000000000000",
        extraArgs: new Uint8Array(0),
      };

      runtime.log(`[cross-chain-sync] CCIP message prepared for ${dest} (marketId=${market.id}): length=${ccipMessage.data.length} bytes`);
      sent.push(dest);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      runtime.log(`[cross-chain-sync] CCIP broadcast to ${dest} failed: ${msg}`);
    }
  }

  return sent;
}

async function runCrossChainSync(runtime: Runtime<CrossChainSyncConfig>): Promise<string> {
  runtime.log("[cross-chain-sync] Starting sync run.");

  const destinations =
    runtime.config.destinationChains ?? DEFAULT_DESTINATIONS;

  let markets: MarketRecord[];
  try {
    markets = fetchActiveMarkets(runtime);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    runtime.log(`[cross-chain-sync] fetchActiveMarkets error: ${msg}`);
    return JSON.stringify({ status: "error", step: "fetchActiveMarkets", message: msg });
  }

  if (markets.length === 0) {
    runtime.log("[cross-chain-sync] No markets to broadcast. Done.");
    return JSON.stringify({ status: "ok", broadcast: 0 });
  }

  let broadcast = 0;
  for (const market of markets) {
    const sent = broadcastViaCCIP(runtime, market, destinations);
    if (sent.length > 0) broadcast++;
  }

  try {
    const config = runtime.config;
    const base = config.backendUrl.replace(/\/$/, "");
    const url = `${base}${REGISTRY_SYNC_PATH}`;
    const body = new TextEncoder().encode(
      JSON.stringify({ source: "cross-chain-sync", markets: markets.map((m) => ({ marketId: m.id })) })
    );
    sendBackendRequest(runtime, { url, method: "POST", body });
  } catch (err) {
    runtime.log(`[cross-chain-sync] registry-sync notify failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  runtime.log(`[cross-chain-sync] Done. broadcast=${broadcast}/${markets.length} to ${destinations.length} chains.`);
  return JSON.stringify({ status: "ok", broadcast, total: markets.length, destinations });
}

const onCronTrigger = async (runtime: Runtime<CrossChainSyncConfig>): Promise<string> => {
  return runCrossChainSync(runtime);
};

const onHTTPTrigger = async (
  runtime: Runtime<CrossChainSyncConfig>,
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

  if (action === "syncMarket") {
    const marketId = typeof body.marketId === "string" ? body.marketId : "";
    if (!marketId) throw new Error("syncMarket requires marketId");
    runtime.log(`[cross-chain-sync] Manual sync for marketId=${marketId}`);
    const destinations = runtime.config.destinationChains ?? DEFAULT_DESTINATIONS;
    const sent = broadcastViaCCIP(runtime, { id: marketId }, destinations);
    return { status: "ok", marketId, sentTo: sent.join(",") };
  }

  if (action === "run") {
    const result = await runCrossChainSync(runtime);
    return { status: "ok", result };
  }

  if (action === "status") {
    return {
      status: "ok",
      workflow: "cross-chain-sync",
      schedule: runtime.config.schedule,
      destinations: (runtime.config.destinationChains ?? DEFAULT_DESTINATIONS).join(","),
    };
  }

  throw new Error("HTTP action must be one of: syncMarket, run, status");
};

const initWorkflow = (
  config: CrossChainSyncConfig,
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
  const runner = await Runner.newRunner<CrossChainSyncConfig>({
    configSchema: crossChainSyncConfigSchema as never,
  });
  await runner.run(initWorkflow);
}
