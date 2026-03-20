/**
 * Compliance guard workflow module for the markets CRE project.
 * ACE (Access Control & Entitlements) check: allows/denies wallet access to market features.
 *
 * Integrated into the markets CRE workflow as HTTP action "checkCompliance".
 * The standalone sub0cre/compliance-guard/ runs this as an independent CRE deployment.
 *
 * Checks performed:
 *   1. Backend ACE policy: POST /api/internal/compliance/check for geo + sanctions.
 *   2. Returns allow/deny decision with structured reason for the frontend.
 *
 * The CRE TEE ensures the compliance check cannot be tampered with by the backend operator
 * (the check result is cryptographically attested by the DON).
 *
 * Usage (HTTP action):
 *   POST <cre-gateway> { action: "checkCompliance", walletAddress: "0x...", marketId?: "...", tradeAction?: "..." }
 */

import type { Runtime } from "@chainlink/cre-sdk";
import type { WorkflowConfig } from "../types/config";
import { sendConfidentialBackendRequest } from "../lib/confidentialHttp";

const COMPLIANCE_CHECK_PATH = "/api/internal/compliance/check";

const BLOCKED_COUNTRIES_DEFAULT = ["KP", "IR", "SY", "CU"];

interface ComplianceCheckResult {
  allowed: boolean;
  reason: string;
  walletAddress: string;
  tradeAction?: string;
  marketId?: string;
}

interface BackendPolicyResponse {
  allowed?: boolean;
  reason?: string;
  blockedCountry?: string;
  sanctioned?: boolean;
}

function checkBackendAcePolicy(
  runtime: Runtime<WorkflowConfig>,
  walletAddress: string,
  tradeAction?: string,
  marketId?: string
): { allowed: boolean; reason: string } {
  const config = runtime.config;
  const backendUrl = config.backendUrl?.trim() ?? "";
  if (!backendUrl) {
    return { allowed: true, reason: "backend_policy_unavailable" };
  }

  const url = `${backendUrl.replace(/\/$/, "")}${COMPLIANCE_CHECK_PATH}`;
  const reqBody = new TextEncoder().encode(
    JSON.stringify({
      walletAddress,
      action: tradeAction ?? "trade",
      marketId: marketId ?? null,
    })
  );

  runtime.log(
    `[compliance-guard] ACE policy check for wallet=${walletAddress} action=${tradeAction ?? "trade"}`
  );
  const res = sendConfidentialBackendRequest(runtime, {
    url,
    method: "POST",
    body: reqBody,
  });

  if (res.statusCode === 200 || res.statusCode === 403) {
    try {
      const parsed = JSON.parse(
        new TextDecoder().decode(res.body)
      ) as BackendPolicyResponse;
      return {
        allowed: Boolean(parsed.allowed ?? res.statusCode === 200),
        reason: typeof parsed.reason === "string" ? parsed.reason : "backend_policy",
      };
    } catch {
      return { allowed: res.statusCode === 200, reason: "backend_policy_parse_error" };
    }
  }

  runtime.log(
    `[compliance-guard] ACE policy endpoint returned ${res.statusCode}; defaulting to allow.`
  );
  return { allowed: true, reason: "backend_policy_unavailable" };
}

function runComplianceCheck(
  runtime: Runtime<WorkflowConfig>,
  walletAddress: string,
  tradeAction?: string,
  marketId?: string
): ComplianceCheckResult {
  if (!walletAddress?.trim().startsWith("0x")) {
    return {
      allowed: false,
      reason: "invalid_wallet_address",
      walletAddress,
      tradeAction,
      marketId,
    };
  }

  const { allowed, reason } = checkBackendAcePolicy(
    runtime,
    walletAddress,
    tradeAction,
    marketId
  );

  // Record compliance event on-chain via backend relay when aceComplianceMode is enabled
  const { aceComplianceMode, backendUrl: cfgBackendUrl } = runtime.config;
  if (aceComplianceMode) {
    const recordUrl = `${(cfgBackendUrl ?? "").replace(/\/$/, "")}/api/internal/cre/registry-record`;
    const recordBody = new TextEncoder().encode(
      JSON.stringify({ event: "compliance", wallet: walletAddress, allowed, reason })
    );
    sendConfidentialBackendRequest(runtime, { url: recordUrl, method: "POST", body: recordBody });
    runtime.log(`[compliance-guard] on-chain record dispatched for wallet=${walletAddress} allowed=${allowed}`);
  }

  return { allowed, reason, walletAddress, tradeAction, marketId };
}

export function handleComplianceGuardHttp(
  runtime: Runtime<WorkflowConfig>,
  body: Record<string, unknown>
): Record<string, string> {
  if (body.action !== "checkCompliance") {
    throw new Error("HTTP action must be: checkCompliance");
  }

  const walletAddress = typeof body.walletAddress === "string" ? body.walletAddress : "";
  if (!walletAddress) throw new Error("checkCompliance requires walletAddress");

  const tradeAction = typeof body.tradeAction === "string" ? body.tradeAction : undefined;
  const marketId = typeof body.marketId === "string" ? body.marketId : undefined;

  const result = runComplianceCheck(runtime, walletAddress, tradeAction, marketId);

  return {
    status: "ok",
    action: "checkCompliance",
    allowed: String(result.allowed),
    reason: result.reason,
    walletAddress: result.walletAddress,
    ...(result.tradeAction != null ? { tradeAction: result.tradeAction } : {}),
    ...(result.marketId != null ? { marketId: result.marketId } : {}),
  };
}

export function getDefaultBlockedCountries(): string[] {
  return [...BLOCKED_COUNTRIES_DEFAULT];
}
