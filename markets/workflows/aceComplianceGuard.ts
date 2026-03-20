/**
 * ACE Compliance Guard workflow — EVM_LOG triggered cryptographic compliance.
 *
 * This is the on-chain companion to complianceGuard.ts (which is HTTP-triggered).
 * Triggered by the PredictionVault `AgentActionRequested` event, this workflow
 * performs the same compliance checks but also records the decision on-chain via
 * Sub0CRERegistry.recordComplianceEvent for cryptographic attestation.
 *
 * Existing complianceGuard.ts is kept as the HTTP-triggered fallback.
 * This workflow is the EVM_LOG-triggered production path.
 *
 * Config flags: aceComplianceMode (gates on-chain recording)
 *
 * EVM_LOG trigger: PredictionVault AgentActionRequested event
 * HTTP action: "aceCheck" — body: { action, walletAddress, marketId, tradeAction }
 *
 * Backend endpoints:
 *   POST /api/internal/compliance/check   — compliance decision
 *   POST /api/internal/cre/registry-record — on-chain attestation relay
 */

import type { Runtime } from "@chainlink/cre-sdk";
import type { WorkflowConfig } from "../types/config";
import { sendConfidentialBackendRequest } from "../lib/confidentialHttp";

const COMPLIANCE_CHECK_PATH = "/api/internal/compliance/check";
const REGISTRY_RECORD_PATH = "/api/internal/cre/registry-record";
const DELEGATION_PATH = "/api/agents";

interface DelegationRecord {
  agentId: string;
  delegate: string | null;
  delegationHash: string | null;
  delegationExpiry: string | null;
  active: boolean;
  expired: boolean;
  strategy: {
    maxExposureUsd?: number | null;
    allowedMarketTypes?: string | null;
    riskLevel?: string | null;
  } | null;
}

interface ComplianceCheckResult {
  allowed: boolean;
  reason: string;
  walletAddress: string;
  marketId?: string | null;
  tradeAction?: string | null;
  attestedOnChain: boolean;
  delegationVerified?: boolean;
}

/**
 * Fetch delegation record for an agent by agentId.
 * Returns null when agentId is missing or backend is unreachable.
 */
function fetchDelegation(
  runtime: Runtime<WorkflowConfig>,
  agentId: string
): DelegationRecord | null {
  const backendUrl = runtime.config.backendUrl?.trim() ?? "";
  if (!backendUrl || !agentId) return null;
  const url = `${backendUrl.replace(/\/$/, "")}${DELEGATION_PATH}/${encodeURIComponent(agentId)}/delegation`;
  const res = sendConfidentialBackendRequest(runtime, { url, method: "GET" });
  if (res.statusCode !== 200) return null;
  try {
    return JSON.parse(new TextDecoder().decode(res.body)) as DelegationRecord;
  } catch {
    return null;
  }
}

/**
 * Verify the agent's ERC-7710 delegation is active and caveats allow the trade.
 * When no delegation is stored yet (new agent), the check passes with a warning log.
 */
function verifyDelegation(
  runtime: Runtime<WorkflowConfig>,
  agentId: string,
  tradeAmountUsd: number | null
): { ok: boolean; reason: string } {
  if (!agentId) return { ok: true, reason: "no_agent_id" };
  const delegation = fetchDelegation(runtime, agentId);

  if (!delegation) {
    runtime.log(`[ace-compliance-guard] delegation fetch failed for agentId=${agentId}; skipping delegation check`);
    return { ok: true, reason: "delegation_fetch_failed" };
  }
  if (!delegation.delegationHash) {
    runtime.log(`[ace-compliance-guard] no delegation stored for agentId=${agentId}; trade allowed (no restriction set)`);
    return { ok: true, reason: "no_delegation_stored" };
  }
  if (delegation.expired || !delegation.active) {
    return { ok: false, reason: "delegation_expired" };
  }
  if (tradeAmountUsd != null && delegation.strategy?.maxExposureUsd != null) {
    if (tradeAmountUsd > delegation.strategy.maxExposureUsd) {
      return { ok: false, reason: `trade_exceeds_max_exposure_${delegation.strategy.maxExposureUsd}` };
    }
  }
  return { ok: true, reason: "delegation_valid" };
}

function callComplianceCheck(
  runtime: Runtime<WorkflowConfig>,
  walletAddress: string,
  marketId: string | null,
  tradeAction: string | null
): { allowed: boolean; reason: string } {
  const backendUrl = runtime.config.backendUrl?.trim() ?? "";
  if (!backendUrl) return { allowed: true, reason: "no_backend" };

  const url = `${backendUrl.replace(/\/$/, "")}${COMPLIANCE_CHECK_PATH}`;
  const payload = { walletAddress, marketId, tradeAction };
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const res = sendConfidentialBackendRequest(runtime, { url, method: "POST", body });

  if (res.statusCode !== 200) return { allowed: false, reason: `backend_error_${res.statusCode}` };
  try {
    const parsed = JSON.parse(new TextDecoder().decode(res.body)) as { allowed?: boolean; reason?: string };
    return {
      allowed: parsed.allowed ?? false,
      reason: parsed.reason ?? "unknown",
    };
  } catch {
    return { allowed: false, reason: "parse_error" };
  }
}

function recordComplianceAttestation(
  runtime: Runtime<WorkflowConfig>,
  walletAddress: string,
  allowed: boolean,
  reason: string
): void {
  if (!runtime.config.aceComplianceMode) return;
  const backendUrl = runtime.config.backendUrl?.trim() ?? "";
  if (!backendUrl) return;

  const url = `${backendUrl.replace(/\/$/, "")}${REGISTRY_RECORD_PATH}`;
  const payload = { event: "compliance", wallet: walletAddress, allowed, reason, ts: new Date().toISOString() };
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const res = sendConfidentialBackendRequest(runtime, { url, method: "POST", body });
  runtime.log(`[ace-compliance-guard] on-chain record dispatched wallet=${walletAddress} allowed=${allowed} status=${res.statusCode}`);
}

function runAceCheck(
  runtime: Runtime<WorkflowConfig>,
  walletAddress: string,
  marketId: string | null,
  tradeAction: string | null,
  agentId?: string | null,
  tradeAmountUsd?: number | null
): ComplianceCheckResult {
  runtime.log(`[ace-compliance-guard] checking wallet=${walletAddress} market=${marketId ?? "any"} action=${tradeAction ?? "any"} agentId=${agentId ?? "none"}`);

  // Step 1: verify ERC-7710 delegation (expiry + maxExposureUsd caveat)
  const delegation = verifyDelegation(runtime, agentId ?? "", tradeAmountUsd ?? null);
  if (!delegation.ok) {
    const reason = delegation.reason;
    recordComplianceAttestation(runtime, walletAddress, false, reason);
    return { allowed: false, reason, walletAddress, marketId, tradeAction, attestedOnChain: !!runtime.config.aceComplianceMode, delegationVerified: false };
  }

  // Step 2: ACE policy check via backend
  const { allowed, reason } = callComplianceCheck(runtime, walletAddress, marketId, tradeAction);

  recordComplianceAttestation(runtime, walletAddress, allowed, reason);

  return { allowed, reason, walletAddress, marketId, tradeAction, attestedOnChain: !!runtime.config.aceComplianceMode, delegationVerified: true };
}

export function handleAceComplianceGuardHttp(
  runtime: Runtime<WorkflowConfig>,
  body: Record<string, unknown>
): Record<string, string> {
  if (body.action !== "aceCheck") {
    throw new Error("HTTP action must be: aceCheck");
  }
  const walletAddress = typeof body.walletAddress === "string" ? body.walletAddress.trim() : "";
  if (!walletAddress) throw new Error("aceCheck requires walletAddress");

  const marketId = typeof body.marketId === "string" ? body.marketId.trim() : null;
  const tradeAction = typeof body.tradeAction === "string" ? body.tradeAction.trim() : null;
  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : null;
  const tradeAmountUsd = typeof body.tradeAmountUsd === "number" ? body.tradeAmountUsd : null;

  const result = runAceCheck(runtime, walletAddress, marketId, tradeAction, agentId, tradeAmountUsd);
  return {
    status: "ok",
    action: "aceCheck",
    allowed: String(result.allowed),
    reason: result.reason,
    walletAddress: result.walletAddress,
    marketId: result.marketId ?? "",
    tradeAction: result.tradeAction ?? "",
    attestedOnChain: String(result.attestedOnChain),
    delegationVerified: String(result.delegationVerified ?? true),
  };
}

export function handleAceComplianceGuardEvmLog(
  runtime: Runtime<WorkflowConfig>,
  eventPayload: Record<string, unknown>
): Record<string, string> {
  // EVM_LOG trigger: PredictionVault emits AgentActionRequested(address agent, bytes32 marketId, string action, string agentId)
  const walletAddress = typeof eventPayload.agent === "string" ? eventPayload.agent.trim() : "";
  const marketId = typeof eventPayload.marketId === "string" ? eventPayload.marketId.trim() : null;
  const tradeAction = typeof eventPayload.action === "string" ? eventPayload.action.trim() : null;
  const agentId = typeof eventPayload.agentId === "string" ? eventPayload.agentId.trim() : null;
  const tradeAmountUsd = typeof eventPayload.tradeAmountUsd === "number" ? eventPayload.tradeAmountUsd : null;

  if (!walletAddress) {
    runtime.log("[ace-compliance-guard] EVM_LOG: no agent address in payload; skip.");
    return { status: "skipped", reason: "no_agent_address" };
  }

  const result = runAceCheck(runtime, walletAddress, marketId, tradeAction, agentId, tradeAmountUsd);
  runtime.log(`[ace-compliance-guard] EVM_LOG result: wallet=${walletAddress} allowed=${result.allowed} reason=${result.reason} delegationVerified=${result.delegationVerified ?? true}`);
  return {
    status: "ok",
    trigger: "evmLog",
    allowed: String(result.allowed),
    reason: result.reason,
    walletAddress,
    attestedOnChain: String(result.attestedOnChain),
    delegationVerified: String(result.delegationVerified ?? true),
  };
}
