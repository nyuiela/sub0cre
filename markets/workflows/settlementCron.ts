/**
 * Settlement cron: fetch markets due for resolution from backend, run deliberation + writeReport + resolved for each.
 * Trigger: same cron as platform (schedule in config). Uses Confidential HTTP for backend (API key from vault).
 */

import type { Runtime } from "@chainlink/cre-sdk";
import type { WorkflowConfig } from "../types/config";
import { sendConfidentialBackendRequest } from "../lib/confidentialHttp";
import { handleRunSettlement } from "./runSettlement";

const SETTLEMENT_DUE_PATH = "/api/internal/settlement/due";
const DEFAULT_LIMIT = 10;

interface DueMarket {
  id: string;
  name: string;
  conditionId: string;
  resolutionDate: string;
  status: string;
  outcomes?: unknown;
  settlementRules?: string | null;
}

export async function handleSettlementCron(
  runtime: Runtime<WorkflowConfig>
): Promise<string> {
  const config = runtime.config;
  const backendUrl = config.backendUrl?.trim();
  if (!backendUrl) {
    runtime.log("Settlement cron: config.backendUrl not set; skip.");
    return "ok";
  }
  if (!config.contracts?.contracts?.agentSettlementReceiver) {
    runtime.log("Settlement cron: config.contracts.agentSettlementReceiver not set; skip.");
    return "ok";
  }

  const dueUrl = `${backendUrl.replace(/\/$/, "")}${SETTLEMENT_DUE_PATH}?limit=${DEFAULT_LIMIT}`;
  runtime.log("Settlement cron: fetching due markets (confidential HTTP).");

  const res = sendConfidentialBackendRequest(runtime, {
    url: dueUrl,
    method: "GET",
  });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    const bodyText = new TextDecoder().decode(res.body);
    runtime.log(`Settlement cron: due list failed ${res.statusCode} ${bodyText}`);
    return "ok";
  }

  let data: DueMarket[] = [];
  try {
    const parsed = JSON.parse(new TextDecoder().decode(res.body)) as {
      data?: DueMarket[];
    };
    data = Array.isArray(parsed?.data) ? parsed.data : [];
  } catch {
    runtime.log("Settlement cron: invalid JSON from due list.");
    return "ok";
  }

  if (data.length === 0) {
    runtime.log("Settlement cron: no markets due.");
    return "ok";
  }

  runtime.log(`Settlement cron: processing ${data.length} due market(s).`);
  let resolved = 0;
  let errors = 0;
  for (const m of data) {
    if (!m?.id || !m?.conditionId) continue;
    try {
      const payload = new TextEncoder().encode(
        JSON.stringify({ marketId: m.id, questionId: m.conditionId })
      );
      const result = await handleRunSettlement(runtime, { input: payload });
      if (result.canResolve === "true") resolved++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      runtime.log(`Settlement cron: failed for market ${m.id}: ${msg}`);
      errors++;
    }
  }
  runtime.log(`Settlement cron: done. resolved=${resolved}, errors=${errors}, total=${data.length}`);
  return "ok";
}
