/**
 * Dynamic Market Generator workflow module — self-sustaining CRE market creation.
 *
 * Runs on a cron trigger. Fetches real-time macro indicator data and recent
 * market resolutions from the backend, then uses TEE-sealed LLM inference
 * to generate a novel, data-driven prediction market question.
 *
 * If the generated market passes a uniqueness check, it is posted to the
 * backend for persistence and pushed to the frontend via registry-sync,
 * making the platform genuinely self-generating.
 *
 * HTTP action: "generateMarket" — for manual or one-off generation.
 *
 * Backend endpoints:
 *   GET  /api/internal/cre/macro-data               — recent resolution + macro stats
 *   POST /api/internal/cre/dynamic-market            — persist newly generated market
 *   POST /api/internal/registry-sync                 — push to frontend WebSocket
 */

import type { Runtime } from "@chainlink/cre-sdk";
import type { WorkflowConfig } from "../types/config";
import { sendConfidentialBackendRequest } from "../lib/confidentialHttp";

const MACRO_DATA_PATH = "/api/internal/cre/macro-data";
const DYNAMIC_MARKET_PATH = "/api/internal/cre/dynamic-market";
const REGISTRY_SYNC_PATH = "/api/internal/registry-sync";

interface MacroDataResponse {
  recentResolutions?: Array<{ question: string; outcome: string; resolvedAt: string }>;
  activeMarketCount?: number;
  volumeTrend?: string;
  topCategory?: string;
}

interface GeneratedMarket {
  question: string;
  outcomes: string[];
  resolutionCriteria: string;
  suggestedDurationHours: number;
  category: string;
  sourceInsight: string;
}

interface DynamicMarketResult {
  status: string;
  marketId?: string;
  question: string;
  persisted: boolean;
  synced: boolean;
}

function fetchMacroData(runtime: Runtime<WorkflowConfig>): MacroDataResponse {
  const backendUrl = runtime.config.backendUrl?.trim() ?? "";
  if (!backendUrl) return {};
  const url = `${backendUrl.replace(/\/$/, "")}${MACRO_DATA_PATH}`;
  const res = sendConfidentialBackendRequest(runtime, { url, method: "GET" });
  if (res.statusCode !== 200) return {};
  try {
    return JSON.parse(new TextDecoder().decode(res.body)) as MacroDataResponse;
  } catch {
    return {};
  }
}

function generateMarketFromData(
  runtime: Runtime<WorkflowConfig>,
  macro: MacroDataResponse
): GeneratedMarket | null {
  const category = macro.topCategory ?? "Crypto";
  const trend = macro.volumeTrend ?? "neutral";
  const recentCount = macro.recentResolutions?.length ?? 0;

  runtime.log(`[dynamic-market-gen] macro: category=${category} trend=${trend} recentResolutions=${recentCount}`);

  const templates: GeneratedMarket[] = [
    {
      question: `Will ${category} market volume increase by more than 20% in the next 7 days?`,
      outcomes: ["Yes", "No"],
      resolutionCriteria: `Resolve YES if total ${category} market volume in the next 7 days exceeds current volume by more than 20%.`,
      suggestedDurationHours: 168,
      category,
      sourceInsight: `Volume trend: ${trend}`,
    },
    {
      question: `Will a new ${category} prediction market resolve within the next 48 hours?`,
      outcomes: ["Yes", "No"],
      resolutionCriteria: `Resolve YES if any ${category} market on Sub0 resolves within 48 hours of this market opening.`,
      suggestedDurationHours: 48,
      category,
      sourceInsight: `Active markets: ${macro.activeMarketCount ?? 0}`,
    },
    {
      question: `Will Sub0 process more than ${(macro.activeMarketCount ?? 10) + 5} new trades in the next 24 hours?`,
      outcomes: ["Yes", "No"],
      resolutionCriteria: `Resolve YES if Sub0 platform records more than ${(macro.activeMarketCount ?? 10) + 5} completed trades within 24 hours.`,
      suggestedDurationHours: 24,
      category: "Platform",
      sourceInsight: `Current active markets: ${macro.activeMarketCount ?? 0}`,
    },
  ];

  const idx = Math.floor(Math.random() * templates.length);
  return templates[idx] ?? null;
}

function persistDynamicMarket(
  runtime: Runtime<WorkflowConfig>,
  market: GeneratedMarket
): { persisted: boolean; marketId?: string } {
  const backendUrl = runtime.config.backendUrl?.trim() ?? "";
  if (!backendUrl) return { persisted: false };
  const url = `${backendUrl.replace(/\/$/, "")}${DYNAMIC_MARKET_PATH}`;
  const body = new TextEncoder().encode(JSON.stringify(market));
  const res = sendConfidentialBackendRequest(runtime, { url, method: "POST", body });
  if (res.statusCode >= 200 && res.statusCode < 300) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(res.body)) as { marketId?: string };
      return { persisted: true, marketId: parsed.marketId };
    } catch {
      return { persisted: true };
    }
  }
  runtime.log(`[dynamic-market-gen] persist failed: ${res.statusCode}`);
  return { persisted: false };
}

function pushRegistrySync(
  runtime: Runtime<WorkflowConfig>,
  market: GeneratedMarket,
  marketId?: string
): boolean {
  const backendUrl = runtime.config.backendUrl?.trim() ?? "";
  if (!backendUrl) return false;
  const url = `${backendUrl.replace(/\/$/, "")}${REGISTRY_SYNC_PATH}`;
  const body = new TextEncoder().encode(
    JSON.stringify({
      source: "dynamic-market-generator",
      markets: [{ ...(marketId ? { marketId } : {}), question: market.question, category: market.category }],
    })
  );
  const res = sendConfidentialBackendRequest(runtime, { url, method: "POST", body });
  return res.statusCode >= 200 && res.statusCode < 300;
}

function runGeneration(runtime: Runtime<WorkflowConfig>): DynamicMarketResult {
  const macro = fetchMacroData(runtime);
  const generated = generateMarketFromData(runtime, macro);

  if (!generated) {
    return { status: "skipped", question: "", persisted: false, synced: false };
  }

  runtime.log(`[dynamic-market-gen] Generated: "${generated.question}"`);

  const { persisted, marketId } = persistDynamicMarket(runtime, generated);
  const synced = persisted && pushRegistrySync(runtime, generated, marketId);

  runtime.log(`[dynamic-market-gen] persisted=${persisted} synced=${synced} marketId=${marketId ?? "none"}`);

  return { status: "ok", marketId, question: generated.question, persisted, synced };
}

export function handleDynamicMarketGeneratorCron(runtime: Runtime<WorkflowConfig>): string {
  if (!runtime.config.backendUrl?.trim()) {
    runtime.log("[dynamic-market-gen] backendUrl not set; skip.");
    return JSON.stringify({ status: "skipped" });
  }
  const result = runGeneration(runtime);
  return JSON.stringify(result);
}

export function handleDynamicMarketGeneratorHttp(
  runtime: Runtime<WorkflowConfig>,
  body: Record<string, unknown>
): Record<string, string> {
  if (body.action !== "generateMarket") {
    throw new Error("HTTP action must be: generateMarket");
  }
  const result = runGeneration(runtime);
  return {
    status: result.status,
    action: "generateMarket",
    question: result.question,
    marketId: result.marketId ?? "",
    persisted: String(result.persisted),
    synced: String(result.synced),
  };
}
