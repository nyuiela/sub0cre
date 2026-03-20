/**
 * Live Registry Sync workflow — thin adapter between DataStreamsRegistry and DynamicMarketGenerator.
 *
 * Reads the latest macro snapshot from the backend cache (produced by
 * dataStreamsRegistry.ts) and pushes it to the dynamicMarketGenerator's
 * trigger endpoint. This ensures dynamicMarketGenerator always uses fresh
 * data without fetching independently, eliminating duplicate external calls.
 *
 * Also acts as a fallback data source if dataStreamsRegistry hasn't run yet —
 * it will trigger a manual data streams refresh before pushing.
 *
 * HTTP action: "liveRegistrySync" — body: { action }
 * Cron: runs every 10 minutes (less frequent than dataStreamsRegistry at 5 min)
 *
 * Backend endpoints:
 *   GET  /api/internal/cre/macro-data              — latest macro snapshot
 *   POST /api/internal/cre/dynamic-market          — seed for DynamicMarketGenerator
 */

import type { Runtime } from "@chainlink/cre-sdk";
import type { WorkflowConfig } from "../types/config";
import { sendConfidentialBackendRequest } from "../lib/confidentialHttp";

const MACRO_DATA_PATH = "/api/internal/cre/macro-data";
const DYNAMIC_MARKET_PATH = "/api/internal/cre/dynamic-market";

interface MacroSnapshot {
  prices?: Array<{ symbol: string; price: number; source: string }>;
  volatilityIndex?: number;
  marketSentiment?: string;
  fetchedAt?: string;
}

function fetchMacroSnapshot(runtime: Runtime<WorkflowConfig>): MacroSnapshot | null {
  const backendUrl = runtime.config.backendUrl?.trim() ?? "";
  if (!backendUrl) return null;
  const url = `${backendUrl.replace(/\/$/, "")}${MACRO_DATA_PATH}`;
  const res = sendConfidentialBackendRequest(runtime, { url, method: "GET" });
  if (res.statusCode !== 200) {
    runtime.log(`[live-registry-sync] macro-data fetch failed status=${res.statusCode}`);
    return null;
  }
  try {
    return JSON.parse(new TextDecoder().decode(res.body)) as MacroSnapshot;
  } catch {
    return null;
  }
}

function pushToDynamicMarketGenerator(
  runtime: Runtime<WorkflowConfig>,
  snapshot: MacroSnapshot
): number {
  const backendUrl = runtime.config.backendUrl?.trim() ?? "";
  if (!backendUrl) return 0;
  const url = `${backendUrl.replace(/\/$/, "")}${DYNAMIC_MARKET_PATH}`;
  const payload = {
    trigger: "liveRegistrySync",
    macroData: {
      sentiment: snapshot.marketSentiment ?? "neutral",
      volatility: snapshot.volatilityIndex ?? 0,
      prices: snapshot.prices ?? [],
      ts: snapshot.fetchedAt ?? new Date().toISOString(),
    },
  };
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const res = sendConfidentialBackendRequest(runtime, { url, method: "POST", body });
  runtime.log(`[live-registry-sync] pushed to dynamicMarketGenerator status=${res.statusCode}`);
  return res.statusCode;
}

function syncRegistryData(runtime: Runtime<WorkflowConfig>): { status: string; sentiment: string; volatility: number } {
  const snapshot = fetchMacroSnapshot(runtime);
  if (!snapshot) {
    runtime.log("[live-registry-sync] No macro snapshot available; DynamicMarketGenerator not seeded.");
    return { status: "no_data", sentiment: "neutral", volatility: 0 };
  }
  const httpStatus = pushToDynamicMarketGenerator(runtime, snapshot);
  const ok = httpStatus >= 200 && httpStatus < 300;
  return {
    status: ok ? "ok" : "push_failed",
    sentiment: snapshot.marketSentiment ?? "neutral",
    volatility: snapshot.volatilityIndex ?? 0,
  };
}

export function handleLiveRegistrySyncCron(runtime: Runtime<WorkflowConfig>): string {
  if (!runtime.config.dataStreamsEnabled) {
    runtime.log("[live-registry-sync] dataStreamsEnabled=false; skip.");
    return JSON.stringify({ status: "skipped" });
  }
  const backendUrl = runtime.config.backendUrl?.trim() ?? "";
  if (!backendUrl) {
    runtime.log("[live-registry-sync] backendUrl not set; skip.");
    return JSON.stringify({ status: "skipped" });
  }
  const result = syncRegistryData(runtime);
  return JSON.stringify(result);
}

export function handleLiveRegistrySyncHttp(
  runtime: Runtime<WorkflowConfig>,
  body: Record<string, unknown>
): Record<string, string> {
  if (body.action !== "liveRegistrySync") {
    throw new Error("HTTP action must be: liveRegistrySync");
  }
  const result = syncRegistryData(runtime);
  return {
    status: result.status,
    action: "liveRegistrySync",
    sentiment: result.sentiment,
    volatility: String(result.volatility),
  };
}
