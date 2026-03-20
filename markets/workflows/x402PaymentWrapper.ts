/**
 * x402 Payment Wrapper workflow — HTTP-triggered per-workflow payment step.
 *
 * When x402Enabled = true in config, this wrapper is called by other workflows
 * to charge a USDC micropayment per execution. It relays the charge to the
 * backend `/api/internal/cre/x402-charge` endpoint which handles the actual
 * x402 USDC deduction from the agent's balance.
 *
 * This creates an explicit agentic economy where every CRE workflow execution
 * has a real cost charged in USDC via x402 protocol.
 *
 * Config flags: x402Enabled (gates execution)
 *
 * HTTP action: "x402Pay" — body: { action, workflow, amount?, agentId? }
 *
 * Backend endpoints:
 *   POST /api/internal/cre/x402-charge    — process payment
 */

import type { Runtime } from "@chainlink/cre-sdk";
import type { WorkflowConfig } from "../types/config";
import { sendConfidentialBackendRequest } from "../lib/confidentialHttp";

const X402_CHARGE_PATH = "/api/internal/cre/x402-charge";

// Default costs per workflow type (USDC with 6 decimals)
const DEFAULT_WORKFLOW_COSTS: Record<string, string> = {
  marketDiscovery: "0.0001",
  agentAnalysis: "0.0001",
  settlementConsensus: "0.0002",
  agentEvolution: "0.0005",
  confidentialDebate: "0.0003",
  dataStreamsRefresh: "0.0001",
  aceCheck: "0.0001",
  default: "0.0001",
};

interface X402ChargeResult {
  workflow: string;
  amount: string;
  agentId: string | null;
  charged: boolean;
  receiptId: string;
  error?: string;
}

function resolveAmount(workflow: string, overrideAmount?: string): string {
  if (overrideAmount && parseFloat(overrideAmount) > 0) return overrideAmount;
  return DEFAULT_WORKFLOW_COSTS[workflow] ?? DEFAULT_WORKFLOW_COSTS.default ?? "0.0001";
}

function chargeX402(
  runtime: Runtime<WorkflowConfig>,
  workflow: string,
  amount: string,
  agentId: string | null
): X402ChargeResult {
  const backendUrl = runtime.config.backendUrl?.trim() ?? "";
  const receiptId = `x402-${workflow}-${Date.now().toString(16)}`;

  if (!backendUrl) {
    runtime.log(`[x402] backendUrl not set; charge skipped workflow=${workflow}`);
    return { workflow, amount, agentId, charged: false, receiptId, error: "no_backend_url" };
  }

  const url = `${backendUrl.replace(/\/$/, "")}${X402_CHARGE_PATH}`;
  const payload = { workflow, amount, agentId, receiptId, ts: new Date().toISOString() };
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const res = sendConfidentialBackendRequest(runtime, { url, method: "POST", body });

  const charged = res.statusCode >= 200 && res.statusCode < 300;
  runtime.log(`[x402] charge workflow=${workflow} amount=${amount} agentId=${agentId ?? "none"} status=${res.statusCode} receipt=${receiptId}`);

  return { workflow, amount, agentId, charged, receiptId };
}

export function handleX402PayHttp(
  runtime: Runtime<WorkflowConfig>,
  body: Record<string, unknown>
): Record<string, string> {
  if (body.action !== "x402Pay") {
    throw new Error("HTTP action must be: x402Pay");
  }
  if (!runtime.config.x402Enabled) {
    runtime.log("[x402] x402Enabled=false; charge skipped.");
    return { status: "skipped", reason: "x402_disabled" };
  }

  const workflow = typeof body.workflow === "string" ? body.workflow.trim() : "unknown";
  const overrideAmount = typeof body.amount === "string" ? body.amount.trim() : undefined;
  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : null;

  if (!workflow || workflow === "unknown") {
    throw new Error("x402Pay requires a workflow name");
  }

  const amount = resolveAmount(workflow, overrideAmount);
  const result = chargeX402(runtime, workflow, amount, agentId);

  return {
    status: result.charged ? "ok" : "failed",
    action: "x402Pay",
    workflow: result.workflow,
    amount: result.amount,
    agentId: result.agentId ?? "",
    charged: String(result.charged),
    receiptId: result.receiptId,
    error: result.error ?? "",
  };
}
